import { afterAll, expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { bulkLoad } from '../../src/core/bulk.ts';
import { changeFeed, diff } from '../../src/core/temporal.ts';
import { FOREVER } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { encodeCursor } from '../../src/core/governance.ts';
import { Graph } from '../../src/core/graph.ts';
import { init } from '../../src/core/schema.ts';
import { insertOrIgnoreSql, makeTestDb } from './harness.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

// P15 — change feed / CDC (§19.10). "The temporal log IS the changelog." changeFeed
// is the tailable sibling of diff(): new versions WHERE ver > cursor, in insertion
// order, keyset-paginated so polling never skips or overlaps — and a row written with
// a valid_from older than the cursor (a backdated bulkLoad) is still emitted.
// Every write inserts rows (a delete inserts the closed remainder of what it ended), so deletes
// and supersessions reach the feed too.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }), device: z.object({ type: z.string() }) },
	edges: {
		owns: { from: 'person', to: 'device' },
		knows: { from: 'person', to: 'person' },
		licensed: { from: 'person', to: 'device', single: true }, // cardinality 1 per source (§19.5)
	},
});

const teardowns: Array<() => Promise<void>> = [];

/** A pure :memory: client (read-only CDC + raw inserts; no transactions). */
async function memClient(): Promise<DbClient> {
	const client = makeTestDb().client;
	await init(client, hashEmbed(4));
	return client;
}

/** A file-backed graph (deleteEdge uses transaction() — needs a shared on-disk DB). */
async function fileGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, hashEmbed(4));
	return { client, g: new Graph(client, SCHEMA) };
}

/** Insert a node version directly with an explicit valid_from (ver auto-assigned). */
async function insertNodeVersion(
	client: DbClient,
	id: string,
	data: Record<string, unknown>,
	validFrom: number,
): Promise<void> {
	await client.execute({
		sql: insertOrIgnoreSql(client, 'node_identity', 'id', '(?)'),
		args: [id],
	});
	await client.execute({
		sql: 'INSERT INTO node_versions (id, type, data, valid_from) VALUES (?,?,?,?)',
		args: [id, 'person', JSON.stringify(data), validFrom],
	});
}

afterAll(async () => {
	for (const teardown of teardowns) await teardown();
});

test('P15 CDC: initial (no cursor) returns all node + edge versions from the beginning', async () => {
	const client = await memClient();
	const a = ulid();
	const b = ulid();
	await insertNodeVersion(client, a, { name: 'a' }, 1000);
	await insertNodeVersion(client, b, { name: 'b' }, 2000);

	const feed = await changeFeed(client);
	expect(feed.nodes.map((r) => String(r.id))).toEqual([a, b]); // insertion (ver) order
	expect(feed.edges.length).toBe(0);
	client.close();
});

test('P15 CDC: keyset pages rows sharing a valid_from with NO skip/overlap (≥2 same-ms)', async () => {
	const client = await memClient();
	const a = ulid();
	const b = ulid();
	const c = ulid();
	// A and B share valid_from=1000; the ver keyset pages them apart without a skip.
	await insertNodeVersion(client, a, { name: 'a' }, 1000);
	await insertNodeVersion(client, b, { name: 'b' }, 1000);
	await insertNodeVersion(client, c, { name: 'c' }, 2000);

	const seen: string[] = [];
	let cursor: string | null | undefined;
	let pages = 0;
	do {
		const page = await changeFeed(client, cursor ? { nodes: cursor } : undefined, { limit: 1 });
		seen.push(...page.nodes.map((r) => String(r.id)));
		cursor = page.nextCursor.nodes;
		pages++;
		expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
	} while (cursor);

	// all three surfaced exactly once — both same-ms rows included, none skipped, none doubled
	expect(seen.length).toBe(3);
	expect(new Set(seen)).toEqual(new Set([a, b, c]));
	// C (valid_from=2000) is strictly after both A and B (valid_from=1000)
	expect(seen[2]).toBe(c);
	client.close();
});

