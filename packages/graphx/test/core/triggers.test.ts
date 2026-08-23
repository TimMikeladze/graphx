import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import type { GraphEvent } from '../../src/core/events.ts';
import { Graph } from '../../src/core/graph.ts';
import { init } from '../../src/core/schema.ts';
import { outboxHead } from '../../src/core/temporal.ts';
import {
	deadLetters,
	matchesTrigger,
	pruneDeadLetters,
	TriggerRunner,
	webhookAction,
} from '../../src/core/triggers.ts';
import { makeTestDb } from './harness.ts';

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

/**
 * Block until every outbox row written so far is visible to {@link outboxTail}.
 *
 * On libSQL this returns on the first check: one serialized writer means `seq` equals commit order,
 * so a committed event is visible to the very next read. Postgres withholds a row until its
 * inserting transaction precedes the snapshot xmin horizon (`PG_OUTBOX_VISIBLE` in temporal.ts) —
 * the gate that stops an out-of-order IDENTITY `seq` from being skipped forever — so a write is NOT
 * visible immediately, and a cycle run straight after one can legitimately deliver nothing.
 *
 * Calling this between the writes and the `runOnce()` that should see them is what makes these
 * tests driver-neutral WITHOUT weakening a single assertion: each test still drives the runner
 * exactly as many cycles as it means to, and still asserts on exact delivered/skipped counts. A
 * fixed sleep would only trade a deterministic failure for a slower flaky one.
 */
async function settle(graph: Graph<typeof SCHEMA>): Promise<void> {
	// MAX(seq) ungated — every row on disk, visible to the tail yet or not.
	const r = await graph.raw.execute('SELECT COALESCE(MAX(seq), 0) AS m FROM graph_outbox');
	const target = Number((r.rows[0] as { m: unknown }).m);
	const deadline = Date.now() + 10_000;
	while ((await outboxHead(graph.raw)) < target) {
		if (Date.now() >= deadline) {
			throw new Error(
				`settle: outbox rows through seq ${target} never became visible to the tail within 10s`,
			);
		}
		await sleep(5);
	}
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
	await settle(g);
	const first = await runner.runOnce();

	expect(first.delivered).toBe(1);
	expect(first.deadLettered).toBe(0);
	expect(seen).toHaveLength(1);
	expect(seen[0]?.label).toBe('person');

	// The action's own write is tagged, so the same trigger does not match it. Settle first, or
	// this would pass vacuously on Postgres by the derived event simply not being visible yet.
	await settle(g);
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

	await settle(g);
	await runner.runOnce();
	expect(closes).toEqual(['edge.delete', 'node.delete']);
});

test('start defaults to now, skipping events that predate the first poll', async () => {
	const g = await makeGraph();
	await g.addNode({ type: 'person', data: { name: 'before' } });
	// The 'before' event must be VISIBLE when the cursor seeds, or `'now'` would seed behind it and
	// the test would prove nothing about skipping history.
	await settle(g);

	const seen: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-now',
		triggers: [{ name: 'record', match: {}, action: (e) => void seen.push(e.id) }],
	});

	// Written AFTER construction but BEFORE the first poll. `'now'` means the head as of that first
	// poll, so this is skipped too — the clause that distinguishes first-poll seeding from
	// construction-time seeding, which is otherwise untestable from the outside.
	await g.addNode({ type: 'person', data: { name: 'mid' } });
	await settle(g);

	// The first cycle seeds the cursor at the current head and delivers nothing.
	expect((await runner.runOnce()).delivered).toBe(0);
	expect(seen).toEqual([]);

	const after = await g.addNode({ type: 'person', data: { name: 'after' } });
	await settle(g);
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
	await settle(g);
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
	// All four must be visible before the first cycle, or `batchSize: 2` would page a shorter
	// prefix than the test asserts on.
	await settle(g);

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

// Runs on BOTH drivers: `makeTestDb` exposes a `sibling` factory for Postgres as well as libSQL,
// and its teardown already copes with a test having closed the main client. The kill is simulated
// by closing the client mid-cycle, which both drivers reject on synchronously.
test('a process killed mid-batch redelivers only what it had not checkpointed', async () => {
	const { client, sibling, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, 4);
	const g = new Graph(client, SCHEMA, undefined, { outbox: true });

	const ids: string[] = [];
	for (let i = 0; i < 4; i++) {
		ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
	}
	await settle(g);

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
});

