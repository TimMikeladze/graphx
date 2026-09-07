import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { FOREVER } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { Graph } from '../../src/core/graph.ts';
import { init } from '../../src/core/schema.ts';
import { asOfPredicate, diff, history } from '../../src/core/temporal.ts';
import { embReadSql, makeTestDb } from './harness.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

// P6 — temporal ops (§9, §19.1, B4/B5/D3). updateNode/deleteEdge use the
// conditional-close + retry pattern; history/diff/asOf surface the temporal
// store. Carry-forward (B4 columns, B5 emb blob) is the headline correctness
// concern: a data-only patch must NEVER null body/uri/emb on the successor.

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
const DIM = 4;

// This @libsql/client build nulls its connection after `transaction()` and opens
// a FRESH one on the next plain execute. With `:memory:` that fresh connection is
// a separate empty DB ("no such table"), so updateNode/deleteEdge (which use
// transactions) need a real on-disk file the connections can share. Each graph
// gets a unique temp file; all are unlinked in afterAll.
const teardowns: Array<() => Promise<void>> = [];

async function freshGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, hashEmbed(DIM));
	return { client, g: new Graph(client, SCHEMA) };
}

afterAll(async () => {
	for (const teardown of teardowns) {
		await teardown();
	}
});

// Read a node version row directly (bypassing the live view) by valid_to.
async function versionRows(client: DbClient, id: string): Promise<Record<string, unknown>[]> {
	const r = await client.execute({
		sql: 'SELECT ver, type, body, uri, content_hash, content_type, data, valid_from, valid_to FROM node_versions WHERE id = ? ORDER BY valid_from',
		args: [id],
	});
	return r.rows as unknown as Record<string, unknown>[];
}

test('P6: updateNode produces exactly 2 versions (closed + open); view shows new', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router' } });
	await g.updateNode(n.id, { data: { type: 'switch' } });

	const rows = await versionRows(client, n.id);
	expect(rows.length).toBe(2);
	const open = rows.filter((r) => Number(r.valid_to) === FOREVER);
	const closed = rows.filter((r) => Number(r.valid_to) !== FOREVER);
	expect(open.length).toBe(1);
	expect(closed.length).toBe(1);

	// the `nodes` view shows ONLY the new live version
	const read = await g.getNode(n.id);
	expect(read!.data).toEqual({ type: 'switch', crit: 1 });
	client.close();
});

test('P6 (B4): data-only patch carries body/uri/content_hash/content_type forward', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({
		type: 'device',
		data: { type: 'cam' },
		body: 'original body',
		uri: 's3://bucket/key',
		content_hash: 'abc123',
		content_type: 'text/plain',
	});
	await g.updateNode(n.id, { data: { type: 'cam2' } });

	const rows = await versionRows(client, n.id);
	const open = rows.find((r) => Number(r.valid_to) === FOREVER)!;
	// B4: all metadata columns survive a data-only patch (non-null, equal to original)
	expect(open.body).not.toBeNull();
	expect(String(open.body)).toBe('original body');
	expect(String(open.uri)).toBe('s3://bucket/key');
	expect(String(open.content_hash)).toBe('abc123');
	expect(String(open.content_type)).toBe('text/plain');
	expect(JSON.parse(String(open.data))).toEqual({ type: 'cam2', crit: 1 });
	client.close();
});

test('P6 (B5): data-only patch keeps the stored vector (side table survives a new version)', async () => {
	const { client, g } = await freshGraph();
	const emb = [1, 0, 0, 0];
	const n = await g.addNode({ type: 'device', data: { type: 'sensor' }, emb });

	await g.updateNode(n.id, { data: { type: 'sensor2' } });

	// The vector is keyed by identity, not version, so the successor still has it.
	const got = await client.execute({
		sql: `SELECT ${embReadSql(client)} AS v FROM node_embeddings WHERE id = ? AND chunk = 0`,
		args: [n.id],
	});
	const arr = JSON.parse(String(got.rows[0]!.v)) as number[];
	expect(arr.length).toBe(DIM);
	expect(arr).toEqual(emb);
	client.close();
});

test('P6 (B5): explicit emb patch replaces the embedding', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'sensor' }, emb: [1, 0, 0, 0] });
	await g.updateNode(n.id, { emb: [0, 1, 0, 0] });

	const got = await client.execute({
		sql: `SELECT ${embReadSql(client)} AS v FROM node_embeddings WHERE id = ? AND chunk = 0`,
		args: [n.id],
	});
	expect(JSON.parse(String(got.rows[0]!.v))).toEqual([0, 1, 0, 0]);
	client.close();
});

