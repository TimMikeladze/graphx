/**
 * Load (or reload) every scraped show into graphx.
 *
 *   bun run load.ts [--embedder hash|ollama|openai] [--db ./podcasts]
 *
 * Reads `data/<podcast>/episodes.json` for each show in `podcasts/` that has been scraped.
 * Idempotent, so it can run after every scrape. It reads what the graph holds now, matches each
 * planned node to its live one by natural key (podcast key, podcast + episode slug,
 * person/topic/sponsor key), and writes only the difference:
 *
 *   new nodes / edges   → bulkLoad / bulkEdges, valid from the episode that introduced them
 *   changed nodes       → Graph.updateNode (a new version from now; the old one stays in history)
 *   gone nodes / edges  → Graph.deleteNode / deleteEdge (closed, not erased)
 *
 * New rows carry the episode's publish date as `valid_from`, so even rows written today read as of
 * the day they became true: `asOf(2020-01-01)` shows the shows as they stood then.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bulkEdges, bulkLoad, type DbClient, type Embedder, getDb, Graph, init } from 'graphx';
import { type Plan, type PlanNode, planEpisodes, Episodes } from './dataset.ts';
import { embedderFor, NAMESPACE, podcastSchema } from './graphx.config.ts';
import type { Episode } from './parse.ts';
import { PODCASTS } from './podcasts/index.ts';
import { episodesFile } from './scrape.ts';

export interface SyncStats {
	nodes: Record<'inserted' | 'updated' | 'retracted' | 'unchanged', number>;
	edges: Record<'inserted' | 'retracted' | 'unchanged', number>;
	/** Node counts by type in the plan. */
	types: Record<string, number>;
	/** Planned edges by rel. */
	rels: Record<string, number>;
	startedAt: number;
	finishedAt: number;
}

/** Key order is irrelevant to whether data changed; `undefined` fields are absent once stored. */
function canonical(v: unknown): string {
	return JSON.stringify(v, (_k, x) =>
		x && typeof x === 'object' && !Array.isArray(x)
			? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
			: x,
	);
}

interface Live {
	id: string;
	type: string;
	data: Record<string, unknown>;
	body: string | null;
}

/** Natural key of a live node — the inverse of `PlanNode.key`. */
function keyOf(n: Live): string {
	if (n.type === 'dataset') return 'dataset';
	if (n.type === 'episode') return `episode:${String(n.data.podcast)}/${String(n.data.slug)}`;
	return `${n.type}:${String(n.data.key)}`;
}

