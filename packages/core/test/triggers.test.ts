import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { GraphEvent } from '../src/events.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { deadLetters, matchesTrigger, pruneDeadLetters } from '../src/triggers.ts';
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