test('P15 CDC: polling with nextCursor across many versions yields no overlap/no skip', async () => {
	const client = await memClient();
	const ids: string[] = [];
	for (let i = 0; i < 7; i++) {
		const id = ulid();
		ids.push(id);
		await insertNodeVersion(client, id, { name: `n${i}` }, 1000 + i);
	}

	const seen: string[] = [];
	let cursor: string | null | undefined;
	do {
		const page = await changeFeed(client, cursor ? { nodes: cursor } : undefined, { limit: 2 });
		seen.push(...page.nodes.map((r) => String(r.id)));
		cursor = page.nextCursor.nodes;
	} while (cursor);

	expect(seen).toEqual(ids); // every version once, in ver order
	client.close();
});

test('P15 CDC: nodes and edges advance on independent cursors', async () => {
	const { client, g } = await fileGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });

	// page size 1: 2 node versions, 1 edge version → each stream keysets its OWN ver
	// sequence (a single shared cursor could not keyset both).
	const first = await changeFeed(client, undefined, { limit: 1 });
	expect(first.nodes.length).toBe(1);
	expect(first.edges.length).toBe(1);
	expect(first.nextCursor.nodes).not.toBeNull(); // a 2nd node version remains
	expect(first.nextCursor.edges).toBeNull(); // the only edge version was consumed (caught up)

	// advance the node stream alone via its own cursor; the edge stream is untouched
	const next = await changeFeed(client, { nodes: first.nextCursor.nodes as string }, { limit: 1 });
	expect(next.nodes.length).toBe(1); // the second node version
	expect(next.nextCursor.nodes).toBeNull(); // node stream now exhausted too
	client.close();
});

test('P15 CDC: a deleteEdge reaches the feed as the closed remainder of the edge', async () => {
	const { client, g } = await fileGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });

	const before = await changeFeed(client);
	expect(before.edges.map((r) => String(r.id))).toEqual([e.id]);
	const cursor = encodeCursor([String(before.edges[0]!.ver)]);

	// a delete never edits the open row: it supersedes it and records its closed part as a new
	// row, so a tailing consumer sees the close
	await g.deleteEdge(e.id);
	const after = await changeFeed(client, { edges: cursor });
	expect(after.edges.map((r) => String(r.id))).toEqual([e.id]);
	expect(Number(after.edges[0]!.valid_to)).toBeLessThan(FOREVER);

	// diff reports the close too
	const d2 = await diff(
		client,
		Number(before.edges[0]!.valid_from),
		Number(after.edges[0]!.valid_to),
	);
	expect(d2.edges.map((r) => String(r.id))).toContain(e.id);
	client.close();
});

test('P15 CDC: a single-valued addEdge supersession reaches the feed', async () => {
	const { client, g } = await fileGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d1 = await g.addNode({ type: 'device', data: { type: 'a' } });
	const d2 = await g.addNode({ type: 'device', data: { type: 'b' } });
	const e1 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d1.id });
	const cursor = encodeCursor([String((await changeFeed(client)).edges.at(-1)!.ver)]);
	const e2 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d2.id }); // supersedes e1

	// e1's closed remainder, then e2, in write order
	const feed = await changeFeed(client, { edges: cursor });
	expect(feed.edges.map((r) => String(r.id))).toEqual([e1.id, e2.id]);
	expect(Number(feed.edges[0]!.valid_to)).toBeLessThan(FOREVER);
	expect(Number(feed.edges[1]!.valid_to)).toBe(FOREVER);
	client.close();
});

test('P15 CDC: emits RAW stored data (no upcast) — reports the actual written bytes', async () => {
	const client = await memClient();
	const id = ulid();
	// a stored prop bag carrying a schema-version stamp; a read-time upcaster would
	// transform it, but the changelog must report what was literally written.
	const stored = { name: 'orig', _v: 2 };
	await insertNodeVersion(client, id, stored, 1000);

	const feed = await changeFeed(client);
	expect(JSON.parse(String(feed.nodes[0]?.data))).toEqual(stored); // _v intact, not upcast
	// airtight: equals the bytes on disk
	const onDisk = (
		await client.execute({ sql: 'SELECT data FROM node_versions WHERE id = ?', args: [id] })
	).rows[0]?.data;
	expect(String(feed.nodes[0]?.data)).toBe(String(onDisk));
	client.close();
});

