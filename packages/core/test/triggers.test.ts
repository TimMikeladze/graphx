import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import type { GraphEvent } from '../src/events.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { deadLetters, matchesTrigger, pruneDeadLetters, TriggerRunner } from '../src/triggers.ts';
import { makeTestDb, TEST_DRIVER } from './harness.ts';

// Eventing Layer 3 — declarative triggers over the durable graph_outbox. Every test drives the
// runner through `runOnce()` rather than `start()`, so nothing here depends on wall-clock timing.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

const teardowns: Array<() => Promise<void>> = [];

async function makeGraph(): Promise<Graph<typeof SCHEMA>> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, 4);
	return new Graph(client, SCHEMA, undefined, { outbox: true });
}

const SAMPLE: GraphEvent = {
	seq: 7,
	op: 'node.create',
	entity: 'node',
	id: '01J000000000000000000000AA',
	label: 'person',
	shape: 'insert',
	ts: 1_700_000_000_000,
};

const EDGE_CLOSE: GraphEvent = {
	seq: 8,
	op: 'edge.delete',
	entity: 'edge',
	id: '01J000000000000000000000BB',
	label: 'knows',
	shape: 'close',
	ts: 1_700_000_000_001,
	src: 'a',
	dst: 'b',
};

test('an empty match accepts any user write and rejects a trigger write', () => {
	expect(matchesTrigger(SAMPLE, {})).toBe(true);
	expect(matchesTrigger({ ...SAMPLE, source: 'trigger:x' }, {})).toBe(false);
});

test('op, entity, label and shape narrow the match', () => {
	expect(matchesTrigger(SAMPLE, { op: 'node.create' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { op: 'node.delete' })).toBe(false);
	expect(matchesTrigger(SAMPLE, { op: ['node.delete', 'node.create'] })).toBe(true);

	expect(matchesTrigger(SAMPLE, { entity: 'node' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { entity: 'edge' })).toBe(false);

	expect(matchesTrigger(SAMPLE, { label: 'person' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { label: ['device', 'person'] })).toBe(true);
	expect(matchesTrigger(SAMPLE, { label: 'device' })).toBe(false);

	expect(matchesTrigger(SAMPLE, { shape: 'insert' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { shape: 'close' })).toBe(false);
	expect(matchesTrigger(EDGE_CLOSE, { entity: 'edge', shape: 'close', label: 'knows' })).toBe(true);
});

test('source selects between user writes, a specific tag, and everything', () => {
	const tagged = { ...SAMPLE, source: 'trigger:reembed' };
	expect(matchesTrigger(tagged, { source: 'any' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { source: 'any' })).toBe(true);

	expect(matchesTrigger(tagged, { source: 'trigger:reembed' })).toBe(true);
	expect(matchesTrigger(tagged, { source: 'trigger:other' })).toBe(false);
	expect(matchesTrigger(SAMPLE, { source: 'trigger:reembed' })).toBe(false);

	expect(matchesTrigger(SAMPLE, { source: 'user' })).toBe(true);
	expect(matchesTrigger(tagged, { source: 'user' })).toBe(false);
});

test('every clause must hold, not just one', () => {
	expect(matchesTrigger(SAMPLE, { op: 'node.create', label: 'device' })).toBe(false);
});

afterAll(async () => {
	for (const t of teardowns) await t();
});

test('dead letters are readable newest-first and filterable by subscription', async () => {
	const g = await makeGraph();
	const insert = async (subscription: string, createdAt: number) => {
		await g.raw.execute({
			sql: `INSERT INTO trigger_dead_letters
			        (id, subscription, trigger_name, seq, event, error, attempts, created_at)
			      VALUES (?,?,?,?,?,?,?,?)`,
			args: [
				`dl-${subscription}-${createdAt}`,
				subscription,
				'reembed',
				SAMPLE.seq as number,
				JSON.stringify(SAMPLE),
				'boom',
				3,
				createdAt,
			],
		});
	};
	await insert('a', 1000);
	await insert('a', 2000);
	await insert('b', 3000);

	const all = await deadLetters(g.raw);
	expect(all).toHaveLength(3);
	expect(all.map((d) => d.createdAt)).toEqual([3000, 2000, 1000]);
	expect(all[0]?.event).toEqual(SAMPLE); // round-trips through JSON
	expect(all[0]?.triggerName).toBe('reembed');
	expect(all[0]?.attempts).toBe(3);
	expect(all[0]?.error).toBe('boom');

	const onlyA = await deadLetters(g.raw, { subscription: 'a' });
	expect(onlyA.map((d) => d.createdAt)).toEqual([2000, 1000]);

	const recent = await deadLetters(g.raw, { since: 2000 });
	expect(recent.map((d) => d.createdAt)).toEqual([3000, 2000]);

	expect(await deadLetters(g.raw, { limit: 1 })).toHaveLength(1);
});

test('pruneDeadLetters drops rows older than the watermark', async () => {
	const g = await makeGraph();
	for (const createdAt of [100, 200, 300]) {
		await g.raw.execute({
			sql: `INSERT INTO trigger_dead_letters
			        (id, subscription, trigger_name, seq, event, error, attempts, created_at)
			      VALUES (?,?,?,?,?,?,?,?)`,
			args: [`dl-${createdAt}`, 's', 't', 1, JSON.stringify(SAMPLE), 'boom', 1, createdAt],
		});
	}
	expect(await pruneDeadLetters(g.raw, 300)).toBe(2);
	expect(await deadLetters(g.raw)).toHaveLength(1);
	expect(() => pruneDeadLetters(g.raw, 1.5)).toThrow();
});

test('a matching in-proc action fires and receives a source-tagged graph', async () => {
	const g = await makeGraph();
	const seen: GraphEvent[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-basic',
		start: 'beginning',
		triggers: [
			{
				name: 'record',
				match: { op: 'node.create', label: 'person' },
				action: async (event, graph) => {
					seen.push(event);
					await graph.addNode({ type: 'person', data: { name: 'derived' } });
				},
			},
		],
	});

	await g.addNode({ type: 'person', data: { name: 'seed' } });
	const first = await runner.runOnce();

	expect(first.delivered).toBe(1);
	expect(first.deadLettered).toBe(0);
	expect(seen).toHaveLength(1);
	expect(seen[0]?.label).toBe('person');

	// The action's own write is tagged, so the same trigger does not match it.
	const second = await runner.runOnce();
	expect(second.delivered).toBe(0);
	expect(seen).toHaveLength(1);
	expect(second.drained).toBe(true);
});

test('pure closes fire triggers — the reason this rides the outbox', async () => {
	const g = await makeGraph();
	const closes: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-closes',
		start: 'beginning',
		triggers: [
			{
				name: 'on-close',
				match: { shape: 'close' },
				action: (event) => {
					closes.push(event.op);
				},
			},
		],
	});

	const a = await g.addNode({ type: 'person', data: { name: 'a' } });
	const b = await g.addNode({ type: 'person', data: { name: 'b' } });
	const e = await g.addEdge({ rel: 'knows', src: a.id, dst: b.id });
	await g.deleteEdge(e.id);
	await g.deleteNode(a.id);

	await runner.runOnce();
	expect(closes).toEqual(['edge.delete', 'node.delete']);
});

test('start defaults to now, skipping events that predate the first poll', async () => {
	const g = await makeGraph();
	await g.addNode({ type: 'person', data: { name: 'before' } });

	const seen: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-now',
		triggers: [{ name: 'record', match: {}, action: (e) => void seen.push(e.id) }],
	});

	// The first cycle seeds the cursor at the current head and delivers nothing.
	expect((await runner.runOnce()).delivered).toBe(0);
	expect(seen).toEqual([]);

	const after = await g.addNode({ type: 'person', data: { name: 'after' } });
	await runner.runOnce();
	expect(seen).toEqual([after.id]);
});

