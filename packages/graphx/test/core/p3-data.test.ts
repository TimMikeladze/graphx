import { expect, test } from 'bun:test';
import { z, ZodError } from 'zod';
import { FOREVER } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { Graph } from '../../src/core/graph.ts';
import { init } from '../../src/core/schema.ts';
import { embReadSql, libsqlOnly, makeTestDb, stubEmbedder } from './harness.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

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
	await init(client, hashEmbed(4));
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

test('P3: addNode without a vector stores no embedding row (no throw); node retrievable', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({ type: 'person', data: { name: 'noemb' } });
	const r = await client.execute({
		sql: 'SELECT count(*) AS n FROM node_embeddings WHERE id = ?',
		args: [created.id],
	});
	expect(Number(r.rows[0]!.n)).toBe(0);
	const read = await g.getNode(created.id);
	expect(read!.data).toEqual({ name: 'noemb' });
	client.close();
});

libsqlOnly('P3: addNode WITH emb stores a vector row and is reachable via ne_emb_idx', async () => {
	const { client, g } = await freshGraph();
	const created = await g.addNode({ type: 'device', data: { type: 'sensor' }, emb: [1, 0, 0, 0] });
	const r = await client.execute({
		sql: 'SELECT count(*) AS n FROM node_embeddings WHERE id = ?',
		args: [created.id],
	});
	expect(Number(r.rows[0]!.n)).toBe(1);

	// reachable through the vector index over the side table
	const seed = await client.execute({
		sql: "SELECT e.id FROM vector_top_k('ne_emb_idx', vector(?), 1) v JOIN node_embeddings e ON e.rowid = v.id",
		args: ['[1,0,0,0]'],
	});
	expect(String(seed.rows[0]!.id)).toBe(created.id);
	client.close();
});

test('P3: a wrong-width vector is refused before any SQL, with both widths named', async () => {
	const { client, g } = await freshGraph();
	await expect(
		g.addNode({ type: 'device', data: { type: 'sensor' }, emb: [1, 0] }),
	).rejects.toThrow(/2 dimensions but this namespace is embedded at 4/);
	// Nothing leaked: no identity, no version, no vector.
	const n = await client.execute('SELECT count(*) AS n FROM node_identity');
	expect(Number(n.rows[0]!.n)).toBe(0);
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

test('P3: the graph embeds on write and re-embeds only when the embedding input changes', async () => {
	const { client, teardown } = makeTestDb({ file: true });
	let calls = 0;
	const embedder = stubEmbedder(
		(text) => {
			calls++;
			return [text.length, 1, 0, 0];
		},
		{ dim: 4 },
	);
	await init(client, embedder);
	const g = new Graph(client, SCHEMA, { embedder });

	// addNode with a body: embedded once, hash stored beside the vector.
	const node = await g.addNode({ type: 'person', data: { name: 'alice' }, body: 'hello' });
	expect(calls).toBe(1);
	const hashOf = async (): Promise<string> =>
		String(
			(
				await client.execute({
					sql: 'SELECT embed_hash FROM node_embeddings WHERE id = ? AND chunk = 0',
					args: [node.id],
				})
			).rows[0]!.embed_hash,
		);
	const h1 = await hashOf();

	// A data-only patch leaves the input unchanged — no embed call, same hash.
	await g.updateNode(node.id, { data: { name: 'alice b' } });
	expect(calls).toBe(1);
	expect(await hashOf()).toBe(h1);

	// A body change is a new input — re-embedded, new hash, new vector.
	await g.updateNode(node.id, { body: 'hello there' });
	expect(calls).toBe(2);
	expect(await hashOf()).not.toBe(h1);
	const vec = await client.execute({
		sql: `SELECT ${embReadSql(client)} AS v FROM node_embeddings WHERE id = ? AND chunk = 0`,
		args: [node.id],
	});
	expect((JSON.parse(String(vec.rows[0]!.v)) as number[])[0]).toBe('hello there'.length);

	// A node without a body has no vector; a delete removes the vector rows.
	const bare = await g.addNode({ type: 'person', data: { name: 'bare' } });
	expect(calls).toBe(2);
	await g.deleteNode(node.id);
	const left = await client.execute({
		sql: 'SELECT count(*) AS n FROM node_embeddings WHERE id IN (?, ?)',
		args: [node.id, bare.id],
	});
	expect(Number(left.rows[0]!.n)).toBe(0);

	await teardown();
});
