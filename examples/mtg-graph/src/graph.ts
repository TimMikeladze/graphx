import { buildCSR, neighbors as csrNeighbors } from 'graphx';
import type { Runtime } from './runtime';
import { NotFound } from './decks';
import { InputError } from './search';
import type { GraphData, GraphNode, GraphPath } from './graph-model';
const relations = ['has_keyword', 'has_subtype', 'fills_role'];
export async function similar(r: Runtime, id: string, limit = 12, format?: string) {
	if (!r.catalog.has(id)) throw new NotFound('Card not found');
	const rows = await r.db.execute({
		sql: `WITH features AS (SELECT dst, rel FROM edges WHERE src=? AND rel IN ('has_keyword','has_subtype','fills_role')), degrees AS (SELECT e.dst, count(*) AS degree FROM edges e JOIN features f ON f.dst=e.dst AND f.rel=e.rel GROUP BY e.dst) SELECT e.src AS id, group_concat(DISTINCT e.dst) AS evidence, sum(1.0/(2+d.degree)) AS score FROM edges e JOIN features f ON e.dst=f.dst AND e.rel=f.rel JOIN degrees d ON d.dst=e.dst WHERE e.src!=? GROUP BY e.src ORDER BY score DESC, e.src LIMIT 100`,
		args: [id, id],
	});
	return rows.rows
		.flatMap((row) => {
			const c = r.catalog.get(String(row.id));
			if (!c || (format && !['Legal', 'Restricted'].includes(c.legalities[format] ?? '')))
				return [];
			return [
				{
					card: c,
					score: Number(row.score),
					evidence: String(row.evidence)
						.split(',')
						.map((x) => ({ type: x.slice(0, x.indexOf(':')), name: x.slice(x.indexOf(':') + 1) })),
					method: 'Shared graph neighbors, weighted by inverse feature frequency',
				},
			];
		})
		.slice(0, limit);
}
function graphNode(r: Runtime, node: { id: string; type: string; data: unknown }): GraphNode {
	const card = r.catalog.get(node.id);
	const data = node.data as Record<string, unknown>;
	return {
		id: node.id,
		type: node.type,
		name: card?.name ?? String(data.name ?? node.id),
		...(card ? { card } : {}),
	};
}
export async function neighborhood(
	r: Runtime,
	id: string,
	rel?: string,
	limit = 8,
): Promise<GraphData> {
	const center = await r.graph.getNode(id);
	if (!center) throw new NotFound('Node not found');
	const selected = rel ? [...new Set(rel.split(','))] : Object.keys(r.graph.schema.edges);
	if (selected.some((key) => !Object.keys(r.graph.schema.edges).includes(key)))
		throw new InputError('Unknown relation');
	if (!Number.isInteger(limit) || limit < 1 || limit > 40)
		throw new InputError('Card limit must be between 1 and 40');
	const batches = await Promise.all(
		selected.map((rel) => r.graph.listEdges({ src: id, rel, limit: 60, limits: { maxRows: 60 } })),
	);
	const all = batches.flatMap((b) => b.edges);
	const edges = all.slice(0, 120);
	const nodes = await Promise.all(
		[...new Set(edges.map((e) => e.dst))].map((id) => r.graph.getNode(id)),
	);
	const shared = new Set(edges.map((e) => e.dst));
	const links = [...edges];
	let moreCards = false;
	if (r.catalog.has(id) && shared.size) {
		const featureIds = [...shared];
		const rows = await r.db.execute({
			sql: `SELECT src, count(*) AS shared FROM edges WHERE dst IN (${featureIds.map(() => '?').join(',')}) AND rel IN (${selected.map(() => '?').join(',')}) AND src != ? GROUP BY src ORDER BY shared DESC, src LIMIT 101`,
			args: [...featureIds, ...selected, id],
		});
		const candidates = rows.rows
			.map((row) => r.catalog.get(String(row.src)))
			.filter((c) => c !== undefined);
		moreCards = candidates.length > limit;
		for (const card of candidates.slice(0, limit)) {
			const batches = await Promise.all(
				selected.map((rel) =>
					r.graph.listEdges({ src: card.id, rel, limit: 60, limits: { maxRows: 60 } }),
				),
			);
			const connected = batches.flatMap((b) => b.edges).filter((e) => shared.has(e.dst));
			if (!connected.length) continue;
			nodes.push({ id: card.id, type: 'card', data: card });
			links.push(...connected);
		}
	}
	const unique = new Map([center, ...nodes.filter((n) => n !== null)].map((n) => [n!.id, n!]));
	return {
		nodes: [...unique.values()].map((n) => graphNode(r, n)),
		edges: links.map((e) => ({
			id: e.id,
			src: e.src,
			dst: e.dst,
			rel: e.rel,
			data: (e.data ?? {}) as Record<string, unknown>,
		})),
		truncated: batches.some((b) => b.edges.length === 60) || all.length > 120,
		moreCards,
	};
}
// Cache by database so separate imports and in-memory workspaces never share adjacency.
const adjacency = new WeakMap<Runtime['db'], Promise<Map<string, string[]>>>();
export async function shortest(r: Runtime, from: string, to: string): Promise<GraphPath> {
	if (!r.catalog.has(from) || !r.catalog.has(to))
		throw new NotFound('Both endpoints must be card IDs');
	let snapshot = adjacency.get(r.db);
	if (!snapshot) {
		snapshot = (async () => {
			const csr = await buildCSR(r.db, { rels: relations });
			const map = new Map<string, string[]>();
			for (let i = 0; i < csr.idxToId.length; i++) {
				const source = csr.idxToId[i]!;
				for (const n of csrNeighbors(csr, i)) {
					const target = csr.idxToId[n.to]!;
					const forward = map.get(source);
					if (forward) forward.push(target);
					else map.set(source, [target]);
					const reverse = map.get(target);
					if (reverse) reverse.push(source);
					else map.set(target, [source]);
				}
			}
			return map;
		})();
		adjacency.set(r.db, snapshot);
	}
	const neighbors = await snapshot;
	const previous = new Map<string, string | null>([[from, null]]);
	const queue = [{ id: from, depth: 0 }];
	let explored = 0;
	const finishPath = async (destination: string): Promise<GraphPath> => {
		const ids: string[] = [];
		let at: string | null = destination;
		while (at) {
			ids.unshift(at);
			at = previous.get(at) ?? null;
		}
		const stored = await Promise.all(ids.map((id) => r.graph.getNode(id)));
		const nodes = stored.filter((n) => n !== null).map((n) => graphNode(r, n!));
		const edges: GraphData['edges'] = [];
		for (let index = 1; index < ids.length; index++) {
			const a = ids[index - 1]!,
				b = ids[index]!;
			const src = r.catalog.has(a) ? a : b,
				dst = src === a ? b : a;
			const result = await r.graph.listEdges({ src, dst, limit: 20 });
			edges.push(
				...result.edges
					.filter((e) => relations.includes(e.rel))
					.map((e) => ({
						id: e.id,
						src: e.src,
						dst: e.dst,
						rel: e.rel,
						data: (e.data ?? {}) as Record<string, unknown>,
					})),
			);
		}
		return {
			path: nodes.map((n) => ({ id: n.id, name: n.name })),
			hops: ids.length - 1,
			explored,
			nodes,
			edges,
			truncated: false,
		};
	};
	for (let cursor = 0; cursor < queue.length && explored < 10000; cursor++) {
		const current = queue[cursor]!;
		explored++;
		if (current.id === to) return finishPath(to);
		if (current.depth >= 6) continue;
		for (const id of neighbors.get(current.id) ?? [])
			if (!previous.has(id)) {
				previous.set(id, current.id);
				if (id === to) return finishPath(to);
				queue.push({ id, depth: current.depth + 1 });
			}
	}
	return { path: [], hops: null, explored, nodes: [], edges: [], truncated: explored >= 10000 };
}
export async function recommend(r: Runtime, deckId: string) {
	const d = await r.decks.get(deckId);
	const entries = d.entries.filter((e) => e.board === 'main');
	const seeds = entries
		.filter((e) => !r.catalog.get(e.cardId)?.types.includes('Land'))
		.sort(
			(a, b) =>
				(r.catalog.get(a.cardId)?.edhrecRank ?? Infinity) -
				(r.catalog.get(b.cardId)?.edhrecRank ?? Infinity),
		)
		.slice(0, 6);
	const exists = new Set(d.entries.map((e) => e.cardId));
	if (d.commanderId) {
		seeds.unshift({ cardId: d.commanderId, quantity: 1, board: 'main' });
		exists.add(d.commanderId);
	}
	const commander = d.commanderId ? r.catalog.get(d.commanderId) : null;
	const identity = new Set(
		commander?.colorIdentity ??
			entries.flatMap((e) => r.catalog.get(e.cardId)?.colorIdentity ?? []),
	);
	const candidates = new Map<
		string,
		{
			card: NonNullable<ReturnType<typeof r.catalog.get>>;
			score: number;
			evidence: string[];
			connections: number;
		}
	>();
	for (const seed of seeds) {
		for (const s of await similar(r, seed.cardId, 30, d.format)) {
			if (
				exists.has(s.card.id) ||
				s.card.colorIdentity.some((c) => !identity.has(c)) ||
				s.card.types.includes('Land')
			)
				continue;
			const old = candidates.get(s.card.id);
			candidates.set(s.card.id, {
				card: s.card,
				score: (old?.score ?? 0) + s.score,
				evidence: [
					...new Set([...(old?.evidence ?? []), ...s.evidence.map((e) => `${e.type}: ${e.name}`)]),
				],
				connections: (old?.connections ?? 0) + 1,
			});
		}
	}
	return [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}
