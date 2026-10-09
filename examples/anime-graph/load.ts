/**
 * Load (or reload) an anime-offline-database release into graphx.
 *
 *   bun run load.ts [--file data/anime-offline-database-minified.json] [--embedder hash|ollama|openai]
 *
 * Idempotent, so it can run on every weekly release. It reads what the graph holds now, matches
 * each entry to its existing node (by identity url first, then by any shared source url — so an
 * entry that gains a MAL link keeps its node), and writes only the difference:
 *
 *   new nodes / edges   → bulkLoad / bulkEdges (one batched insert, embedding batched)
 *   changed nodes       → Graph.updateNode (a new version; the old one stays in history)
 *   gone nodes / edges  → Graph.deleteNode / deleteEdge (closed, not erased)
 *
 * A first load is all inserts. Because every change is a version, `diff(db, t1, t2)` between two
 * runs is exactly what the release changed — `queries.ts` prints it.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bulkEdges, bulkLoad, type DbClient, type Embedder, getDb, Graph, init } from 'graphx';
import { createPgClient } from 'graphx/pg';
import { animeSchema, embedderFor, NAMESPACE } from './graphx.config.ts';
import { type Plan, type PlanNode, planRelease, Release, RELEASE_FILE } from './dataset.ts';

export interface SyncStats {
	nodes: Record<'inserted' | 'updated' | 'retracted' | 'unchanged', number>;
	edges: Record<'inserted' | 'retracted' | 'unchanged', number>;
	/** Node counts by type in the plan. */
	types: Record<string, number>;
	/** Planned edges by rel. */
	rels: Record<string, number>;
	unresolved: Plan['unresolved'];
	/** When this run's writes happened — the `t2` of a diff against the previous run. */
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
	if (n.type === 'anime') return `anime:${String(n.data.key)}`;
	return `${n.type}:${String(n.data.name)}`;
}

/**
 * Bring the graph in line with `plan`. Safe to repeat: a second run over the same release writes
 * nothing.
 */
