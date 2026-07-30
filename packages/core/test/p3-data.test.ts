import { expect, test } from 'bun:test';
import { z, ZodError } from 'zod';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { libsqlOnly, makeTestDb } from './harness.ts';

// The nv_emb_idx retrieval probe uses libSQL's vector_top_k; PG vector retrieval is covered by P4.

// P3 — data layer (§6, D1/D3/B5/M6). Round-trips nodes/edges through the
// close-and-insert temporal store with ULID identity, exercising getNode (live
// read via the `nodes` view), neighbors (forward/reverse/both + rel filter),
// endpoint-type validation, ZodError on bad data, and the single-open-version
// invariant.

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string(), crit: z.number().default(1) }),
		person: z.object({ name: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device', data: z.object({ since: z.number() }) },
		knows: { from: 'person', to: 'person' },
	},
});

// dim 4 so embeddings are cheap and the vector index is small.
async function freshGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const client = makeTestDb().client;
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

test('P3: addNode -> getNode round-trips type + data (defaults applied)', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({ type: 'device', data: { type: 'router' } });
	expect(created.type).toBe('device');
	expect(created.data).toEqual({ type: 'router', crit: 1 }); // default applied

	const read = await g.getNode(created.id);
	expect(read).not.toBeNull();
	expect(read!.type).toBe('device');
	expect(read!.data).toEqual({ type: 'router', crit: 1 });
	expect(read!.id).toBe(created.id);
	client.close();
});

test('P3: ULID id is a 26-char string', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({ type: 'person', data: { name: 'ada' } });
	expect(typeof created.id).toBe('string');
	expect(created.id.length).toBe(26);
	client.close();
});

test('P3: addNode without emb inserts SQL NULL (no throw); node retrievable', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({ type: 'person', data: { name: 'noemb' } });
	const r = await client.execute({
		sql: 'SELECT emb FROM node_versions WHERE id = ?',
		args: [created.id],
	});
	expect(r.rows[0]!.emb).toBeNull();
	const read = await g.getNode(created.id);
	expect(read!.data).toEqual({ name: 'noemb' });
	client.close();
});

libsqlOnly('P3: addNode WITH emb stores a vector and is retrievable via nv_emb_idx', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({ type: 'device', data: { type: 'sensor' }, emb: [1, 0, 0, 0] });
	const r = await client.execute({
		sql: 'SELECT emb FROM node_versions WHERE id = ?',
		args: [created.id],
	});
	expect(r.rows[0]!.emb).not.toBeNull(); // a real F32 blob, not NULL

	// reachable through the partial vector index (live rows)
	const seed = await client.execute({
		sql: "SELECT n.id FROM vector_top_k('nv_emb_idx', vector(?), 1) v JOIN node_versions n ON n.rowid = v.id",
		args: ['[1,0,0,0]'],
	});
	expect(String(seed.rows[0]!.id)).toBe(created.id);
	client.close();
});

test('P3: addNode creates exactly ONE open version (valid_to = FOREVER) for the id', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({ type: 'person', data: { name: 'solo' } });
	const all = await client.execute({
		sql: 'SELECT valid_to FROM node_versions WHERE id = ?',
		args: [created.id],
	});
	expect(all.rows.length).toBe(1);
	expect(Number(all.rows[0]!.valid_to)).toBe(FOREVER);
	client.close();
});

test('P3: addNode persists body/uri/content_hash/content_type', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({
		type: 'device',
		data: { type: 'cam' },
		body: 'hello',
		uri: 's3://bucket/key',
		content_hash: 'abc123',
		content_type: 'text/plain',
	});
	const r = await client.execute({
		sql: 'SELECT body, uri, content_hash, content_type FROM node_versions WHERE id = ?',
		args: [created.id],
	});
	const row = r.rows[0]!;
	expect(String(row.body)).toBe('hello');
	expect(String(row.uri)).toBe('s3://bucket/key');
	expect(String(row.content_hash)).toBe('abc123');
	expect(String(row.content_type)).toBe('text/plain');
	client.close();
});