/** Bring the graph in line with `plan`. Safe to repeat: a second run over the same scrape writes nothing. */
export async function syncPlan(
	db: DbClient,
	plan: Plan,
	opts: { embedder: Embedder; log?: (msg: string) => void },
): Promise<SyncStats> {
	const log = opts.log ?? (() => {});
	const startedAt = Date.now();
	const g = new Graph(db, podcastSchema, { embedder: opts.embedder });

	// --- what the graph holds now ----------------------------------------------------------------
	const live = (await db.execute('SELECT id, type, data, body FROM nodes')).rows.map<Live>((r) => ({
		id: String(r.id),
		type: String(r.type),
		data: JSON.parse(String(r.data)),
		body: r.body === null ? null : String(r.body),
	}));
	const byKey = new Map(live.map((n) => [keyOf(n), n]));

	// --- match plan nodes to live ones -----------------------------------------------------------
	const idOf = new Map<string, string>(); // plan key → node id
	const inserts: PlanNode[] = [];
	const updates: Array<{ node: PlanNode; id: string }> = [];
	let unchanged = 0;
	for (const node of plan.nodes) {
		const hit = byKey.get(node.key);
		if (!hit || hit.type !== node.type) {
			inserts.push(node);
			continue;
		}
		idOf.set(node.key, hit.id);
		const data = podcastSchema.nodes[node.type].parse(node.data);
		if (canonical(data) === canonical(hit.data) && (node.body ?? null) === hit.body) unchanged++;
		else updates.push({ node, id: hit.id });
	}
	const claimed = new Set(idOf.values());
	const retracted = live.filter((n) => !claimed.has(n.id));

	// --- write nodes: retract first, so nothing new ever points at a closing node ---------------
	for (const n of retracted) await g.deleteNode(n.id);
	// The dataset node goes last, so its version brackets the run.
	for (const { node, id } of updates) {
		if (node.type !== 'dataset')
			await g.updateNode(id, { data: node.data, body: node.body ?? null });
	}
	if (inserts.length) {
		const t = performance.now();
		const { ids } = await bulkLoad(
			db,
			podcastSchema,
			inserts.map((n) => ({ type: n.type, data: n.data, body: n.body, validFrom: n.validFrom })),
			{ embedder: opts.embedder, chunkSize: 200, loadTs: startedAt },
		);
		inserts.forEach((n, i) => idOf.set(n.key, ids[i] as string));
		log(`  bulkLoad ${inserts.length} nodes in ${((performance.now() - t) / 1000).toFixed(1)}s`);
	}

	// --- edges: diffed by (rel, src, dst) against what is live ------------------------------------
	const liveEdges = (await db.execute('SELECT id, rel, src, dst, data FROM edges')).rows.map(
		(r) => ({
			id: String(r.id),
			key: `${String(r.rel)}|${String(r.src)}|${String(r.dst)}`,
			data: r.data === null ? '{}' : String(r.data),
		}),
	);
	const liveByKey = new Map(liveEdges.map((e) => [e.key, e]));
	const wanted = plan.edges.map((e) => {
		const src = idOf.get(e.src) as string;
		const dst = idOf.get(e.dst) as string;
		return { ...e, src, dst, key: `${e.rel}|${src}|${dst}` };
	});
	const wantedKeys = new Set(wanted.map((e) => e.key));
	// An edge whose data changed (a mention moved chapters) is closed and reopened.
	const newEdges = wanted.filter((e) => {
		const hit = liveByKey.get(e.key);
		return !hit || canonical(JSON.parse(hit.data)) !== canonical(e.data ?? {});
	});
	const newKeys = new Set(newEdges.map((e) => e.key));
	const goneEdges = liveEdges.filter((e) => !wantedKeys.has(e.key) || newKeys.has(e.key));

	log(
		`nodes: ${inserts.length} new, ${updates.length} changed, ${retracted.length} gone, ${unchanged} unchanged; ` +
			`edges: ${newEdges.length} new, ${goneEdges.length} gone`,
	);
	for (const e of goneEdges) await g.deleteEdge(e.id);
	if (newEdges.length) {
		const types = new Map<string, string>();
		for (const n of plan.nodes) types.set(idOf.get(n.key) as string, n.type);
		// A reopened edge cannot start before the edge it replaces closed.
		const reopened = new Set(goneEdges.map((e) => e.key));
		await bulkEdges(
			db,
			podcastSchema,
			newEdges.map((e) => ({
				rel: e.rel,
				src: e.src,
				dst: e.dst,
				data: e.data,
				validFrom: reopened.has(e.key) ? Date.now() : e.validFrom,
			})),
			{ types, chunkSize: 200, loadTs: startedAt },
		);
	}

	const dataset = updates.find((u) => u.node.type === 'dataset');
	if (dataset) {
		await g.updateNode(dataset.id, { data: dataset.node.data, body: dataset.node.body ?? null });
	}

	const count = <T>(xs: T[], f: (x: T) => string) =>
		xs.reduce<Record<string, number>>((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
	return {
		nodes: {
			inserted: inserts.length,
			updated: updates.length,
			retracted: retracted.length,
			unchanged,
		},
		edges: {
			inserted: newEdges.length,
			retracted: goneEdges.length,
			unchanged: wanted.length - newEdges.length,
		},
		types: count(plan.nodes, (n) => n.type),
		rels: count(plan.edges, (e) => e.rel),
		startedAt,
		finishedAt: Date.now(),
	};
}

/** Every scraped show's episodes, one list. Shows not scraped yet are skipped. */
export async function readEpisodes(): Promise<Episode[]> {
	const all: Episode[] = [];
	for (const p of PODCASTS) {
		const file = episodesFile(p.key);
		if (existsSync(file)) all.push(...Episodes.parse(await Bun.file(file).json()));
	}
	return all;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			embedder: { type: 'string' },
			db: { type: 'string', default: join(import.meta.dir, NAMESPACE) },
		},
	});
	const t0 = performance.now();
	const episodes = await readEpisodes();
	const plan = planEpisodes(episodes);

	const embedder = embedderFor(values.embedder);
	const db = getDb(values.db as string);
	await init(db, embedder);
	const stats = await syncPlan(db, plan, { embedder, log: (m) => console.log(m) });

	const fmt = (r: Record<string, number>) =>
		Object.entries(r)
			.map(([k, v]) => `${k} ${v.toLocaleString()}`)
			.join(', ');
	console.log(`episodes ${episodes.length}`);
	console.log(`nodes   ${fmt(stats.types)}`);
	console.log(`edges   ${fmt(stats.rels)}`);
	console.log(`written nodes ${fmt(stats.nodes)}`);
	console.log(`written edges ${fmt(stats.edges)}`);
	console.log(
		`embedder ${embedder.id}, db ${values.db}.db — ${((performance.now() - t0) / 1000).toFixed(1)}s`,
	);
	db.close();
}
