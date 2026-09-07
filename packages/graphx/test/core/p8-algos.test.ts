import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import type { DbClient } from '../../src/core/dialect.ts';
import {
	buildCSR,
	centrality,
	community,
	neighbors,
	pagerank,
	shortestPath,
	snapshotCSR,
	topNodes,
} from '../../src/core/algorithms.ts';
import { FOREVER } from '../../src/core/db.ts';
import { init } from '../../src/core/schema.ts';
import { makeTestDb } from './harness.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

// P8 — graph algorithms (§11). Fixtures built with RAW SQL so each test controls
// weight / rel / valid_from / valid_to directly (independent of P3). dim 4 keeps
// the schema small. Dense-int CSR indices are non-deterministic across ULIDs, so
// every assertion translates back to ULID ids via the B8 dictionary.

async function fresh(): Promise<DbClient> {
	const client = makeTestDb().client;
	await init(client, hashEmbed(4));
	return client;
}

/** Insert a node identity + one version live for [validFrom, validTo). */
async function node(
	client: DbClient,
	name: string,
	opts: { type?: string; validFrom?: number; validTo?: number } = {},
): Promise<string> {
	const id = ulid();
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: `INSERT INTO node_versions (id, type, data, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`,
		args: [
			id,
			opts.type ?? 'thing',
			JSON.stringify({ name }),
			opts.validFrom ?? 0,
			opts.validTo ?? FOREVER,
		],
	});
	return id;
}