test('a failing action retries, dead-letters, and cannot break its sibling', async () => {
	const g = await makeGraph();
	let attempts = 0;
	const sibling: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-fail',
		start: 'beginning',
		retries: 3,
		backoffMs: 1,
		triggers: [
			{
				name: 'boom',
				match: {},
				action: () => {
					attempts++;
					throw new Error('always fails');
				},
			},
			{ name: 'ok', match: {}, action: (e) => void sibling.push(e.id) },
		],
	});

	const node = await g.addNode({ type: 'person', data: { name: 'seed' } });
	const result = await runner.runOnce();

	expect(attempts).toBe(3);
	expect(result.deadLettered).toBe(1);
	expect(result.delivered).toBe(1); // the sibling still ran
	expect(sibling).toEqual([node.id]);

	const dl = await deadLetters(g.raw, { subscription: 'sub-fail' });
	expect(dl).toHaveLength(1);
	expect(dl[0]?.triggerName).toBe('boom');
	expect(dl[0]?.attempts).toBe(3);
	expect(dl[0]?.error).toContain('always fails');
	expect(dl[0]?.event.id).toBe(node.id);

	// The mutation that produced the event is untouched by the failure.
	expect(await g.getNode(node.id)).not.toBeNull();

	// A poison event does not wedge the subscription.
	expect((await runner.runOnce()).delivered).toBe(0);
});

test('a second runner resumes at exactly the undelivered remainder', async () => {
	const g = await makeGraph();
	const ids: string[] = [];
	for (let i = 0; i < 4; i++) {
		ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
	}

	const seenA: string[] = [];
	const a = new TriggerRunner(g, {
		name: 'sub-resume',
		start: 'beginning',
		batchSize: 2,
		triggers: [{ name: 'record', match: {}, action: (e) => void seenA.push(e.id) }],
	});
	await a.runOnce();
	expect(seenA).toEqual([ids[0], ids[1]]);

	// A fresh runner over the same subscription name — the restart case.
	const seenB: string[] = [];
	const b = new TriggerRunner(g, {
		name: 'sub-resume',
		start: 'beginning',
		triggers: [{ name: 'record', match: {}, action: (e) => void seenB.push(e.id) }],
	});
	await b.runOnce();
	expect(seenB).toEqual([ids[2], ids[3]]); // no replay, no skip
});