test('P6: updateNode on a node with no vector stays without one (no throw)', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'person', data: { name: 'noemb' } });
	await g.updateNode(n.id, { data: { name: 'noemb2' } });

	const rows = await versionRows(client, n.id);
	const open = rows.find((r) => Number(r.valid_to) === FOREVER)!;
	const vec = await client.execute({
		sql: 'SELECT count(*) AS n FROM node_embeddings WHERE id = ?',
		args: [n.id],
	});
	expect(Number(vec.rows[0]!.n)).toBe(0);
	expect(JSON.parse(String(open.data))).toEqual({ name: 'noemb2' });
	client.close();
});

test('P6: updateNode data merge (partial patch merges over current data)', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router', crit: 5 } });
	// patch only `crit`; `type` must survive via the merge
	await g.updateNode(n.id, { data: { crit: 9 } });
	const read = await g.getNode(n.id);
	expect(read!.data).toEqual({ type: 'router', crit: 9 });
	client.close();
});

test('P6: updateNode type patch changes type on the successor', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'person', data: { name: 'x' } });
	await g.updateNode(n.id, { type: 'device', data: { type: 'r' } });
	const rows = await versionRows(client, n.id);
	const open = rows.find((r) => Number(r.valid_to) === FOREVER)!;
	expect(String(open.type)).toBe('device');
	client.close();
});

test('P6: updateNode on missing live version throws', async () => {
	const { client, g } = await freshGraph();
	await expect(
		g.updateNode('01ARZ3NDEKTSV4RRFFQ69G5FZZ', { data: { type: 'x' } }),
	).rejects.toThrow();
	client.close();
});

test('P6 (§9): asOf semantics — read before update sees old, after sees new', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'old' } });

	// capture the snapshot of the original version's bytes BEFORE the update
	const beforeRows = await versionRows(client, n.id);
	const original = beforeRows[0]!;
	const beforeUpdate = Number(original.valid_from); // any t within the original's interval

	await g.updateNode(n.id, { data: { type: 'new' } });

	const pred = asOfPredicate('nv');
	// asOf(beforeUpdate) -> old data
	const past = await client.execute({
		sql: `SELECT data FROM node_versions nv WHERE nv.id = ? AND ${pred}`,
		args: [n.id, beforeUpdate, beforeUpdate],
	});
	expect(JSON.parse(String(past.rows[0]!.data))).toEqual({ type: 'old', crit: 1 });

	// asOf(now) -> new data (live)
	const read = await g.getNode(n.id);
	expect(read!.data).toEqual({ type: 'new', crit: 1 });

	// original (closed) version row bytes are unchanged (data + valid_from intact)
	const afterRows = await versionRows(client, n.id);
	const closed = afterRows.find((r) => Number(r.ver) === Number(original.ver))!;
	expect(String(closed.data)).toBe(String(original.data));
	expect(Number(closed.valid_from)).toBe(Number(original.valid_from));
	client.close();
});

test('P6 (§9): history returns all versions ordered by valid_from; grows by 1 per update', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'v0' } });

	let h = await history(client, n.id);
	expect(h.length).toBe(1);

	await g.updateNode(n.id, { data: { type: 'v1' } });
	h = await history(client, n.id);
	expect(h.length).toBe(2);

	await g.updateNode(n.id, { data: { type: 'v2' } });
	h = await history(client, n.id);
	expect(h.length).toBe(3);

	// ordered ascending by valid_from
	const froms = h.map((r) => Number(r.valid_from));
	const sorted = [...froms].sort((a, b) => a - b);
	expect(froms).toEqual(sorted);

	// versions are immutable: the data sequence is v0, v1, v2 in time order
	const types = h.map((r) => JSON.parse(String(r.data)).type);
	expect(types).toEqual(['v0', 'v1', 'v2']);
	client.close();
});

test('P6: deleteEdge closes the live edge (no successor); edges view drops it', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'owner' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });

	await g.deleteEdge(e.id);

	// exactly ONE version row (the now-closed one); no successor inserted
	const rows = await client.execute({
		sql: 'SELECT valid_to FROM edge_versions WHERE id = ?',
		args: [e.id],
	});
	expect(rows.rows.length).toBe(1);
	expect(Number(rows.rows[0]!.valid_to)).not.toBe(FOREVER);

	// edges view no longer shows it
	const live = await client.execute({ sql: 'SELECT id FROM edges WHERE id = ?', args: [e.id] });
	expect(live.rows.length).toBe(0);

	// neighbors no longer reaches the device
	const nb = await g.neighbors(p.id, { direction: 'forward' });
	expect(nb.find((x) => x.id === d.id)).toBeUndefined();
	client.close();
});