test('concurrency dispatches in parallel up to the bound and still drains the page', async () => {
	const g = await makeGraph();
	const ids: string[] = [];
	for (let i = 0; i < 6; i++) {
		ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
	}
	// All six in one page, or the peak-concurrency assertion measures a shorter page.
	await settle(g);

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
	await settle(g);

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

test('a dead-letter failure drains its in-flight siblings before the cycle rejects, so a retry never overlaps them', async () => {
	const g = await makeGraph();
	const ids: string[] = [];
	for (let i = 0; i < 6; i++) {
		ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
	}
	await settle(g);

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
});

test('start polls until stopped, and stop actually stops', async () => {
	const g = await makeGraph();
	const seen: string[] = [];
	let resolveSeen: (id: string) => void = () => {};
	const firstSeen = new Promise<string>((r) => {
		resolveSeen = r;
	});
	const runner = new TriggerRunner(g, {
		name: 'sub-loop',
		start: 'beginning',
		pollIntervalMs: 5,
		triggers: [
			{
				name: 'record',
				match: {},
				action: (e) => {
					seen.push(e.id);
					resolveSeen(e.id);
				},
			},
		],
	});

	runner.start();
	runner.start(); // idempotent — a second call must not spawn a second loop
	const node = await g.addNode({ type: 'person', data: { name: 'live' } });
	expect(await firstSeen).toBe(node.id);
	await runner.stop();

	// One delivery, not two: the second start() did not spawn a competing loop.
	expect(seen).toEqual([node.id]);

	// Stopped means stopped — a later write is never picked up.
	await g.addNode({ type: 'person', data: { name: 'ignored' } });
	await new Promise((r) => setTimeout(r, 50));
	expect(seen).toEqual([node.id]);
});

interface Captured {
	body: string;
	headers: Record<string, string>;
}

/** A throwaway HTTP server that records requests and replies with `status()`. */
function captureServer(status: () => number): {
	url: string;
	requests: Captured[];
	close: () => void;
} {
	const requests: Captured[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			requests.push({
				body: await req.text(),
				headers: Object.fromEntries(req.headers.entries()),
			});
			return new Response('', { status: status() });
		},
	});
	return {
		url: `http://localhost:${server.port}/hook`,
		requests,
		close: () => server.stop(true),
	};
}

test('webhook delivers a signed payload on a 2xx', async () => {
	const g = await makeGraph();
	const hook = captureServer(() => 200);
	try {
		const runner = new TriggerRunner(g, {
			name: 'sub-hook',
			start: 'beginning',
			triggers: [
				{
					name: 'notify',
					match: { op: 'node.create' },
					action: webhookAction({
						url: hook.url,
						secret: 'shh',
						headers: { 'x-custom': 'yes' },
					}),
				},
			],
		});
		const node = await g.addNode({ type: 'person', data: { name: 'seed' } });
		await settle(g);
		expect((await runner.runOnce()).delivered).toBe(1);

		expect(hook.requests).toHaveLength(1);
		const req = hook.requests[0] as Captured;
		expect(JSON.parse(req.body).id).toBe(node.id);
		expect(req.headers['x-graphx-event']).toBe('node.create');
		expect(req.headers['x-custom']).toBe('yes');
		expect(Number(req.headers['x-graphx-seq'])).toBeGreaterThan(0);

		// The signature is an HMAC-SHA256 over the exact body.
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode('shh'),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(req.body));
		const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
		expect(req.headers['x-graphx-signature']).toBe(`sha256=${hex}`);
	} finally {
		hook.close();
	}
});

test('webhook retries a non-2xx and dead-letters when the attempts run out', async () => {
	const g = await makeGraph();
	const hook = captureServer(() => 500);
	try {
		const runner = new TriggerRunner(g, {
			name: 'sub-hook-fail',
			start: 'beginning',
			retries: 2,
			backoffMs: 1,
			triggers: [
				{ name: 'notify', match: { op: 'node.create' }, action: webhookAction({ url: hook.url }) },
			],
		});
		await g.addNode({ type: 'person', data: { name: 'seed' } });
		await settle(g);
		const result = await runner.runOnce();

		expect(result.deadLettered).toBe(1);
		expect(hook.requests).toHaveLength(2); // retried once
		const dl = await deadLetters(g.raw, { subscription: 'sub-hook-fail' });
		expect(dl[0]?.error).toContain('500');
	} finally {
		hook.close();
	}
});

test('webhook sends no signature header when no secret is configured', async () => {
	const g = await makeGraph();
	const hook = captureServer(() => 204);
	try {
		const runner = new TriggerRunner(g, {
			name: 'sub-hook-unsigned',
			start: 'beginning',
			triggers: [
				{ name: 'notify', match: { op: 'node.create' }, action: webhookAction({ url: hook.url }) },
			],
		});
		await g.addNode({ type: 'person', data: { name: 'seed' } });
		await settle(g);
		expect((await runner.runOnce()).delivered).toBe(1);

		const req = hook.requests[0] as Captured;
		expect(req.headers['x-graphx-signature']).toBeUndefined();
		expect(req.headers['content-type']).toBe('application/json');
	} finally {
		hook.close();
	}
});
