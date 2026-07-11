import { expect, test } from 'bun:test';
import { z } from 'zod';
import { FOREVER } from '../src/db.ts';
import type { DbClient } from '../src/dialect.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { type EmbedFn, retrieve } from '../src/retrieve.ts';
import { init } from '../src/schema.ts';
import { embSql, makeTestDb } from './harness.ts';

// P4 — vectors + GraphRAG retrieve (§7, D3/D5). ANN-seeded, cycle-safe temporal
// walk. dim 4 so embeddings are cheap and the partial vector index is small.

const SCHEMA = defineGraphSchema({
	nodes: {
		doc: z.object({ title: z.string() }),
	},
	edges: {
		links: { from: 'doc', to: 'doc' },
	},
});

// Deterministic stub embed: map known query/body texts to fixed dim-4 vectors.
const VECTORS: Record<string, number[]> = {
	red: [1, 0, 0, 0],
	green: [0, 1, 0, 0],
	blue: [0, 0, 1, 0],
	yellow: [0, 0, 0, 1],
};
const stubEmbed: EmbedFn = async (text: string) => VECTORS[text] ?? [0, 0, 0, 0];

async function freshGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const client = makeTestDb().client;
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

test('P4: ANN seed — retrieve returns the nearest seed first at depth 0', async () => {
	const { client, g } = await freshGraph();
	const red = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	await g.addNode({ type: 'doc', data: { title: 'green' }, body: 'green', emb: VECTORS.green });
	await g.addNode({ type: 'doc', data: { title: 'blue' }, body: 'blue', emb: VECTORS.blue });

	const res = await retrieve(client, stubEmbed, { query: 'red', k: 1 });
	expect(res.length).toBe(1);
	expect(res[0]!.id).toBe(red.id);
	expect(res[0]!.depth).toBe(0);
	expect(res[0]!.body).toBe('red');
	client.close();
});

test('P4: walk — a seed neighbor appears at depth 1', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	const b = await g.addNode({
		type: 'doc',
		data: { title: 'green' },
		body: 'green',
		emb: VECTORS.green,
	});
	await g.addEdge({ rel: 'links', src: a.id, dst: b.id });

	const res = await retrieve(client, stubEmbed, { query: 'red', k: 1, maxDepth: 2 });
	const byId = new Map(res.map((r) => [r.id, r.depth]));
	expect(byId.get(a.id)).toBe(0);
	expect(byId.get(b.id)).toBe(1);
	client.close();
});

test('P4: maxDepth bounds the walk', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	const b = await g.addNode({
		type: 'doc',
		data: { title: 'green' },
		body: 'green',
		emb: VECTORS.green,
	});
	const c = await g.addNode({
		type: 'doc',
		data: { title: 'blue' },
		body: 'blue',
		emb: VECTORS.blue,
	});
	await g.addEdge({ rel: 'links', src: a.id, dst: b.id }); // depth 1
	await g.addEdge({ rel: 'links', src: b.id, dst: c.id }); // depth 2

	const res = await retrieve(client, stubEmbed, { query: 'red', k: 1, maxDepth: 1 });
	const ids = new Set(res.map((r) => r.id));
	expect(ids.has(a.id)).toBe(true);
	expect(ids.has(b.id)).toBe(true);
	expect(ids.has(c.id)).toBe(false); // beyond maxDepth
	client.close();
});

test('P4: cycle safety — A->B->A terminates and dedups (each id once)', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	const b = await g.addNode({
		type: 'doc',
		data: { title: 'green' },
		body: 'green',
		emb: VECTORS.green,
	});
	await g.addEdge({ rel: 'links', src: a.id, dst: b.id });
	await g.addEdge({ rel: 'links', src: b.id, dst: a.id });

	const res = await retrieve(client, stubEmbed, { query: 'red', k: 1, maxDepth: 5 });
	const ids = res.map((r) => r.id);
	// terminates; no infinite loop; each id exactly once
	expect(new Set(ids).size).toBe(ids.length);
	expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
	// MIN(depth) per id
	const byId = new Map(res.map((r) => [r.id, r.depth]));
	expect(byId.get(a.id)).toBe(0);
	expect(byId.get(b.id)).toBe(1);
	client.close();
});

