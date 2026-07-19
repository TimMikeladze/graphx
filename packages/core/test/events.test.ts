import { afterAll, expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import {
	type GraphEvent,
	type GraphEventOptions,
	GraphEventBus,
	InMemoryEvents,
} from '../src/events.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { makeTestDb } from './harness.ts';

// Eventing Layer 1 — the in-proc emitter. Every public mutation emits a typed event AFTER the
// write commits (post-commit, phantom-free), INCLUDING the pure closes (delete/supersede) the
// valid_from CDC feed is structurally blind to (decision A.3). No schema, no outbox here.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }), device: z.object({ kind: z.string() }) },
	edges: {
		owns: { from: 'person', to: 'device' }, // multi-valued (batch path)
		licensed: { from: 'person', to: 'device', single: true }, // single-valued (conditional-close)
	},
});

const teardowns: Array<() => Promise<void>> = [];

// deleteNode/deleteEdge/updateNode/single-addEdge use interactive transaction() → need a file DB.
async function makeGraph(events?: GraphEventOptions): Promise<Graph<typeof SCHEMA>> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, 4);
	return new Graph(client, SCHEMA, undefined, events);
}

afterAll(async () => {
	for (const t of teardowns) await t();
});

test('addNode emits node.create/insert post-commit', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ sink });
	const n = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	expect(sink.events).toHaveLength(1);
	expect(sink.events[0]).toMatchObject({
		op: 'node.create',
		entity: 'node',
		id: n.id,
		label: 'person',
		shape: 'insert',
	});
	expect((sink.events[0] as GraphEvent).ts).toBeGreaterThan(0);
	expect((sink.events[0] as GraphEvent).src).toBeUndefined();
});

test('addEdge (multi-valued) emits edge.create/insert with endpoints', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ sink });
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d = await g.addNode({ type: 'device', data: { kind: 'x' } });
	sink.events.length = 0;
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });
	expect(sink.events).toHaveLength(1);
	expect(sink.events[0]).toMatchObject({
		op: 'edge.create',
		entity: 'edge',
		id: e.id,
		label: 'owns',
		shape: 'insert',
		src: p.id,
		dst: d.id,
	});
});

test('single-valued addEdge: first insert has NO supersede; the second closes the prior', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ sink });
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d1 = await g.addNode({ type: 'device', data: { kind: 'a' } });
	const d2 = await g.addNode({ type: 'device', data: { kind: 'b' } });

	sink.events.length = 0;
	const e1 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d1.id });
	// No prior live (p, licensed) edge ⇒ no phantom supersede, just the create.
	expect(sink.events).toHaveLength(1);
	expect(sink.events[0]).toMatchObject({ op: 'edge.create', id: e1.id, shape: 'insert' });

	sink.events.length = 0;
	const e2 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d2.id });
	// The prior edge is superseded (a pure close the CDC feed misses) + the successor inserts.
	expect(sink.events).toHaveLength(2);
	expect(sink.events[0]).toMatchObject({
		op: 'edge.supersede',
		id: e1.id, // the CLOSED prior edge
		label: 'licensed',
		shape: 'close',
		src: p.id,
		dst: d1.id, // the prior edge's endpoints
	});
	expect(sink.events[1]).toMatchObject({
		op: 'edge.create',
		id: e2.id,
		shape: 'insert',
		dst: d2.id,
	});
});

test('updateNode emits node.update/insert', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ sink });
	const n = await g.addNode({ type: 'person', data: { name: 'a' } });
	sink.events.length = 0;
	await g.updateNode(n.id, { data: { name: 'b' } });
	expect(sink.events).toHaveLength(1);
	expect(sink.events[0]).toMatchObject({
		op: 'node.update',
		id: n.id,
		label: 'person',
		shape: 'insert',
	});
});