test('P6: deleteEdge on missing live edge throws', async () => {
	const { client, g } = await freshGraph();
	await expect(g.deleteEdge('01ARZ3NDEKTSV4RRFFQ69G5FZZ')).rejects.toThrow();
	client.close();
});

test('P6: deleteNode closes the live node (no successor); view drops it; history/asOf still return it', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'doomed' } });

	// capture a t within the original version's interval BEFORE the delete
	const beforeRows = await versionRows(client, n.id);
	const original = beforeRows[0]!;
	const beforeDelete = Number(original.valid_from);

	await g.deleteNode(n.id);

	// exactly ONE version row (the now-closed one); NO successor — unlike updateNode's 2.
	const rows = await versionRows(client, n.id);
	expect(rows.length).toBe(1);
	expect(Number(rows[0]!.valid_to)).not.toBe(FOREVER);

	// the `nodes` live view drops it
	expect(await g.getNode(n.id)).toBeNull();

	// history still sees the closed version (reads node_versions directly, ignores valid_to)
	const h = await history(client, n.id);
	expect(h.length).toBe(1);

	// as-of a t inside the original interval STILL returns the data — the close preserved
	// the past rather than destroying it.
	const pred = asOfPredicate('nv');
	const past = await client.execute({
		sql: `SELECT data FROM node_versions nv WHERE nv.id = ? AND ${pred}`,
		args: [n.id, beforeDelete, beforeDelete],
	});
	expect(JSON.parse(String(past.rows[0]!.data))).toEqual({ type: 'doomed', crit: 1 });
	client.close();
});

test('P6: deleteNode on missing live version throws', async () => {
	const { client, g } = await freshGraph();
	await expect(g.deleteNode('01ARZ3NDEKTSV4RRFFQ69G5FZZ')).rejects.toThrow();
	client.close();
});

test('P6 (§19.1): consecutive updates yield half-open, non-overlapping intervals', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'a' } });
	await g.updateNode(n.id, { data: { type: 'b' } });
	await g.updateNode(n.id, { data: { type: 'c' } });

	const rows = await versionRows(client, n.id);
	expect(rows.length).toBe(3);
	// sorted by valid_from already; each closed interval's valid_to == next valid_from
	for (let i = 0; i < rows.length - 1; i++) {
		const cur = rows[i]!;
		const next = rows[i + 1]!;
		// half-open: valid_from < valid_to for every interval (non-zero-width)
		expect(Number(cur.valid_from)).toBeLessThan(Number(cur.valid_to));
		// contiguous, non-overlapping: this version closes exactly where the next opens
		expect(Number(cur.valid_to)).toBe(Number(next.valid_from));
	}
	// last is open
	expect(Number(rows[rows.length - 1]!.valid_to)).toBe(FOREVER);
	client.close();
});

test('P6 (§9): diff returns rows whose interval changed between t1 and t2', async () => {
	const { client, g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'a' } });
	const p = await g.addNode({ type: 'person', data: { name: 'q' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: n.id, data: { since: 1 } });

	// Pin t1 to the latest pre-mutation write: the monotonic clock (M6) guarantees
	// every later mutation gets a STRICTLY greater timestamp, so the `(t1, t2]`
	// window captures the close+insert events but excludes the untouched rows'
	// original valid_from. Avoids racing the wall clock.
	const preMax = await client.execute({
		sql: 'SELECT MAX(vf) AS m FROM (SELECT valid_from AS vf FROM node_versions UNION ALL SELECT valid_from FROM edge_versions)',
	});
	const t1 = Number(preMax.rows[0]!.m);

	await g.updateNode(n.id, { data: { type: 'b' } }); // closes old (valid_to in window) + opens new (valid_from in window)
	await g.deleteEdge(e.id); // closes edge (valid_to in window)

	// t2 = latest mutation timestamp across both tables (any valid_from, plus any
	// non-FOREVER valid_to from a close), so the edge close lands inside the window.
	const postMax = await client.execute({
		sql: `SELECT MAX(t) AS m FROM (
				SELECT valid_from AS t FROM node_versions
				UNION ALL SELECT valid_from FROM edge_versions
				UNION ALL SELECT valid_to FROM node_versions WHERE valid_to <> ?
				UNION ALL SELECT valid_to FROM edge_versions WHERE valid_to <> ?)`,
		args: [FOREVER, FOREVER],
	});
	const t2 = Number(postMax.rows[0]!.m);

	const d = await diff(client, t1, t2);
	const nodeIds = new Set(d.nodes.map((r) => String(r.id)));
	const edgeIds = new Set(d.edges.map((r) => String(r.id)));
	expect(nodeIds.has(n.id)).toBe(true);
	expect(edgeIds.has(e.id)).toBe(true);
	// the untouched person node did not change in (t1, t2]
	expect(nodeIds.has(p.id)).toBe(false);
	client.close();
});