test('P15 CDC: honors the maxRows cap (§19.2)', async () => {
	const client = await memClient();
	for (let i = 0; i < 5; i++) await insertNodeVersion(client, ulid(), { name: `n${i}` }, 1000 + i);

	const page = await changeFeed(client, undefined, { limits: { maxRows: 2 } });
	expect(page.nodes.length).toBe(2); // capped below the 5 available
	expect(page.nextCursor.nodes).not.toBeNull(); // more remain
	client.close();
});

test('P15 CDC: malformed and wrong-arity cursors are rejected cleanly', async () => {
	const client = await memClient();
	await insertNodeVersion(client, ulid(), { name: 'x' }, 1000);
	await expect(changeFeed(client, { nodes: 'not-base64-json!!' })).rejects.toThrow(/cursor/i);
	// a 2-tuple cursor (the keyset is the 1-tuple (ver))
	const twoTuple = encodeCursor(['1000', '1']);
	await expect(changeFeed(client, { nodes: twoTuple })).rejects.toThrow(/cursor/i);
	// structurally-valid 1-tuples whose strings are not canonical integers must ALSO be
	// rejected as `invalid cursor` — never reach the bind and crash with a libSQL RangeError
	// (which onError would map to 500, not 400). Covers: non-numeric, non-finite, and the
	// empty-string tuple (Number('') === 0 would silently reset the stream to the beginning).
	await expect(changeFeed(client, { nodes: encodeCursor(['abc']) })).rejects.toThrow(/cursor/i);
	await expect(changeFeed(client, { nodes: encodeCursor(['Infinity']) })).rejects.toThrow(
		/cursor/i,
	);
	await expect(changeFeed(client, { nodes: encodeCursor(['']) })).rejects.toThrow(/cursor/i);
	client.close();
});

test('P15 CDC: a non-positive limit is rejected with a clear error', async () => {
	const client = await memClient();
	await expect(changeFeed(client, undefined, { limit: 0 })).rejects.toThrow(/limit/);
	await expect(changeFeed(client, undefined, { limit: -3 })).rejects.toThrow(/limit/);
	client.close();
});

test('P15 CDC: a backdated bulkLoad row written after the cursor is still emitted', async () => {
	const client = await memClient();
	const live = ulid();
	await insertNodeVersion(client, live, { name: 'live' }, Date.now());
	const first = await changeFeed(client);
	expect(first.nodes.map((r) => String(r.id))).toEqual([live]);
	// a tailing consumer resumes from the last row it saw
	const cursor = encodeCursor([String(first.nodes[0]!.ver)]);

	const { ids } = await bulkLoad(client, SCHEMA, [
		{ type: 'person', data: { name: 'from 1992' }, validFrom: Date.UTC(1992, 0, 1) },
	]);
	const next = await changeFeed(client, { nodes: cursor });
	expect(next.nodes.map((r) => String(r.id))).toEqual(ids);
	client.close();
});

test('P15 CDC: ver is never reused after the newest version is deleted', async () => {
	const client = await memClient();
	await insertNodeVersion(client, ulid(), { name: 'a' }, 1000);
	const b = ulid();
	await insertNodeVersion(client, b, { name: 'b' }, 2000);
	const seen = await changeFeed(client);
	const cursor = encodeCursor([String(seen.nodes[1]!.ver)]);
	// a purge hard-deletes rows; the next insert must not take the purged row's ver, or a
	// consumer already past it would never see the new row
	await client.execute({ sql: 'DELETE FROM node_versions WHERE id = ?', args: [b] });
	const c = ulid();
	await insertNodeVersion(client, c, { name: 'c' }, 3000);
	const next = await changeFeed(client, { nodes: cursor });
	expect(next.nodes.map((r) => String(r.id))).toEqual([c]);
	client.close();
});
