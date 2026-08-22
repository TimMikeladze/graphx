import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { InMemoryEvents, type GraphEventOptions } from '../src/events.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { outboxHead, outboxTail, pruneOutbox } from '../src/temporal.ts';
import { makeTestDb, TEST_DRIVER } from './harness.ts';

// Eventing Layer 2 — the durable graph_outbox. Every mutation co-writes an event row in its OWN
// transaction (atomic with the version rows), tailed by outboxTail over one monotonic `seq`. The
// feed is DELETE-INCLUSIVE (unlike changeFeed): deleteNode/deleteEdge/supersede appear as rows.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }), device: z.object({ kind: z.string() }) },
	edges: {
		owns: { from: 'person', to: 'device' },
		licensed: { from: 'person', to: 'device', single: true },
	},
});

const teardowns: Array<() => Promise<void>> = [];

async function makeGraph(events?: GraphEventOptions): Promise<Graph<typeof SCHEMA>> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, 4);
	return new Graph(client, SCHEMA, undefined, events);
}

/** Run the canonical mutation sequence (10 events, incl. 3 feed-blind closes) on an outbox graph. */
async function seeded(): Promise<{ g: Graph<typeof SCHEMA>; ids: Record<string, string> }> {
	const g = await makeGraph({ outbox: true });
	const p = await g.addNode({ type: 'person', data: { name: 'p' } }); // node.create
	const d1 = await g.addNode({ type: 'device', data: { kind: 'a' } }); // node.create
	const d2 = await g.addNode({ type: 'device', data: { kind: 'b' } }); // node.create
	const owns = await g.addEdge({ rel: 'owns', src: p.id, dst: d1.id }); // edge.create
	await g.updateNode(p.id, { data: { name: 'p2' } }); // node.update
	const lic1 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d1.id }); // edge.create
	await g.addEdge({ rel: 'licensed', src: p.id, dst: d2.id }); // edge.supersede(lic1) + edge.create
	await g.deleteEdge(owns.id); // edge.delete (pure close)
	await g.deleteNode(d1.id); // node.delete (pure close)
	return { g, ids: { p: p.id, d1: d1.id, d2: d2.id, owns: owns.id, lic1: lic1.id } };
}

afterAll(async () => {
	for (const t of teardowns) await t();
});

test('tail is delete-inclusive, seq-ordered, and every event carries a seq', async () => {
	const { g, ids } = await seeded();
	const page = await outboxTail(g.raw);

	expect(page.events).toHaveLength(10);
	expect(page.nextCursor).toBeNull();
	expect(page.events.every((e) => typeof e.seq === 'number')).toBe(true);

	const seqs = page.events.map((e) => e.seq as number);
	expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // strictly seq-ordered

	const ops = page.events.map((e) => e.op);
	// The pure closes the valid_from CDC feed can NEVER surface:
	expect(ops).toContain('edge.supersede');
	expect(ops).toContain('edge.delete');
	expect(ops).toContain('node.delete');

	// The two trailing deletes, in mutation order, with endpoints/labels intact.
	expect(page.events.at(-2)).toMatchObject({ op: 'edge.delete', id: ids.owns, shape: 'close' });
	expect(page.events.at(-1)).toMatchObject({
		op: 'node.delete',
		id: ids.d1,
		label: 'device',
		shape: 'close',
	});
});

test('keyset pagination drains the full stream without skip or overlap', async () => {
	const { g } = await seeded();
	const collected: number[] = [];
	let cursor: { seq?: number } = {};
	for (;;) {
		const page = await outboxTail(g.raw, cursor, { limit: 3 });
		for (const e of page.events) collected.push(e.seq as number);
		if (page.nextCursor == null) break;
		cursor = { seq: page.nextCursor };
	}
	expect(collected).toHaveLength(10);
	expect(new Set(collected).size).toBe(10); // no duplicates
	expect(collected).toEqual([...collected].sort((a, b) => a - b));
});

test('entity and ops filters', async () => {
	const { g } = await seeded();

	const nodesOnly = await outboxTail(g.raw, {}, { entity: 'node' });
	expect(nodesOnly.events.every((e) => e.entity === 'node')).toBe(true);
	// 3 create + 1 update + 1 delete = 5 node events
	expect(nodesOnly.events).toHaveLength(5);

	const deletes = await outboxTail(g.raw, {}, { ops: ['edge.delete', 'node.delete'] });
	expect(deletes.events.map((e) => e.op).sort()).toEqual(['edge.delete', 'node.delete']);
});

test('pruneOutbox drops rows below a seq and returns the count', async () => {
	const { g } = await seeded();
	const all = await outboxTail(g.raw);
	const midSeq = all.events[5]?.seq as number;
	const expectedDeleted = all.events.filter((e) => (e.seq as number) < midSeq).length;

	const deleted = await pruneOutbox(g.raw, midSeq);
	expect(deleted).toBe(expectedDeleted);

	const after = await outboxTail(g.raw);
	expect(after.events).toHaveLength(all.events.length - expectedDeleted);
	expect(after.events[0]?.seq).toBe(midSeq); // the pruned floor is now the first row
});

test('outbox is opt-in: without it, the table exists but stays empty', async () => {
	const g = await makeGraph(); // no events / no outbox
	await g.addNode({ type: 'person', data: { name: 'x' } });
	const page = await outboxTail(g.raw); // table was created by init() regardless
	expect(page.events).toHaveLength(0);
});