export async function syncPlan(
	db: DbClient,
	plan: Plan,
	opts: {
		embedder: Embedder;
		chunkSize?: number;
		/** Inserts below this go through addNode instead of bulkLoad (default 2000). */
		bulkThreshold?: number;
		log?: (msg: string) => void;
	},
): Promise<SyncStats> {
	const log = opts.log ?? (() => {});
	const startedAt = Date.now();
	const g = new Graph(db, animeSchema, { embedder: opts.embedder });

	// --- what the graph holds now ----------------------------------------------------------------
	const live = (await db.execute('SELECT id, type, data, body FROM nodes')).rows.map<Live>((r) => ({
		id: String(r.id),
		type: String(r.type),
		data: JSON.parse(String(r.data)),
		body: r.body === null ? null : String(r.body),
	}));
	const byKey = new Map<string, Live>();
	const animeBySource = new Map<string, Live>();
	for (const n of live) {
		byKey.set(keyOf(n), n);
		if (n.type === 'anime') {
			for (const s of (n.data.sources as string[] | undefined) ?? []) animeBySource.set(s, n);
		}
	}

	// --- match plan nodes to live ones -----------------------------------------------------------
	const claimed = new Set<string>();
	const idOf = new Map<string, string>(); // plan key → node id
	const inserts: PlanNode[] = [];
	const updates: Array<{ node: PlanNode; id: string }> = [];
	let unchanged = 0;

	const match = (node: PlanNode): Live | undefined => {
		const exact = byKey.get(node.key);
		if (exact && !claimed.has(exact.id) && exact.type === node.type) return exact;
		// The identity url moved (an entry gained a MAL link, or two entries merged): fall back to
		// any source url the live node already had.
		for (const s of node.sources ?? []) {
			const hit = animeBySource.get(s);
			if (hit && !claimed.has(hit.id)) return hit;
		}
		return undefined;
	};

	for (const node of plan.nodes) {
		const hit = match(node);
		if (!hit) {
			inserts.push(node); // its id comes back from bulkLoad
			continue;
		}
		claimed.add(hit.id);
		idOf.set(node.key, hit.id);
		const data = animeSchema.nodes[node.type].parse(node.data);
		if (canonical(data) === canonical(hit.data) && (node.body ?? null) === hit.body) unchanged++;
		else updates.push({ node, id: hit.id });
	}
	const retracted = live.filter((n) => !claimed.has(n.id));

	// --- write nodes: retract first, so nothing new ever points at a closing node ---------------
	for (const n of retracted) await g.deleteNode(n.id);

	// The dataset node is written last, so its version's `valid_from` marks the end of this run
	// and `diff(previous dataset version, next one)` brackets exactly one release.
	const datasetUpdate = updates.find((u) => u.node.type === 'dataset');
	let done = 0;
	for (const { node, id } of updates) {
		if (node.type === 'dataset') continue;
		await g.updateNode(id, { data: node.data, body: node.body ?? null });
		if (++done % 1000 === 0) log(`  updated ${done}/${updates.length}`);
	}

	// bulkLoad drops and rebuilds the whole ANN index (minutes at 50k nodes), which only pays off
	// for a big batch. A weekly release adds a few hundred titles: those go through addNode.
	if (inserts.length && inserts.length < (opts.bulkThreshold ?? 2000)) {
		for (const n of inserts) {
			const node = await g.addNode({ type: n.type, data: n.data as never, body: n.body });
			idOf.set(n.key, node.id);
		}
		log(`  addNode ${inserts.length} nodes`);
	} else if (inserts.length) {
		const t = performance.now();
		const { ids } = await bulkLoad(
			db,
			animeSchema,
			inserts.map((n) => ({ type: n.type, data: n.data, body: n.body })),
			{ embedder: opts.embedder, chunkSize: opts.chunkSize ?? 500, validFrom: startedAt },
		);
		inserts.forEach((n, i) => idOf.set(n.key, ids[i] as string));
		log(`  bulkLoad ${inserts.length} nodes in ${((performance.now() - t) / 1000).toFixed(1)}s`);
	}

	// --- edges: diffed by (rel, src, dst) against what is live ------------------------------------
	const liveEdges = (await db.execute('SELECT id, rel, src, dst FROM edges')).rows.map((r) => ({
		id: String(r.id),
		key: `${String(r.rel)}|${String(r.src)}|${String(r.dst)}`,
	}));
	const liveEdgeKeys = new Set(liveEdges.map((e) => e.key));
	const wanted = plan.edges.map((e) => ({
		...e,
		src: idOf.get(e.src) as string,
		dst: idOf.get(e.dst) as string,
	}));
	const wantedKeys = new Set(wanted.map((e) => `${e.rel}|${e.src}|${e.dst}`));
	const newEdges = wanted.filter((e) => !liveEdgeKeys.has(`${e.rel}|${e.src}|${e.dst}`));
	const goneEdges = liveEdges.filter((e) => !wantedKeys.has(e.key));

	log(
		`nodes: ${inserts.length} new, ${updates.length} changed, ${retracted.length} gone, ${unchanged} unchanged; ` +
			`edges: ${newEdges.length} new, ${goneEdges.length} gone`,
	);
	for (const e of goneEdges) await g.deleteEdge(e.id);

	if (newEdges.length) {
		const types = new Map<string, string>();
		for (const n of plan.nodes) types.set(idOf.get(n.key) as string, n.type);
		const t = performance.now();
		await bulkEdges(db, animeSchema, newEdges, {
			types,
			chunkSize: opts.chunkSize ?? 500,
			validFrom: startedAt,
		});
		log(`  bulkEdges ${newEdges.length} edges in ${((performance.now() - t) / 1000).toFixed(1)}s`);
	}

	if (datasetUpdate) {
		const { node, id } = datasetUpdate;
		await g.updateNode(id, { data: node.data, body: node.body ?? null });
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
		unresolved: plan.unresolved,
		startedAt,
		finishedAt: Date.now(),
	};
}

export async function readRelease(path: string): Promise<Release> {
	return Release.parse(await Bun.file(path).json());
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			file: { type: 'string', default: join(import.meta.dir, 'data', RELEASE_FILE) },
			embedder: { type: 'string' },
			db: { type: 'string', default: join(import.meta.dir, NAMESPACE) },
			/** A Postgres connection string; loads there instead of the libSQL file. */
			pg: { type: 'string', default: process.env.DATABASE_URL },
		},
	});
	const t0 = performance.now();
	const secs = (from: number) => `${((performance.now() - from) / 1000).toFixed(1)}s`;

	const release = await readRelease(values.file as string);
	console.log(`release ${release.lastUpdate}: ${release.data.length} entries (${secs(t0)})`);
	const plan = planRelease(release);

	const embedder = embedderFor(values.embedder);
	const db = values.pg
		? createPgClient({ connectionString: values.pg })
		: getDb(values.db as string);
	await init(db, embedder);
	const tSync = performance.now();
	const stats = await syncPlan(db, plan, { embedder, log: (m) => console.log(m) });

	const fmt = (r: Record<string, number>) =>
		Object.entries(r)
			.map(([k, v]) => `${k} ${v.toLocaleString()}`)
			.join(', ');
	console.log(`nodes   ${fmt(stats.types)}`);
	console.log(`edges   ${fmt(stats.rels)}`);
	console.log(
		`related ${stats.unresolved.urls.toLocaleString()} relatedAnime urls (${stats.unresolved.distinct.toLocaleString()} distinct) point outside the release`,
	);
	console.log(`written nodes ${fmt(stats.nodes)}`);
	console.log(`written edges ${fmt(stats.edges)}`);
	console.log(
		`embedder ${embedder.id}, db ${values.pg ? 'postgres' : `${values.db}.db`} — sync ${secs(tSync)}, total ${secs(t0)}`,
	);
	db.close();
}