test('deleteNode emits node.delete/close with the node label', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ sink });
	const n = await g.addNode({ type: 'person', data: { name: 'gone' } });
	sink.events.length = 0;
	await g.deleteNode(n.id);
	expect(sink.events).toHaveLength(1);
	expect(sink.events[0]).toMatchObject({
		op: 'node.delete',
		id: n.id,
		label: 'person',
		shape: 'close',
	});
});

test('deleteEdge emits edge.delete/close with endpoints (the feed-blind case)', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ sink });
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d = await g.addNode({ type: 'device', data: { kind: 'x' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });
	sink.events.length = 0;
	await g.deleteEdge(e.id);
	expect(sink.events).toHaveLength(1);
	expect(sink.events[0]).toMatchObject({
		op: 'edge.delete',
		id: e.id,
		label: 'owns',
		shape: 'close',
		src: p.id,
		dst: d.id,
	});
});

test('a throwing listener never breaks the mutation', async () => {
	const bus = new GraphEventBus();
	bus.onAny(() => {
		throw new Error('boom');
	});
	const g = await makeGraph({ sink: bus });
	const n = await g.addNode({ type: 'person', data: { name: 'ok' } });
	// The write committed despite the listener throwing.
	expect(await g.getNode(n.id)).not.toBeNull();
});

test('GraphEventBus: per-op subscription, onAny, and unsubscribe', async () => {
	const bus = new GraphEventBus();
	const creates: GraphEvent[] = [];
	const all: GraphEvent[] = [];
	const off = bus.on('node.create', (e) => creates.push(e));
	bus.onAny((e) => all.push(e));

	const g = await makeGraph({ sink: bus });
	const n = await g.addNode({ type: 'person', data: { name: 'x' } });
	expect(creates).toHaveLength(1);
	expect(all).toHaveLength(1);

	await g.deleteNode(n.id); // node.delete — not a node.create
	expect(creates).toHaveLength(1);
	expect(all).toHaveLength(2);

	off(); // unsubscribe the per-op listener
	await g.addNode({ type: 'person', data: { name: 'y' } });
	expect(creates).toHaveLength(1); // no longer delivered
	expect(all).toHaveLength(3); // onAny still live
});

test('no events option ⇒ mutations still work (NOOP sink, byte-identical)', async () => {
	const g = await makeGraph(); // no events arg
	const n = await g.addNode({ type: 'person', data: { name: 'silent' } });
	expect(await g.getNode(n.id)).not.toBeNull();
});

test('single-valued addEdge emits one supersede per closed live edge (missing-index safety)', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ sink });
	const p = await g.addNode({ type: 'person', data: { name: 'p' } });
	const d1 = await g.addNode({ type: 'device', data: { kind: 'a' } });
	const d2 = await g.addNode({ type: 'device', data: { kind: 'b' } });
	const d3 = await g.addNode({ type: 'device', data: { kind: 'c' } });
	const e1 = await g.addEdge({ rel: 'licensed', src: p.id, dst: d1.id });

	// Force a SECOND live (p, licensed) edge WITHOUT the ux_single index (constraints not
	// materialized) -- the unmaterialized-constraint / concurrent-race state. The next addEdge must
	// close BOTH and report BOTH closes, not just the newest.
	const e2id = ulid();
	await g.raw.batch(
		[
			{ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [e2id] },
			{
				sql: 'INSERT INTO edge_versions (id, src, dst, rel, weight, data, source, valid_from) VALUES (?,?,?,?,?,?,?,?)',
				args: [e2id, p.id, d2.id, 'licensed', 1.0, '{}', null, Date.now()],
			},
		],
		'write',
	);

	sink.events.length = 0;
	await g.addEdge({ rel: 'licensed', src: p.id, dst: d3.id });
	const supersedes = sink.byOp('edge.supersede');
	expect(supersedes.map((e) => e.id).sort()).toEqual([e1.id, e2id].sort());
	expect(sink.byOp('edge.create')).toHaveLength(1);
});
