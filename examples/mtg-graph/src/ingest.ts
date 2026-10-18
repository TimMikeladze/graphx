import { bulkLoad, bulkEdges, Graph, type DbClient, type BulkRow, type BulkEdgeRow } from 'graphx';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { schema, type Card } from './schema';
import { normalizeCard, deriveRoles, key, type Atomic } from './catalog';
export const canonical = (v: unknown) =>
	JSON.stringify(v, (_k, x) =>
		x && typeof x === 'object' && !Array.isArray(x)
			? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
			: x,
	);
export interface Release {
	meta: { date: string; version: string };
	data: Record<string, Atomic[]>;
	coverage?: string;
	images?: Record<string, { scryfallId: string; prices: Card['prices'] }>;
}
export async function readRelease(root: string): Promise<Release> {
	const full = join(root, 'data', 'AtomicCards.json');
	const release = JSON.parse(
		await readFile(existsSync(full) ? full : join(root, 'data', 'snapshot.json'), 'utf8'),
	);
	const images = join(root, 'data', 'images.json');
	release.images = JSON.parse(
		await readFile(
			existsSync(images) ? images : join(root, 'data', 'snapshot-images.json'),
			'utf8',
		),
	);
	return release;
}
export function planRelease(release: Release) {
	const unique = new Map<string, Card>();
	for (const [n, f] of Object.entries(release.data)) {
		const c = normalizeCard(n, f);
		const old = unique.get(c.id);
		if (old) {
			const primary = old.name.length <= c.name.length ? old : c;
			const secondary = primary === old ? c : old;
			unique.set(c.id, {
				...primary,
				aliases: [...new Set([...primary.aliases, ...secondary.aliases, secondary.name])],
				printings: [...new Set([...old.printings, ...c.printings])],
			});
		} else unique.set(c.id, c);
	}
	const cards = [...unique.values()].map((c) => ({
		...c,
		...release.images?.[c.id.slice(5)],
	}));
	const nodes = new Map<string, BulkRow<typeof schema>>(),
		edges = new Map<string, BulkEdgeRow<typeof schema>>();
	const connect = (
		card: Card,
		rel: BulkEdgeRow<typeof schema>['rel'],
		type: keyof typeof schema.nodes,
		name: string,
		data?: Record<string, unknown>,
	) => {
		const id = key(type, name);
		nodes.set(id, { id, type, data: { name } });
		const edgeId = `${card.id}|${rel}|${id}`;
		edges.set(edgeId, {
			id: edgeId,
			rel,
			src: card.id,
			dst: id,
			...(data ? { data } : {}),
			source: 'mtgjson',
		});
	};
	for (const c of cards) {
		nodes.set(c.id, { id: c.id, type: 'card', data: c, body: `${c.name}\n${c.type}\n${c.text}` });
		for (const k of c.keywords) connect(c, 'has_keyword', 'keyword', k);
		for (const s of c.subtypes) connect(c, 'has_subtype', 'subtype', s);
		for (const col of c.colorIdentity) connect(c, 'has_color', 'color', col);
		for (const s of c.printings) connect(c, 'printed_in', 'set', s);
		for (const [f, status] of Object.entries(c.legalities))
			connect(c, 'legal_in', 'format', f, { status });
		for (const r of deriveRoles(c))
			connect(c, 'fills_role', 'role', r.name, {
				evidence: r.evidence,
				ruleVersion: r.ruleVersion,
			});
	}
	const metadata = {
		name: 'MTGJSON / AtomicCards · schema 2',
		date: release.meta.date,
		version: release.meta.version,
		coverage: release.coverage ?? 'full',
		cards: cards.length,
		source: 'https://mtgjson.com/api/v5/AtomicCards.json.xz',
	};
	nodes.set('dataset:mtgjson', { id: 'dataset:mtgjson', type: 'dataset', data: metadata });
	return { cards, nodes: [...nodes.values()], edges: [...edges.values()], metadata };
}
export async function syncRelease(db: DbClient, release: Release) {
	const plan = planRelease(release);
	const graph = new Graph(db, schema);
	const existing = new Map(
		(
			await db.execute(
				"SELECT id, data, body FROM nodes WHERE type NOT IN ('deck','published_deck')",
			)
		).rows.map((r) => [String(r.id), { data: JSON.parse(String(r.data)), body: r.body ?? null }]),
	);
	const oldEdges = new Map(
		(
			await db.execute(
				"SELECT id, data FROM edges WHERE rel NOT IN ('contains','published_contains','published_in')",
			)
		).rows.map((r) => [String(r.id), r.data ? JSON.parse(String(r.data)) : null]),
	);
	const fresh = plan.nodes.filter((n) => n.type !== 'dataset' && !existing.has(n.id!));
	if (fresh.length) await bulkLoad(db, schema, fresh, { chunkSize: 300 });
	let updated = 0;
	for (const n of plan.nodes) {
		const old = existing.get(n.id!);
		if (
			n.type !== 'dataset' &&
			old &&
			!(n.type === 'set' && old.data.sourceId) &&
			canonical(old.data) !== canonical(n.data)
		) {
			await graph.updateNode(n.id!, { data: n.data, body: n.body ?? null });
			updated++;
		}
	}
	const newEdges = plan.edges.filter((e) => !oldEdges.has(e.id!));
	if (newEdges.length)
		await bulkEdges(db, schema, newEdges, {
			chunkSize: 500,
			types: new Map(plan.nodes.map((n) => [n.id!, n.type])),
		});
	for (const e of plan.edges) {
		const old = oldEdges.get(e.id!);
		if (oldEdges.has(e.id!) && canonical(old) !== canonical(e.data ?? {}))
			await graph.correctEdge(e.id!, { data: e.data ?? {} }, { validFrom: Date.now() });
	}
	const keepEdges = new Set(plan.edges.map((e) => e.id!));
	for (const id of oldEdges.keys()) if (!keepEdges.has(id)) await graph.deleteEdge(id);
	const keepNodes = new Set(plan.nodes.map((n) => n.id!));
	const protectedCards = new Set(
		(
			await db.execute(
				"SELECT dst AS id FROM edges WHERE rel='contains' UNION SELECT json_extract(data,'$.commanderId') AS id FROM nodes WHERE type='deck' AND json_extract(data,'$.commanderId') IS NOT NULL",
			)
		).rows.map((r) => String(r.id)),
	);
	for (const [id, old] of existing)
		if (!keepNodes.has(id) && !old.data.sourceId && !protectedCards.has(id))
			await graph.deleteNode(id);
	const marker = await graph.getNode('dataset:mtgjson');
	if (marker) {
		if (canonical(marker.data) !== canonical(plan.metadata))
			await graph.updateNode('dataset:mtgjson', { data: plan.metadata });
	} else
		await bulkLoad(db, schema, [{ id: 'dataset:mtgjson', type: 'dataset', data: plan.metadata }]);
	return { ...plan, inserted: fresh.length, updated, edgesInserted: newEdges.length };
}
