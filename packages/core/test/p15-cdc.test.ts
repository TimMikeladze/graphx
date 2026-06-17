import { afterAll, expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { changeFeed, diff } from '../src/temporal.ts';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { encodeCursor } from '../src/governance.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { makeTestDb } from './harness.ts';

// P15 — change feed / CDC (§19.10). "The temporal log IS the changelog." changeFeed
// is the tailable sibling of diff(): new versions WHERE valid_from > cursor, ordered
// by (valid_from, ver), keyset-paginated so polling never skips or overlaps — even
// when ≥2 versions share a valid_from (a bare `valid_from > cursor` would skip them).
// Decision (A.3): valid_from-only "new-versions" feed — a pure close/delete (no
// successor row) is NOT surfaced; consumers reconcile closes via diff().

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
	await init(client, 4);
	return client;
}

/** A file-backed graph (deleteEdge uses transaction() — needs a shared on-disk DB). */
async function fileGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

/** Insert a node version directly with an explicit valid_from (ver auto-assigned). */
async function insertNodeVersion(
	client: DbClient,
	id: string,
	props: Record<string, unknown>,
	validFrom: number,
): Promise<void> {
	await client.execute({ sql: 'INSERT OR IGNORE INTO node_identity (id) VALUES (?)', args: [id] });
	await client.execute({
		sql: 'INSERT INTO node_versions (id, kind, props, valid_from) VALUES (?,?,?,?)',
		args: [id, 'person', JSON.stringify(props), validFrom],
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
	expect(feed.nodes.map((r) => String(r.id))).toEqual([a, b]); // ordered by (valid_from, ver)
	expect(feed.edges.length).toBe(0);
	client.close();
});

test('P15 CDC: keyset pages rows sharing a valid_from with NO skip/overlap (≥2 same-ms)', async () => {
	const client = await memClient();
	const a = ulid();
	const b = ulid();
	const c = ulid();
	// A and B share valid_from=1000 (the boundary a bare `valid_from > cursor` would split
	// and SKIP); C is strictly later. ver disambiguates A vs B within the shared ms.
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

	expect(seen).toEqual(ids); // every version once, in (valid_from, ver) order
	client.close();
});

test('P15 CDC: nodes and edges advance on independent cursors', async () => {
	const { client, g } = await fileGraph();
	const p = await g.addNode({ kind: 'person', props: { name: 'p' } });
	const d = await g.addNode({ kind: 'device', props: { type: 'r' } });
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

test('P15 CDC: a pure deleteEdge close is NOT surfaced (valid_from-only); diff reconciles it', async () => {
	const { client, g } = await fileGraph();
	const p = await g.addNode({ kind: 'person', props: { name: 'p' } });
	const d = await g.addNode({ kind: 'device', props: { type: 'r' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });

	const before = await changeFeed(client);
	expect(before.edges.map((r) => String(r.id))).toEqual([e.id]); // the insert version is in the feed
	const eValidFrom = Number(before.edges[0]?.valid_from);

	await g.deleteEdge(e.id); // closes the live row (valid_to=now); NO successor row inserted

	// the close created no new valid_from row → the feed still shows ONLY the insert version,
	// never a close event (valid_from-only semantics, decision A.3).
	const after = await changeFeed(client);
	expect(after.edges.map((r) => String(r.id))).toEqual([e.id]);
	expect(after.edges.length).toBe(1);

	// reconciliation path: diff() DOES surface the close (valid_to moved into the window)
	const closeTs = Number(
		(
			await client.execute({
				sql: 'SELECT valid_to AS t FROM edge_versions WHERE id = ?',
				args: [e.id],
			})
		).rows[0]?.t,
	);
	const d2 = await diff(client, eValidFrom, closeTs);
	expect(d2.edges.map((r) => String(r.id))).toContain(e.id);
	client.close();
});

test('P15 CDC: a single-valued addEdge supersession close is NOT surfaced (only the new INSERT)', async () => {
	const { client, g } = await fileGraph();
	const p = await g.addNode({ kind: 'person', props: { name: 'p' } });
	const d1 = await g.addNode({ kind: 'device', props: { type: 'a' } });
	const d2 = await g.addNode({ kind: 'device', props: { type: 'b' } });
	const e1 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d1.id });
	const e2 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d2.id }); // supersedes e1 (single-valued)

	// the feed shows BOTH edges as INSERTs; superseding e1 moved its valid_to with NO new
	// valid_from row, so the close is invisible to the valid_from-keyed feed (decision A.3).
	const feed = await changeFeed(client);
	expect(feed.edges.map((r) => String(r.id)).sort()).toEqual([e1.id, e2.id].sort());

	// e1 genuinely left the live set (valid_to closed) — reconciled only via diff(), not the feed
	const e1Row = (
		await client.execute({
			sql: 'SELECT valid_from, valid_to FROM edge_versions WHERE id = ?',
			args: [e1.id],
		})
	).rows[0];
	expect(Number(e1Row?.valid_to)).not.toBe(FOREVER); // closed by the supersession
	const d = await diff(client, Number(e1Row?.valid_from), Number(e1Row?.valid_to));
	expect(d.edges.map((r) => String(r.id))).toContain(e1.id);
	client.close();
});

test('P15 CDC: emits RAW stored props (no upcast) — reports the actual written bytes', async () => {
	const client = await memClient();
	const id = ulid();
	// a stored prop bag carrying a schema-version stamp; a read-time upcaster would
	// transform it, but the changelog must report what was literally written.
	const stored = { name: 'orig', _v: 2 };
	await insertNodeVersion(client, id, stored, 1000);

	const feed = await changeFeed(client);
	expect(JSON.parse(String(feed.nodes[0]?.props))).toEqual(stored); // _v intact, not upcast
	// airtight: equals the bytes on disk
	const onDisk = (
		await client.execute({ sql: 'SELECT props FROM node_versions WHERE id = ?', args: [id] })
	).rows[0]?.props;
	expect(String(feed.nodes[0]?.props)).toBe(String(onDisk));
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
	// a 1-tuple cursor (the keyset is the 2-tuple (valid_from, ver))
	const oneTuple = encodeCursor(['1000']);
	await expect(changeFeed(client, { nodes: oneTuple })).rejects.toThrow(/cursor/i);
	// structurally-valid 2-tuples whose strings are not canonical integers must ALSO be
	// rejected as `invalid cursor` — never reach the bind and crash with a libSQL RangeError
	// (which onError would map to 500, not 400). Covers: non-numeric, non-finite, and the
	// empty-string tuple (Number('') === 0 would silently reset the stream to the beginning).
	await expect(changeFeed(client, { nodes: encodeCursor(['abc', 'def']) })).rejects.toThrow(
		/cursor/i,
	);
	await expect(changeFeed(client, { nodes: encodeCursor(['Infinity', '0']) })).rejects.toThrow(
		/cursor/i,
	);
	await expect(changeFeed(client, { nodes: encodeCursor(['', '']) })).rejects.toThrow(/cursor/i);
	client.close();
});

test('P15 CDC: a non-positive limit is rejected with a clear error', async () => {
	const client = await memClient();
	await expect(changeFeed(client, undefined, { limit: 0 })).rejects.toThrow(/limit/);
	await expect(changeFeed(client, undefined, { limit: -3 })).rejects.toThrow(/limit/);
	client.close();
});