test('P4: direction filter — forward vs reverse', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	const b = await g.addNode({
		type: 'doc',
		data: { title: 'green' },
		body: 'green',
		emb: VECTORS.green,
	});
	await g.addEdge({ rel: 'links', src: a.id, dst: b.id }); // a -> b

	// forward from a reaches b
	const fwd = await retrieve(client, stubEmbed, { query: 'red', k: 1, direction: 'forward' });
	expect(new Set(fwd.map((r) => r.id))).toEqual(new Set([a.id, b.id]));

	// reverse from a (no incoming edges) reaches only a
	const rev = await retrieve(client, stubEmbed, { query: 'red', k: 1, direction: 'reverse' });
	expect(new Set(rev.map((r) => r.id))).toEqual(new Set([a.id]));
	client.close();
});

test('P4: rels filter restricts walk to matching relations', async () => {
	const SCHEMA2 = defineGraphSchema({
		nodes: { doc: z.object({ title: z.string() }) },
		edges: {
			links: { from: 'doc', to: 'doc' },
			cites: { from: 'doc', to: 'doc' },
		},
	});
	const client = makeTestDb().client;
	await init(client, 4);
	const g = new Graph(client, SCHEMA2);
	const a = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	const b = await g.addNode({
		type: 'doc',
		data: { title: 'green' },
		body: 'green',
		emb: VECTORS.green,
	});
	const c = await g.addNode({
		type: 'doc',
		data: { title: 'blue' },
		body: 'blue',
		emb: VECTORS.blue,
	});
	await g.addEdge({ rel: 'links', src: a.id, dst: b.id }); // links: a -> b
	await g.addEdge({ rel: 'cites', src: a.id, dst: c.id }); // cites: a -> c

	const onlyLinks = await retrieve(client, stubEmbed, { query: 'red', k: 1, rels: ['links'] });
	expect(new Set(onlyLinks.map((r) => r.id))).toEqual(new Set([a.id, b.id])); // c excluded
	client.close();
});

test('P4: ordered by depth ascending', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	const b = await g.addNode({
		type: 'doc',
		data: { title: 'green' },
		body: 'green',
		emb: VECTORS.green,
	});
	const c = await g.addNode({
		type: 'doc',
		data: { title: 'blue' },
		body: 'blue',
		emb: VECTORS.blue,
	});
	await g.addEdge({ rel: 'links', src: a.id, dst: b.id });
	await g.addEdge({ rel: 'links', src: b.id, dst: c.id });

	const res = await retrieve(client, stubEmbed, { query: 'red', k: 1, maxDepth: 2 });
	const depths = res.map((r) => r.depth);
	expect(depths).toEqual([...depths].sort((x, y) => x - y));
	client.close();
});

test('P4: asOf — past returns v1 era shape, current returns v2 (raw temporal fixture)', async () => {
	const client = makeTestDb().client;
	await init(client, 4);
	const id = '01ARZ3NDEKTSV4RRFFQ69G5FZ1';
	const T1 = 1000; // v1 valid_from
	const T2 = 2000; // v1 closed / v2 opened
	const ASOF_PAST = 1500; // mid-v1

	// RAW SQL — control valid_from/valid_to directly (no dependency on P6 updateNode).
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	// v1: body 'red-old', live emb so the partial live index seeds it... but we close
	// it below. The seed for past asOf must come from the live index over-fetch+filter.
	await client.execute({
		sql: `INSERT INTO node_versions (ver, id, type, body, emb, valid_from, valid_to) VALUES (?,?,?,?,${embSql(client)},?,?)`,
		args: [1, id, 'doc', 'red-old', '[1,0,0,0]', T1, T2],
	});
	// v2: body 'red-new', live (valid_to = FOREVER), same emb so it's in the live index.
	await client.execute({
		sql: `INSERT INTO node_versions (ver, id, type, body, emb, valid_from, valid_to) VALUES (?,?,?,?,${embSql(client)},?,?)`,
		args: [2, id, 'doc', 'red-new', '[1,0,0,0]', T2, FOREVER],
	});

	// current (no asOf): live v2 shape
	const cur = await retrieve(client, stubEmbed, { query: 'red', k: 4 });
	const curRow = cur.find((r) => r.id === id);
	expect(curRow).toBeDefined();
	expect(curRow!.body).toBe('red-new');

	// past asOf: v1 era shape — seed via live-index over-fetch, then temporal-filter
	// to the row valid at ASOF_PAST.
	const past = await retrieve(client, stubEmbed, { query: 'red', k: 4, asOf: ASOF_PAST });
	const pastRow = past.find((r) => r.id === id);
	expect(pastRow).toBeDefined();
	expect(pastRow!.body).toBe('red-old');
	client.close();
});