test.skipIf(TEST_DRIVER === 'postgres')(
	'a process killed mid-batch redelivers only what it had not checkpointed',
	async () => {
		const { client, sibling, teardown } = makeTestDb({ file: true });
		teardowns.push(teardown);
		await init(client, 4);
		const g = new Graph(client, SCHEMA, undefined, { outbox: true });

		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
		}

		const seenA: string[] = [];
		const a = new TriggerRunner(g, {
			name: 'sub-crash',
			start: 'beginning',
			retries: 1,
			backoffMs: 1,
			triggers: [
				{
					name: 'record',
					match: {},
					action: (e) => {
						if (e.id === ids[2]) {
							client.close(); // the process dies before this event is delivered
							throw new Error('process died');
						}
						seenA.push(e.id);
					},
				},
			],
		});
		await expect(a.runOnce()).rejects.toThrow();
		expect(seenA).toEqual([ids[0], ids[1]]);

		const revived = new Graph((sibling as () => DbClient)(), SCHEMA, undefined, { outbox: true });
		const seenB: string[] = [];
		const b = new TriggerRunner(revived, {
			name: 'sub-crash',
			start: 'beginning',
			triggers: [{ name: 'record', match: {}, action: (e) => void seenB.push(e.id) }],
		});
		await b.runOnce();
		expect(seenB).toEqual([ids[2], ids[3]]);
	},
);

test('concurrency dispatches in parallel up to the bound and still drains the page', async () => {
	const g = await makeGraph();
	const ids: string[] = [];
	for (let i = 0; i < 6; i++) {
		ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
	}

	let inFlight = 0;
	let peak = 0;
	const seen: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-conc',
		start: 'beginning',
		concurrency: 3,
		triggers: [
			{
				name: 'record',
				match: {},
				action: async (e) => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await new Promise((r) => setTimeout(r, 5));
					seen.push(e.id);
					inFlight--;
				},
			},
		],
	});

	const result = await runner.runOnce();
	expect(result.delivered).toBe(6);
	expect(seen.sort()).toEqual([...ids].sort());
	expect(peak).toBeGreaterThan(1);
	expect(peak).toBeLessThanOrEqual(3);
});

test('concurrent batches still checkpoint, so a restart delivers nothing twice', async () => {
	const g = await makeGraph();
	for (let i = 0; i < 4; i++) await g.addNode({ type: 'person', data: { name: `p${i}` } });

	const first: string[] = [];
	await new TriggerRunner(g, {
		name: 'sub-conc-cursor',
		start: 'beginning',
		concurrency: 2,
		triggers: [{ name: 'record', match: {}, action: (e) => void first.push(e.id) }],
	}).runOnce();
	expect(first).toHaveLength(4);

	const second: string[] = [];
	await new TriggerRunner(g, {
		name: 'sub-conc-cursor',
		start: 'beginning',
		concurrency: 2,
		triggers: [{ name: 'record', match: {}, action: (e) => void second.push(e.id) }],
	}).runOnce();
	expect(second).toEqual([]);
});

test.skipIf(TEST_DRIVER === 'postgres')(
	'a dead-letter failure drains its in-flight siblings before the cycle rejects, so a retry never overlaps them',
	async () => {
		const g = await makeGraph();
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
		}

		// ids[0] is claimed first (pool() hands out indices in seq order) — closing the client in
		// its action makes the retry-exhausted dead-letter INSERT itself throw, an infra failure
		// deliver() does not catch. ids[1]/ids[2] are its concurrent siblings under `concurrency: 3`;
		// they never touch the client, so they only fail if pool() lets the rejection race ahead of
		// them instead of draining every in-flight worker first.
		let inFlight = 0;
		const seen: string[] = [];
		const runner = new TriggerRunner(g, {
			name: 'sub-conc-drain',
			start: 'beginning',
			concurrency: 3,
			retries: 1,
			triggers: [
				{
					name: 'record',
					match: {},
					action: async (e) => {
						if (e.id === ids[0]) {
							g.raw.close();
							throw new Error('boom');
						}
						inFlight++;
						await new Promise((r) => setTimeout(r, 15));
						seen.push(e.id);
						inFlight--;
					},
				},
			],
		});

		await expect(runner.runOnce()).rejects.toThrow();
		// By the time the rejection reaches us, every sibling dispatched alongside the failing one
		// has fully finished — none left running detached to race a caller's redelivery of the page.
		expect(inFlight).toBe(0);
		expect(seen.sort()).toEqual([ids[1], ids[2]].sort());
	},
);
