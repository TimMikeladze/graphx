import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { decodeCursor } from '../src/governance.ts';
import { Graph } from '../src/graph.ts';
import { match } from '../src/pattern.ts';
import { init } from '../src/schema.ts';

// P14 — keyset pagination (§19.7). neighbors (single stable key = neighbor id) and
// match (composite row-value key over the selected alias ids). Pages must neither
// overlap nor skip; nextCursor round-trips; ordering deterministic under the key.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

async function freshGraph(): Promise<{ client: Client; g: Graph<typeof SCHEMA> }> {
	const client = createClient({ url: ':memory:' });
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

/** A hub person with `n` outgoing knows edges; returns the hub id + the neighbor ids. */
async function hubWithNeighbors(
	g: Graph<typeof SCHEMA>,
	n: number,
): Promise<{ hub: string; neighbors: string[] }> {
	const hub = await g.addNode({ kind: 'person', props: { name: 'hub' } });
	const neighbors: string[] = [];
	for (let i = 0; i < n; i++) {
		const p = await g.addNode({ kind: 'person', props: { name: `n${i}` } });
		await g.addEdge({ rel: 'knows', src: hub.id, dst: p.id });
		neighbors.push(p.id);
	}
	return { hub: hub.id, neighbors };
}

test('P14 cap: neighbors honors a small maxRows cap', async () => {
	const { client, g } = await freshGraph();
	const { hub } = await hubWithNeighbors(g, 5);
	const capped = await g.neighbors(hub, { limits: { maxRows: 2 } });
	expect(capped.length).toBe(2);
	client.close();
});

test('P14 page: neighborsPage walks every neighbor exactly once across pages', async () => {
	const { client, g } = await freshGraph();
	const { hub, neighbors } = await hubWithNeighbors(g, 5);

	const seen: string[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await g.neighborsPage(hub, { limit: 2, cursor });
		seen.push(...page.rows.map((r) => r.id));
		cursor = page.nextCursor ?? undefined;
		pages++;
		expect(pages).toBeLessThan(10); // guard against a non-terminating cursor
	} while (cursor);

	// every neighbor exactly once (no overlap, no skip), regardless of order
	expect(new Set(seen)).toEqual(new Set(neighbors));
	expect(seen.length).toBe(neighbors.length);
	client.close();
});

test('P14 page: neighborsPage orders by id and the cursor is the last id, opaquely', async () => {
	const { client, g } = await freshGraph();
	const { hub, neighbors } = await hubWithNeighbors(g, 5);
	const sorted = [...neighbors].sort();

	const first = await g.neighborsPage(hub, { limit: 2 });
	expect(first.rows.map((r) => r.id)).toEqual(sorted.slice(0, 2));
	expect(first.nextCursor).not.toBeNull();
	// cursor decodes to the last id of the page (the keyset key)
	expect(decodeCursor(first.nextCursor as string)).toEqual([sorted[1] as string]);

	const second = await g.neighborsPage(hub, { limit: 2, cursor: first.nextCursor as string });
	expect(second.rows.map((r) => r.id)).toEqual(sorted.slice(2, 4));
	client.close();
});

test('P14 page: last neighborsPage returns nextCursor=null', async () => {
	const { client, g } = await freshGraph();
	const { hub } = await hubWithNeighbors(g, 4);
	// page size 4 covers all 4 → no more pages
	const page = await g.neighborsPage(hub, { limit: 4 });
	expect(page.rows.length).toBe(4);
	expect(page.nextCursor).toBeNull();
	client.close();
});

test('P14 page: match.page keysets a flat single-alias result with no overlap/skip', async () => {
	const { client, g } = await freshGraph();
	const { neighbors } = await hubWithNeighbors(g, 5);

	// all person nodes (hub + 5) — page over the single selected alias `p`
	const seen: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await match(SCHEMA, client)
			.node('p', 'person')
			.select('p')
			.then((q) => q.page({ limit: 2, cursor }));
		seen.push(...page.rows.map((r) => r.p.id));
		cursor = page.nextCursor ?? undefined;
	} while (cursor);

	const allPeople = new Set(neighbors);
	// every person appears once; hub included too (6 total)
	expect(seen.length).toBe(6);
	expect(new Set(seen).size).toBe(6);
	for (const n of allPeople) expect(seen).toContain(n);
	client.close();
});