test('outboxTail rejects a bad limit and a non-integer cursor', async () => {
	const g = await makeGraph({ outbox: true });
	await expect(outboxTail(g.raw, {}, { limit: 0 })).rejects.toThrow('positive integer');
	await expect(outboxTail(g.raw, { seq: 1.5 })).rejects.toThrow('invalid cursor');
});

test('outbox rows carry provenance and default to null for user writes', async () => {
	const g = await makeGraph({ outbox: true });
	await g.addNode({ type: 'person', data: { name: 'user write' } });
	const derived = g.withEventSource('trigger:demo');
	await derived.addNode({ type: 'person', data: { name: 'derived write' } });

	const page = await outboxTail(g.raw);
	expect(page.events).toHaveLength(2);
	expect(page.events[0]?.source).toBeUndefined();
	expect(page.events[1]?.source).toBe('trigger:demo');
});

test('withEventSource shares the client and stamps the in-proc sink too', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ outbox: true, sink });
	const derived = g.withEventSource('trigger:demo');

	expect(derived.raw).toBe(g.raw);
	expect(derived.schema).toBe(g.schema);

	await g.addNode({ type: 'person', data: { name: 'a' } });
	await derived.addNode({ type: 'person', data: { name: 'b' } });

	expect(sink.events).toHaveLength(2);
	expect(sink.events[0]?.source).toBeUndefined();
	expect(sink.events[1]?.source).toBe('trigger:demo');
});

// Postgres-only: the xmin-horizon gate must still surface committed rows (it withholds only
// rows from still-in-flight transactions). libSQL needs no gate and is covered above.
test.skipIf(TEST_DRIVER !== 'postgres')(
	'postgres: committed events pass the xmin gate',
	async () => {
		const { g } = await seeded();
		const page = await outboxTail(g.raw);
		expect(page.events).toHaveLength(10);
		expect(page.events.every((e) => typeof e.seq === 'number')).toBe(true);
	},
);

/** Insert one raw outbox row inside `tx` (IDENTITY assigns `seq` at INSERT). */
async function insertOutbox(
	tx: { execute: (s: unknown) => Promise<unknown> },
	id: string,
): Promise<void> {
	await tx.execute({
		sql: `INSERT INTO graph_outbox (op, entity, id, label, src, dst, shape, ts) VALUES (?,?,?,?,?,?,?,?)`,
		args: ['node.create', 'node', id, 'person', null, null, 'insert', Date.now()],
	});
}

// Postgres-only: THE reason the gate exists. IDENTITY `seq` is assigned at INSERT, so a txn with a
// LOWER seq can commit AFTER one with a higher seq. A naive `seq > cursor` tail would return the
// higher-seq row, advance the cursor past it, and skip the lower-seq row forever once it commits.
// The xmin-horizon gate withholds the higher-seq row until the lower-seq txn resolves ⇒ no skip.
test.skipIf(TEST_DRIVER !== 'postgres')(
	'postgres: the xmin gate never skips a lower-seq row that commits out of order',
	async () => {
		const td = makeTestDb();
		teardowns.push(td.teardown);
		await init(td.client, 4);
		const reader = (td.sibling as () => typeof td.client)();
		const writerB = (td.sibling as () => typeof td.client)();

		// A inserts first (lower seq) and stays OPEN; B inserts second (higher seq) and commits first.
		const txA = await td.client.transaction('write');
		await insertOutbox(txA, 'a');
		const txB = await writerB.transaction('write');
		await insertOutbox(txB, 'b');
		await txB.commit();

		// The hazard is real: a naive seq-keyset sees only 'b' while 'a' is still uncommitted.
		const naive = await reader.execute({
			sql: 'SELECT id FROM graph_outbox ORDER BY seq',
			args: [],
		});
		expect((naive.rows as Array<{ id: unknown }>).map((r) => String(r.id))).toEqual(['b']);

		// The gate withholds 'b' entirely until 'a' resolves — so a cursor can never advance past 'a'.
		const held = await outboxTail(reader);
		expect(held.events).toHaveLength(0);

		await txA.commit();

		// Both now surface, in seq order, from the beginning — nothing was skipped.
		const drained = await outboxTail(reader);
		expect(drained.events.map((e) => e.id)).toEqual(['a', 'b']);
	},
);

// Postgres-only: the SSE since=now START cursor must apply the SAME xmin gate as the tail. A bare
// MAX(seq) would return a committed higher-seq row while a lower-seq txn is still in flight, strand
// the start cursor above it, and skip that event forever once it commits. outboxHead gates it.
test.skipIf(TEST_DRIVER !== 'postgres')(
	'postgres: outboxHead (since=now start) never strands an in-flight lower-seq event',
	async () => {
		const td = makeTestDb();
		teardowns.push(td.teardown);
		await init(td.client, 4);
		const reader = (td.sibling as () => typeof td.client)();
		const writerB = (td.sibling as () => typeof td.client)();

		// A inserts first (LOWER seq) and stays OPEN; B inserts second (HIGHER seq) and commits.
		const txA = await td.client.transaction('write');
		await insertOutbox(txA, 'a');
		const txB = await writerB.transaction('write');
		await insertOutbox(txB, 'b');
		await txB.commit();

		// The gated head withholds 'b' while A is in flight, so the start cursor stays below 'a'
		// (a bare MAX(seq) would return b's seq here and lose 'a').
		const cursor = await outboxHead(reader);
		await txA.commit();

		const page = await outboxTail(reader, { seq: cursor });
		const ids = page.events.map((e) => e.id);
		expect(ids).toContain('a');
		expect(ids).toContain('b');
	},
);