/** Insert an edge identity + one version live for [validFrom, validTo). */
async function edge(
	client: DbClient,
	src: string,
	dst: string,
	opts: { rel?: string; weight?: number; validFrom?: number; validTo?: number } = {},
): Promise<string> {
	const id = ulid();
	await client.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: `INSERT INTO edge_versions (id, src, dst, rel, weight, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		args: [
			id,
			src,
			dst,
			opts.rel ?? 'link',
			opts.weight ?? 1.0,
			opts.validFrom ?? 0,
			opts.validTo ?? FOREVER,
		],
	});
	return id;
}

/** Reference Dijkstra over a JS adjacency map (id -> [{to, w}]); returns cost or Infinity. */
function refDijkstra(
	adj: Map<string, Array<{ to: string; w: number }>>,
	src: string,
	dst: string,
): number {
	const dist = new Map<string, number>();
	dist.set(src, 0);
	const visited = new Set<string>();
	while (visited.size < dist.size) {
		// pick the unvisited node with the smallest tentative distance
		let u: string | null = null;
		let best = Infinity;
		for (const [k, d] of dist) {
			if (!visited.has(k) && d < best) {
				best = d;
				u = k;
			}
		}
		if (u === null) break;
		visited.add(u);
		for (const e of adj.get(u) ?? []) {
			const nd = best + e.w;
			if (nd < (dist.get(e.to) ?? Infinity)) dist.set(e.to, nd);
		}
	}
	return dist.get(dst) ?? Infinity;
}

/** Validate a returned path: endpoints correct, every hop is a real edge, summed cost matches. */
function pathCost(
	adj: Map<string, Array<{ to: string; w: number }>>,
	path: string[],
	weighted: boolean,
): number {
	let total = 0;
	for (let i = 0; i + 1 < path.length; i++) {
		const from = path[i]!;
		const to = path[i + 1]!;
		const e = (adj.get(from) ?? []).find((x) => x.to === to);
		if (!e) throw new Error(`path hop ${from}->${to} is not an edge`);
		total += weighted ? e.w : 1;
	}
	return total;
}

// ---------------------------------------------------------------------------
// CSR mirror (B8 dictionary, deterministic ordered scan)
// ---------------------------------------------------------------------------

test('P8: buildCSR builds a dense-int dictionary + adjacency over the live edges view', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const c = await node(client, 'C');
	const d = await node(client, 'D');
	await edge(client, a, b, { weight: 2 });
	await edge(client, a, c, { weight: 5 });
	await edge(client, b, c, { weight: 1 });
	await edge(client, c, d, { weight: 1 });

	const csr = await buildCSR(client);
	expect(csr.n).toBe(4);
	expect(csr.offsets.length).toBe(5); // n + 1
	expect(csr.targets.length).toBe(4); // m
	// dictionary round-trips and is a deterministic ascending-by-id scan
	expect([...csr.idToIdx.keys()].sort()).toEqual([a, b, c, d].sort());
	expect(csr.idxToId).toEqual([...csr.idxToId].sort());
	for (const id of [a, b, c, d]) expect(csr.idxToId[csr.idToIdx.get(id)!]).toBe(id);

	// a's neighbors = {b:2, c:5}
	const aN = neighbors(csr, csr.idToIdx.get(a)!);
	expect(new Map(aN.map((x) => [x.id, x.weight]))).toEqual(
		new Map([
			[b, 2],
			[c, 5],
		]),
	);
	// d is a sink
	expect(neighbors(csr, csr.idToIdx.get(d)!)).toEqual([]);
	client.close();
});

test('P8: snapshotCSR reflects the graph as of a past instant (half-open, D3)', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const c = await node(client, 'C');
	// a->b only live in [0,100); a->c live from 100 on
	await edge(client, a, b, { validFrom: 0, validTo: 100 });
	await edge(client, a, c, { validFrom: 100, validTo: FOREVER });

	const past = await snapshotCSR(client, 50);
	expect(neighbors(past, past.idToIdx.get(a)!).map((x) => x.id)).toEqual([b]);

	const later = await snapshotCSR(client, 150);
	expect(neighbors(later, later.idToIdx.get(a)!).map((x) => x.id)).toEqual([c]);

	// current view agrees with "later"
	const now = await buildCSR(client);
	expect(neighbors(now, now.idToIdx.get(a)!).map((x) => x.id)).toEqual([c]);
	client.close();
});

// ---------------------------------------------------------------------------
// shortestPath — memory + sql modes vs reference Dijkstra (acceptance)
// ---------------------------------------------------------------------------

test('P8: weighted shortestPath (memory) prefers the cheaper multi-hop route', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const d = await node(client, 'D');
	await edge(client, a, b, { weight: 1 });
	await edge(client, b, d, { weight: 1 });
	await edge(client, a, d, { weight: 5 }); // direct but expensive

	const r = await shortestPath(client, a, d, { mode: 'memory', weighted: true });
	expect(r).not.toBeNull();
	expect(r!.cost).toBe(2);
	expect(r!.path).toEqual([a, b, d]);
	client.close();
});

test('P8: shortestPath sql and memory modes agree with reference Dijkstra (non-negative weights)', async () => {
	const client = await fresh();
	const ids = [];
	for (let i = 0; i < 7; i++) ids.push(await node(client, `n${i}`));
	const [n0, n1, n2, n3, n4, n5, n6] = ids as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	const E: Array<[string, string, number]> = [
		[n0, n1, 4],
		[n0, n2, 1],
		[n2, n1, 1],
		[n1, n3, 1],
		[n2, n3, 5],
		[n3, n4, 3],
		[n4, n5, 2],
		[n2, n5, 12],
		[n5, n6, 1],
		[n3, n6, 10],
	];
	const adj = new Map<string, Array<{ to: string; w: number }>>();
	for (const [s, d, w] of E) {
		await edge(client, s, d, { weight: w });
		if (!adj.has(s)) adj.set(s, []);
		adj.get(s)!.push({ to: d, w });
	}

	for (const src of ids) {
		for (const dst of ids) {
			if (src === dst) continue;
			const ref = refDijkstra(adj, src, dst);
			const mem = await shortestPath(client, src, dst, { mode: 'memory', weighted: true });
			const sql = await shortestPath(client, src, dst, { mode: 'sql', weighted: true });
			if (ref === Infinity) {
				expect(mem).toBeNull();
				expect(sql).toBeNull();
			} else {
				expect(mem).not.toBeNull();
				expect(sql).not.toBeNull();
				expect(mem!.cost).toBeCloseTo(ref, 5);
				expect(sql!.cost).toBeCloseTo(ref, 5);
				// returned paths are valid and realize the optimum
				expect(mem!.path[0]).toBe(src);
				expect(mem!.path[mem!.path.length - 1]).toBe(dst);
				expect(pathCost(adj, mem!.path, true)).toBeCloseTo(ref, 5);
				expect(pathCost(adj, sql!.path, true)).toBeCloseTo(ref, 5);
			}
		}
	}
	client.close();
});

test('P8: shortestPath src === dst is a zero-cost single-node path', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const r = await shortestPath(client, a, a, { mode: 'memory' });
	expect(r).toEqual({ path: [a], cost: 0 });
	const r2 = await shortestPath(client, a, a, { mode: 'sql' });
	expect(r2).toEqual({ path: [a], cost: 0 });
	client.close();
});

test('P8: shortestPath returns null when no route exists', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	// no edges
	expect(await shortestPath(client, a, b, { mode: 'memory' })).toBeNull();
	expect(await shortestPath(client, a, b, { mode: 'sql' })).toBeNull();
	client.close();
});

test('P8: unweighted shortestPath minimizes hop count, not cost', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const d = await node(client, 'D');
	await edge(client, a, b, { weight: 100 });
	await edge(client, b, d, { weight: 100 });
	await edge(client, a, d, { weight: 1 }); // 1 hop, cheap weight

	const r = await shortestPath(client, a, d, { mode: 'memory', weighted: false });
	expect(r!.cost).toBe(1); // one hop
	expect(r!.path).toEqual([a, d]);
	const rs = await shortestPath(client, a, d, { mode: 'sql', weighted: false });
	expect(rs!.cost).toBe(1);
	expect(rs!.path).toEqual([a, d]);
	client.close();
});

test('P8: shortestPath rels filter restricts traversable edges', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const d = await node(client, 'D');
	await edge(client, a, b, { rel: 'road', weight: 1 });
	await edge(client, b, d, { rel: 'road', weight: 1 });
	await edge(client, a, d, { rel: 'rail', weight: 1 });

	// rail-only: direct hop
	const rail = await shortestPath(client, a, d, { mode: 'memory', rels: ['rail'] });
	expect(rail!.path).toEqual([a, d]);
	// road-only: must detour via b
	const road = await shortestPath(client, a, d, { mode: 'memory', rels: ['road'] });
	expect(road!.path).toEqual([a, b, d]);
	// sql mode honors the same filter
	const railSql = await shortestPath(client, a, d, { mode: 'sql', rels: ['rail'] });
	expect(railSql!.path).toEqual([a, d]);
	client.close();
});

test('P8: A* heuristic produces the same optimum as plain Dijkstra (admissible)', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const d = await node(client, 'D');
	await edge(client, a, b, { weight: 1 });
	await edge(client, b, d, { weight: 1 });
	await edge(client, a, d, { weight: 5 });

	// zero heuristic is admissible -> A* == Dijkstra
	const r = await shortestPath(client, a, d, { mode: 'memory', heuristic: () => 0 });
	expect(r!.cost).toBe(2);
	expect(r!.path).toEqual([a, b, d]);
	client.close();
});

// ---------------------------------------------------------------------------
// analytics — pagerank / community / centrality persist to node_analytics
// ---------------------------------------------------------------------------

test('P8: pagerank persists to node_analytics, sums to ~1, ranks the hub first', async () => {
	const client = await fresh();
	const hub = await node(client, 'hub');
	const spokes = [];
	for (let i = 0; i < 5; i++) spokes.push(await node(client, `s${i}`));
	for (const s of spokes) await edge(client, s, hub); // everyone points at the hub

	const pr = await pagerank(client);
	expect(pr.size).toBe(6);
	const total = [...pr.values()].reduce((x, y) => x + y, 0);
	expect(total).toBeCloseTo(1, 4);
	// hub has the highest score
	const hubScore = pr.get(hub)!;
	for (const s of spokes) expect(hubScore).toBeGreaterThan(pr.get(s)!);

	// persisted + orderable
	const persisted = await client.execute(
		'SELECT id, pagerank FROM node_analytics WHERE pagerank IS NOT NULL',
	);
	expect(persisted.rows.length).toBe(6);
	const top = await topNodes(client, { by: 'pagerank', limit: 1 });
	expect(top[0]!.id).toBe(hub);
	client.close();
});

test('P8: community (label propagation) separates two disconnected triangles', async () => {
	const client = await fresh();
	const t1 = [
		await node(client, 'a0'),
		await node(client, 'a1'),
		await node(client, 'a2'),
	] as const;
	const t2 = [
		await node(client, 'b0'),
		await node(client, 'b1'),
		await node(client, 'b2'),
	] as const;
	for (const [x, y] of [
		[t1[0], t1[1]],
		[t1[1], t1[2]],
		[t1[2], t1[0]],
	] as const)
		await edge(client, x, y);
	for (const [x, y] of [
		[t2[0], t2[1]],
		[t2[1], t2[2]],
		[t2[2], t2[0]],
	] as const)
		await edge(client, x, y);

	const com = await community(client);
	expect(com.size).toBe(6);
	// all of triangle 1 share a label, distinct from triangle 2
	expect(com.get(t1[0])).toBe(com.get(t1[1])!);
	expect(com.get(t1[1])).toBe(com.get(t1[2])!);
	expect(com.get(t2[0])).toBe(com.get(t2[1])!);
	expect(com.get(t2[1])).toBe(com.get(t2[2])!);
	expect(com.get(t1[0])).not.toBe(com.get(t2[0])!);

	const persisted = await client.execute(
		'SELECT COUNT(*) AS c FROM node_analytics WHERE community IS NOT NULL',
	);
	expect(Number(persisted.rows[0]!.c)).toBe(6);
	client.close();
});

test('P8: degree centrality persists and topNodes orders by it', async () => {
	const client = await fresh();
	const hub = await node(client, 'hub');
	const a = await node(client, 'a');
	const b = await node(client, 'b');
	await edge(client, hub, a);
	await edge(client, hub, b);
	await edge(client, a, b);

	const deg = await centrality(client, 'degree');
	// hub: out2+in0=2 ; a: out1+in1=2 ; b: out0+in2=2 — all degree 2 in this shape
	expect(deg.get(hub)).toBe(2);
	expect(deg.get(a)).toBe(2);
	expect(deg.get(b)).toBe(2);

	const persisted = await client.execute(
		'SELECT COUNT(*) AS c FROM node_analytics WHERE degree IS NOT NULL',
	);
	expect(Number(persisted.rows[0]!.c)).toBe(3);
	client.close();
});

test('P8: topNodes filters by node type', async () => {
	const client = await fresh();
	const p1 = await node(client, 'p1', { type: 'Person' });
	const p2 = await node(client, 'p2', { type: 'Person' });
	const doc = await node(client, 'doc', { type: 'Doc' });
	await edge(client, p1, doc);
	await edge(client, p2, doc);
	await edge(client, p1, p2);
	await centrality(client, 'degree');

	const people = await topNodes(client, { by: 'degree', type: 'Person', limit: 10 });
	expect(people.every((r) => r.type === 'Person')).toBe(true);
	expect(people.map((r) => r.id).sort()).toEqual([p1, p2].sort());
	client.close();
});

// --- review fixes: contract & coverage gaps surfaced by adversarial review ---

test('P8: topNodes strictly orders by the metric DESC (distinct values)', async () => {
	const client = await fresh();
	// out-degrees: hub=3, mid=1, leaf=0 -> total degree hub>mid>leaf is distinct
	const hub = await node(client, 'hub');
	const mid = await node(client, 'mid');
	const leaf = await node(client, 'leaf');
	const x = await node(client, 'x');
	await edge(client, hub, mid);
	await edge(client, hub, leaf);
	await edge(client, hub, x);
	await edge(client, mid, leaf);
	await centrality(client, 'out'); // out-degree: hub=3, mid=1, leaf=0, x=0

	const top = await topNodes(client, { by: 'degree', limit: 4 });
	expect(top[0]!.id).toBe(hub);
	expect(top[0]!.degree).toBe(3);
	// strictly non-increasing across the whole result (not a tautology — values differ)
	for (let i = 1; i < top.length; i++)
		expect(top[i - 1]!.degree!).toBeGreaterThanOrEqual(top[i]!.degree!);
	client.close();
});

test('P8: topNodes rejects a non-whitelisted metric (prototype-key guard)', async () => {
	const client = await fresh();
	await node(client, 'a');
	// 'constructor' is an inherited Object.prototype key — must NOT escape into the SQL.
	await expect(topNodes(client, { by: 'constructor' as unknown as 'degree' })).rejects.toThrow();
	await expect(topNodes(client, { by: '__proto__' as unknown as 'degree' })).rejects.toThrow();
	client.close();
});

test('P8: snapshotCSR(FOREVER) means "now" — agrees with buildCSR, not an empty graph (D3)', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	await edge(client, a, b, { weight: 3 });

	const live = await buildCSR(client);
	const atForever = await snapshotCSR(client, FOREVER);
	expect(atForever.n).toBe(live.n);
	expect(atForever.targets.length).toBe(live.targets.length);
	expect(neighbors(atForever, atForever.idToIdx.get(a)!).map((x) => x.id)).toEqual([b]);
	client.close();
});

test('P8: snapshotCSR honors the rels filter', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const c = await node(client, 'C');
	await edge(client, a, b, { rel: 'red', validFrom: 0, validTo: FOREVER });
	await edge(client, a, c, { rel: 'blue', validFrom: 0, validTo: FOREVER });

	const redPast = await snapshotCSR(client, 50, { rels: ['red'] });
	expect(neighbors(redPast, redPast.idToIdx.get(a)!).map((x) => x.id)).toEqual([b]);
	const redNow = await buildCSR(client, { rels: ['red'] });
	expect(neighbors(redNow, redNow.idToIdx.get(a)!).map((x) => x.id)).toEqual([b]);
	client.close();
});

test('P8: sql-mode unbounded finds the long optimum; maxDepth bound may return suboptimal/null', async () => {
	const client = await fresh();
	const ids = [];
	for (let i = 0; i < 7; i++) ids.push(await node(client, `n${i}`));
	const [n0, , , , , , n6] = ids as [string, string, string, string, string, string, string];
	// chain n0->...->n6 (6 hops, cost 6) plus a 1-hop direct n0->n6 of cost 100
	for (let i = 0; i + 1 < ids.length; i++) await edge(client, ids[i]!, ids[i + 1]!, { weight: 1 });
	await edge(client, n0, n6, { weight: 100 });

	// unbounded sql == memory == true optimum
	const sqlUnbounded = await shortestPath(client, n0, n6, { mode: 'sql', weighted: true });
	const mem = await shortestPath(client, n0, n6, { mode: 'memory', weighted: true });
	expect(mem!.cost).toBe(6);
	expect(sqlUnbounded!.cost).toBe(6);
	// bounded sql can only see the short expensive route -> suboptimal but documented
	const sqlBounded = await shortestPath(client, n0, n6, {
		mode: 'sql',
		weighted: true,
		maxDepth: 2,
	});
	expect(sqlBounded!.cost).toBe(100);
	expect(sqlBounded!.path).toEqual([n0, n6]);
	client.close();
});

test('P8: sql-mode bound returns null when the optimum exceeds maxDepth (no direct edge)', async () => {
	const client = await fresh();
	const ids = [];
	for (let i = 0; i < 7; i++) ids.push(await node(client, `n${i}`));
	for (let i = 0; i + 1 < ids.length; i++) await edge(client, ids[i]!, ids[i + 1]!, { weight: 1 });
	const src = ids[0]!;
	const dst = ids[6]!; // 6 hops away, no shortcut

	const bounded = await shortestPath(client, src, dst, { mode: 'sql', maxDepth: 2 });
	expect(bounded).toBeNull(); // unreachable within the bound
	const unbounded = await shortestPath(client, src, dst, { mode: 'sql' });
	expect(unbounded!.cost).toBe(6); // genuinely reachable
	client.close();
});

test('P8: A* with a non-zero admissible heuristic returns the same optimum as Dijkstra', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const d = await node(client, 'D');
	await edge(client, a, b, { weight: 1 });
	await edge(client, b, d, { weight: 1 });
	await edge(client, a, d, { weight: 5 });

	// positions on a line; unit-weight edges -> manhattan-to-dst is admissible & non-zero
	const pos = new Map<string, number>([
		[a, 0],
		[b, 1],
		[d, 2],
	]);
	const heuristic = (id: string): number => Math.abs(2 - (pos.get(id) ?? 0));
	expect(heuristic(a)).toBe(2); // non-zero -> exercises h(v) in the heap key

	const astar = await shortestPath(client, a, d, { mode: 'memory', heuristic });
	const plain = await shortestPath(client, a, d, { mode: 'memory' });
	expect(astar).toEqual(plain); // heuristic changes exploration order, not the answer
	expect(astar!.cost).toBe(2);
	expect(astar!.path).toEqual([a, b, d]);
	client.close();
});

test('P8: shortestPath is cycle-safe — a back-edge does not hang or mislead (both modes)', async () => {
	const client = await fresh();
	const a = await node(client, 'A');
	const b = await node(client, 'B');
	const c = await node(client, 'C');
	await edge(client, a, b, { weight: 1 });
	await edge(client, b, c, { weight: 1 });
	await edge(client, c, a, { weight: 1 }); // back-edge -> cycle a->b->c->a
	await edge(client, a, c, { weight: 5 }); // direct but expensive

	for (const mode of ['memory', 'sql'] as const) {
		const r = await shortestPath(client, a, c, { mode, weighted: true });
		expect(r!.cost).toBe(2); // a->b->c beats the direct edge
		expect(r!.path).toEqual([a, b, c]);
	}
	client.close();
});