test('P6: asOfPredicate returns the half-open D3 form referencing the alias', async () => {
	expect(asOfPredicate('nv')).toBe('nv.valid_from <= ? AND ? < nv.valid_to');
	expect(asOfPredicate('e')).toBe('e.valid_from <= ? AND ? < e.valid_to');
});

test('P6: getNode(asOf) reads the version live at that instant', async () => {
	const { g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router' } });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.updateNode(n.id, { data: { type: 'switch' } });

	// Live and an explicit "now" agree.
	expect((await g.getNode(n.id))?.data.type).toBe('switch');
	expect((await g.getNode(n.id, { asOf: FOREVER }))?.data.type).toBe('switch');
	// The past sees the original.
	expect((await g.getNode(n.id, { asOf: t0 }))?.data.type).toBe('router');
	// Before the node existed there is nothing to see.
	expect(await g.getNode(n.id, { asOf: 1 })).toBeNull();
});

test('P6: getNode(asOf) still finds a retracted node before its retraction', async () => {
	const { g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router' } });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.deleteNode(n.id);

	expect(await g.getNode(n.id)).toBeNull();
	expect((await g.getNode(n.id, { asOf: t0 }))?.data.type).toBe('router');
});

test('P6: getNodeContent(asOf) reads that version body and provenance', async () => {
	const { g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router' }, body: 'first' });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.updateNode(n.id, { body: 'second' });

	expect((await g.getNodeContent(n.id))?.body).toBe('second');
	expect((await g.getNodeContent(n.id, { asOf: t0 }))?.body).toBe('first');
	expect(await g.getNodeContent(n.id, { asOf: 1 })).toBeNull();
});

test('P6: neighbors(asOf) sees an edge that has since been deleted', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	// Graph.now() (the write clock) is monotonic — Math.max(Date.now(), lastTs + 1) — so a
	// burst of writes landing in the same wall-clock ms can produce valid_from values ahead
	// of real time. Buffer past the last write before snapshotting "now" for a past read.
	await new Promise((r) => setTimeout(r, 5));
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.deleteEdge(e.id);

	expect((await g.neighbors(p.id)).length).toBe(0);
	const past = await g.neighbors(p.id, { asOf: t0 });
	expect(past.map((n) => n.id)).toEqual([d.id]);
});

test('P6: neighbors(asOf) returns the neighbor version live at that instant', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	// buffer past the monotonic write clock (see above)
	await new Promise((r) => setTimeout(r, 5));
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.updateNode(d.id, { data: { type: 'switch' } });

	expect((await g.neighbors(p.id))[0]?.data.type).toBe('switch');
	expect((await g.neighbors(p.id, { asOf: t0 }))[0]?.data.type).toBe('router');
});

test('P6: neighbors(asOf) in both directions, and asOf=FOREVER matches the live read', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	// buffer past the monotonic write clock (see above)
	await new Promise((r) => setTimeout(r, 5));
	const t = Date.now();

	expect((await g.neighbors(d.id, { direction: 'reverse', asOf: t })).map((n) => n.id)).toEqual([
		p.id,
	]);
	expect((await g.neighbors(p.id, { direction: 'both', asOf: t })).map((n) => n.id)).toEqual([
		d.id,
	]);
	expect((await g.neighbors(p.id, { asOf: FOREVER })).map((n) => n.id)).toEqual(
		(await g.neighbors(p.id)).map((n) => n.id),
	);
});

test('P6: neighborsPage(asOf) pages the as-of neighbor set', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const a = await g.addNode({ type: 'device', data: { type: 'a' } });
	const b = await g.addNode({ type: 'device', data: { type: 'b' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: a.id, data: { since: 1 } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: b.id, data: { since: 2 } });
	// buffer past the monotonic write clock (see above)
	await new Promise((r) => setTimeout(r, 5));
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.deleteEdge(e.id);

	const live = await g.neighborsPage(p.id, { limit: 10 });
	expect(live.rows.length).toBe(1);

	const first = await g.neighborsPage(p.id, { asOf: t0, limit: 1 });
	expect(first.rows.length).toBe(1);
	expect(first.nextCursor).not.toBeNull();
	const second = await g.neighborsPage(p.id, { asOf: t0, limit: 1, cursor: first.nextCursor! });
	expect(second.rows.length).toBe(1);
	expect([...first.rows, ...second.rows].map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
});