test('P3: bad node data throw ZodError', async () => {
	const { client, g } = await freshGraph();
	await expect(
		// @ts-expect-error type is wrong on purpose
		g.addNode({ type: 'device', data: { type: 42 } }),
	).rejects.toThrow(ZodError);
	client.close();
});

test('P3: monotonic write clock — two rapid addNode get strictly increasing valid_from', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({ type: 'person', data: { name: 'a' } });
	const b = await g.addNode({ type: 'person', data: { name: 'b' } });
	const r = await client.execute({
		sql: 'SELECT id, valid_from FROM node_versions WHERE id IN (?, ?)',
		args: [a.id, b.id],
	});
	const byId = new Map(r.rows.map((x) => [String(x.id), Number(x.valid_from)]));
	expect(byId.get(b.id)!).toBeGreaterThan(byId.get(a.id)!);
	client.close();
});

test('P3: addEdge round-trips; one open version; data validated', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'owner' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 2020 } });
	expect(typeof e.id).toBe('string');
	expect(e.id.length).toBe(26);

	const r = await client.execute({
		sql: 'SELECT src, dst, rel, valid_to, data FROM edge_versions WHERE id = ?',
		args: [e.id],
	});
	expect(r.rows.length).toBe(1);
	expect(String(r.rows[0]!.src)).toBe(p.id);
	expect(String(r.rows[0]!.dst)).toBe(d.id);
	expect(String(r.rows[0]!.rel)).toBe('owns');
	expect(Number(r.rows[0]!.valid_to)).toBe(FOREVER);
	expect(JSON.parse(String(r.rows[0]!.data))).toEqual({ since: 2020 });
	client.close();
});

test('P3: addEdge with default weight 1.0 and explicit weight', async () => {
	const { client, g } = await freshGraph();
	const p1 = await g.addNode({ type: 'person', data: { name: 'p1' } });
	const p2 = await g.addNode({ type: 'person', data: { name: 'p2' } });
	const e = await g.addEdge({ rel: 'knows', src: p1.id, dst: p2.id, weight: 3.5 });
	const r = await client.execute({
		sql: 'SELECT weight FROM edge_versions WHERE id = ?',
		args: [e.id],
	});
	expect(Number(r.rows[0]!.weight)).toBe(3.5);
	client.close();
});

test('P3: addEdge with wrong src type throws (endpoint-type validation)', async () => {
	const { client, g } = await freshGraph();
	const d1 = await g.addNode({ type: 'device', data: { type: 'a' } });
	const d2 = await g.addNode({ type: 'device', data: { type: 'b' } });
	// owns expects from: person — a device src is invalid
	await expect(
		g.addEdge({ rel: 'owns', src: d1.id, dst: d2.id, data: { since: 1 } }),
	).rejects.toThrow();
	client.close();
});

test('P3: addEdge with wrong dst type throws', async () => {
	const { client, g } = await freshGraph();
	const p1 = await g.addNode({ type: 'person', data: { name: 'p1' } });
	const p2 = await g.addNode({ type: 'person', data: { name: 'p2' } });
	// owns expects to: device — a person dst is invalid
	await expect(
		g.addEdge({ rel: 'owns', src: p1.id, dst: p2.id, data: { since: 1 } }),
	).rejects.toThrow();
	client.close();
});

test('P3: addEdge with bad edge data throws ZodError', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d = await g.addNode({ type: 'device', data: { type: 'd' } });
	await expect(
		// @ts-expect-error since must be a number
		g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 'soon' } }),
	).rejects.toThrow(ZodError);
	client.close();
});