test('P4: asOf walk — neighbor valid at :t appears; edge not yet valid is skipped', async () => {
	const client = makeTestDb().client;
	await init(client, 4);
	const a = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
	const b = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
	const eid = '01ARZ3NDEKTSV4RRFFQ69G5FE1';

	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [a] });
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [b] });
	// a is live with emb (seed), b is live (no emb needed)
	await client.execute({
		sql: `INSERT INTO node_versions (ver, id, type, body, emb, valid_from, valid_to) VALUES (?,?,?,?,${embSql(client)},?,?)`,
		args: [1, a, 'doc', 'red', '[1,0,0,0]', 100, FOREVER],
	});
	await client.execute({
		sql: 'INSERT INTO node_versions (ver, id, type, body, valid_from, valid_to) VALUES (?,?,?,?,?,?)',
		args: [2, b, 'doc', 'green', 100, FOREVER],
	});
	// edge a->b only becomes valid at t=5000
	await client.execute({ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [eid] });
	await client.execute({
		sql: 'INSERT INTO edge_versions (ver, id, src, dst, rel, valid_from, valid_to) VALUES (?,?,?,?,?,?,?)',
		args: [1, eid, a, b, 'links', 5000, FOREVER],
	});

	// asOf=3000: edge not valid yet → b not reached
	const before = await retrieve(client, stubEmbed, { query: 'red', k: 4, asOf: 3000, maxDepth: 2 });
	expect(new Set(before.map((r) => r.id))).toEqual(new Set([a]));

	// asOf=6000: edge valid → b reached at depth 1
	const after = await retrieve(client, stubEmbed, { query: 'red', k: 4, asOf: 6000, maxDepth: 2 });
	const byId = new Map(after.map((r) => [r.id, r.depth]));
	expect(byId.get(a)).toBe(0);
	expect(byId.get(b)).toBe(1);
	client.close();
});

test('P4: tolerates NULL emb rows (no throw, seed still works)', async () => {
	const { client, g } = await freshGraph();
	// a node with no embedding (NULL emb)
	await g.addNode({ type: 'doc', data: { title: 'noemb' }, body: 'noemb' });
	const red = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});

	const res = await retrieve(client, stubEmbed, { query: 'red', k: 1 });
	expect(res[0]!.id).toBe(red.id);
	client.close();
});

test('P4: default k and maxDepth applied (k=10, maxDepth=2)', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({
		type: 'doc',
		data: { title: 'red' },
		body: 'red',
		emb: VECTORS.red,
	});
	const b = await g.addNode({
		type: 'doc',
		data: { title: 'green' },
		body: 'green',
		emb: VECTORS.green,
	});
	const c = await g.addNode({
		type: 'doc',
		data: { title: 'blue' },
		body: 'blue',
		emb: VECTORS.blue,
	});
	const d = await g.addNode({
		type: 'doc',
		data: { title: 'yellow' },
		body: 'yellow',
		emb: VECTORS.yellow,
	});
	await g.addEdge({ rel: 'links', src: a.id, dst: b.id });
	await g.addEdge({ rel: 'links', src: b.id, dst: c.id });
	await g.addEdge({ rel: 'links', src: c.id, dst: d.id });

	// k=1 so only `a` (nearest to red) seeds; maxDepth defaults to 2 so d (depth 3)
	// is excluded. (With the default k=10 all four nodes would seed at depth 0.)
	const res = await retrieve(client, stubEmbed, { query: 'red', k: 1 });
	const ids = new Set(res.map((r) => r.id));
	expect(ids.has(a.id)).toBe(true);
	expect(ids.has(b.id)).toBe(true);
	expect(ids.has(c.id)).toBe(true);
	expect(ids.has(d.id)).toBe(false);
	client.close();
});