test('P14 page: match.page returns each distinct selected tuple ONCE (no dup) under multi-edge', async () => {
	const { client, g } = await freshGraph();
	const hub = await g.addNode({ kind: 'person', props: { name: 'hub' } });
	const n0 = await g.addNode({ kind: 'person', props: { name: 'n0' } });
	const n1 = await g.addNode({ kind: 'person', props: { name: 'n1' } });
	// TWO knows edges hub->n0 (multi-edge) + one hub->n1: .run() yields a duplicate
	// (hub,n0) row; .page() keysets on (a__id,b__id) which is NOT unique, so without
	// dedup an over-fetched page can hand the caller the same tuple twice.
	await g.addEdge({ rel: 'knows', src: hub.id, dst: n0.id });
	await g.addEdge({ rel: 'knows', src: hub.id, dst: n0.id });
	await g.addEdge({ rel: 'knows', src: hub.id, dst: n1.id });

	const seen: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await match(SCHEMA, client)
			.node('a', 'person')
			.out('knows')
			.node('b', 'person')
			.select('a', 'b')
			.then((q) => q.page({ limit: 2, cursor }));
		for (const row of page.rows) seen.push(`${row.a.id}->${row.b.id}`);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);

	// each distinct (a,b) pair appears exactly once — no duplicate, no skip
	expect(seen.sort()).toEqual([`${hub.id}->${n0.id}`, `${hub.id}->${n1.id}`].sort());
	client.close();
});

test('P14 page: a non-positive limit is rejected with a clear error (no crash)', async () => {
	const { client, g } = await freshGraph();
	const { hub } = await hubWithNeighbors(g, 3);
	await expect(g.neighborsPage(hub, { limit: 0 })).rejects.toThrow(/limit/);
	await expect(g.neighborsPage(hub, { limit: -5 })).rejects.toThrow(/limit/);
	const q = await match(SCHEMA, client).node('p', 'person').select('p');
	await expect(q.page({ limit: 0 })).rejects.toThrow(/limit/);
	client.close();
});

test('P14 page: a malformed cursor is rejected cleanly (not a cryptic internal error)', async () => {
	const { client, g } = await freshGraph();
	const { hub } = await hubWithNeighbors(g, 3);
	const badShape = Buffer.from(JSON.stringify({ x: 1 }), 'utf8').toString('base64');
	await expect(g.neighborsPage(hub, { cursor: badShape })).rejects.toThrow(/cursor/i);
	// wrong arity: a 1-tuple cursor against a 2-alias page
	const oneTuple = Buffer.from(JSON.stringify(['only']), 'utf8').toString('base64');
	const q = await match(SCHEMA, client).node('a', 'person').out('knows').node('b', 'person').select('a', 'b');
	await expect(q.page({ cursor: oneTuple })).rejects.toThrow(/cursor/i);
	client.close();
});

test('P14 page: match.page composite keyset over two aliases never splits a shared-leading-id group', async () => {
	const { client, g } = await freshGraph();
	const { hub, neighbors } = await hubWithNeighbors(g, 5);
	// rows are (hub, neighbor) pairs — all share the SAME leading id (hub). A scalar
	// keyset on the hub id alone would skip the rest of the group after page 1; the
	// composite (hub,neighbor) key must page through all 5 pairs.
	const seenPairs: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await match(SCHEMA, client)
			.node('a', 'person')
			.out('knows')
			.node('b', 'person')
			.select('a', 'b')
			.then((q) => q.page({ limit: 2, cursor }));
		for (const row of page.rows) {
			expect(row.a.id).toBe(hub);
			seenPairs.push(row.b.id);
		}
		cursor = page.nextCursor ?? undefined;
	} while (cursor);

	expect(new Set(seenPairs)).toEqual(new Set(neighbors));
	expect(seenPairs.length).toBe(5);
	client.close();
});