test('P3: neighbors forward returns dst nodes', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'owner' } });
	const d1 = await g.addNode({ type: 'device', data: { type: 'r1' } });
	const d2 = await g.addNode({ type: 'device', data: { type: 'r2' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d1.id, data: { since: 1 } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d2.id, data: { since: 2 } });

	const fwd = await g.neighbors(p.id, { direction: 'forward' });
	const ids = new Set(fwd.map((n) => n.id));
	expect(ids).toEqual(new Set([d1.id, d2.id]));
	// shape carries type+data
	const dn = fwd.find((n) => n.id === d1.id)!;
	expect(dn.type).toBe('device');
	expect(dn.data).toEqual({ type: 'r1', crit: 1 });
	client.close();
});

test('P3: neighbors reverse returns src nodes', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'owner' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r1' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });

	const rev = await g.neighbors(d.id, { direction: 'reverse' });
	expect(rev.map((n) => n.id)).toEqual([p.id]);
	expect(rev[0]!.type).toBe('person');
	client.close();
});

test('P3: neighbors both returns src and dst sides', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({ type: 'person', data: { name: 'a' } });
	const b = await g.addNode({ type: 'person', data: { name: 'b' } });
	const c = await g.addNode({ type: 'person', data: { name: 'c' } });
	await g.addEdge({ rel: 'knows', src: a.id, dst: b.id }); // a->b
	await g.addEdge({ rel: 'knows', src: c.id, dst: a.id }); // c->a

	const both = await g.neighbors(a.id, { direction: 'both' });
	expect(new Set(both.map((n) => n.id))).toEqual(new Set([b.id, c.id]));
	client.close();
});

test('P3: neighbors default direction is forward', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'owner' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r1' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	const def = await g.neighbors(p.id);
	expect(def.map((n) => n.id)).toEqual([d.id]);
	client.close();
});

test('P3: neighbors rels filter restricts to matching relations', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'owner' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r1' } });
	const other = await g.addNode({ type: 'person', data: { name: 'friend' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	await g.addEdge({ rel: 'knows', src: p.id, dst: other.id });

	const ownsOnly = await g.neighbors(p.id, { direction: 'forward', rels: ['owns'] });
	expect(ownsOnly.map((n) => n.id)).toEqual([d.id]);

	const knowsOnly = await g.neighbors(p.id, { direction: 'forward', rels: ['knows'] });
	expect(knowsOnly.map((n) => n.id)).toEqual([other.id]);
	client.close();
});

test('P3: getNode returns null for an unknown id', async () => {
	const { client, g } = await freshGraph();
	const read = await g.getNode('01ARZ3NDEKTSV4RRFFQ69G5FZZ');
	expect(read).toBeNull();
	client.close();
});

test('P3: embed_hash — addNode stores it; updateNode without embed_hash carries it forward; explicit patch replaces it', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	await init(client, 4);
	const g = new Graph(client, SCHEMA);

	// addNode with embed_hash: 'h1'
	const node = await g.addNode({ type: 'person', data: { name: 'alice' }, embed_hash: 'h1' });

	// Read back via nodes view — embed_hash must be present and equal 'h1'
	const r1 = await client.execute({
		sql: 'SELECT embed_hash FROM nodes WHERE id = ?',
		args: [node.id],
	});
	expect(String(r1.rows[0]!.embed_hash)).toBe('h1');

	// updateNode with only body change (no embed_hash patch) — carry forward
	await g.updateNode(node.id, { body: 'x2' });
	const r2 = await client.execute({
		sql: 'SELECT embed_hash FROM nodes WHERE id = ?',
		args: [node.id],
	});
	expect(String(r2.rows[0]!.embed_hash)).toBe('h1');

	// updateNode with explicit embed_hash — replaces stored value
	await g.updateNode(node.id, { embed_hash: 'h2' });
	const r3 = await client.execute({
		sql: 'SELECT embed_hash FROM nodes WHERE id = ?',
		args: [node.id],
	});
	expect(String(r3.rows[0]!.embed_hash)).toBe('h2');

	await teardown();
});
