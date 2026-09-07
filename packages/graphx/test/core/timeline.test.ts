import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { FOREVER } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { Graph } from '../../src/core/graph.ts';
import { init } from '../../src/core/schema.ts';
import { timeline } from '../../src/core/timeline.ts';
import { insertOrIgnoreSql, makeTestDb } from './harness.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

// The timeline aggregate backs the admin explorer's scrubber: the extent of the graph's change
// points, a density histogram over a window, and the distinct instants to snap to. Change points
// are BOTH valid_from and non-FOREVER valid_to — a retraction moves only valid_to, so a
// valid_from-only timeline would hide every delete.

const SCHEMA = defineGraphSchema({
	nodes: { device: z.object({ type: z.string() }), person: z.object({ name: z.string() }) },
	edges: { owns: { from: 'person', to: 'device' } },
});

const DIM = 4;
const teardowns: Array<() => Promise<void>> = [];

async function freshGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, hashEmbed(DIM));
	return { client, g: new Graph(client, SCHEMA) };
}

afterAll(async () => {
	for (const teardown of teardowns) await teardown();
});

/**
 * Seed rows at exact instants, bypassing the Graph API so the test controls every timestamp.
 * `node_versions.id` carries a FK to `node_identity`, so the identity row comes first — without
 * it Postgres rejects the insert outright.
 */
async function seedNodeVersion(client: DbClient, id: string, from: number, to: number) {
	await client.execute({
		sql: insertOrIgnoreSql(client, 'node_identity', 'id', '(?)'),
		args: [id],
	});
	await client.execute({
		sql: `INSERT INTO node_versions (id, type, data, valid_from, valid_to) VALUES (?, 'device', '{"type":"r"}', ?, ?)`,
		args: [id, from, to],
	});
}

test('timeline: empty graph reports a null extent and a zero-filled histogram', async () => {
	const { client } = await freshGraph();
	const t = await timeline(client, { buckets: 4 });
	expect(t.min).toBeNull();
	expect(t.max).toBeNull();
	expect(t.total).toBe(0);
	expect(t.buckets).toEqual([0, 0, 0, 0]);
	expect(t.ticks).toEqual([]);
	expect(t.ticksTruncated).toBe(false);
});

test('timeline: extent spans both version tables', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });
	const t = await timeline(client);
	expect(t.min).not.toBeNull();
	expect(t.max).not.toBeNull();
	expect(t.total).toBeGreaterThanOrEqual(3);
	expect((t.max as number) >= (t.min as number)).toBe(true);
});

test('timeline: a closed edge is a change point (the case changeFeed omits)', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });
	const before = await timeline(client);
	await new Promise((r) => setTimeout(r, 5));
	await g.deleteEdge(e.id);
	const after = await timeline(client);

	// The close writes no new valid_from, so only the valid_to half of the CTE can see it.
	expect(after.total).toBe(before.total + 1);
	expect(after.max).toBeGreaterThan(before.max as number);
	expect(after.ticks.length).toBe(before.ticks.length + 1);
});

test('timeline: a non-FOREVER valid_to counts as its own change point', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 1000, 2000);
	const t = await timeline(client, { buckets: 2 });
	expect(t.min).toBe(1000);
	expect(t.max).toBe(2000);
	expect(t.total).toBe(2);
	expect(t.ticks).toEqual([1000, 2000]);
});

test('timeline: buckets sum to the windowed total and the closing edge lands in the last slot', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 0, 100);
	await seedNodeVersion(client, 'n2', 50, 100);
	const t = await timeline(client, { buckets: 4 });
	// Change points: 0, 50, 100, 100 → from=0, to=100, span=100, slot width 25.
	expect(t.from).toBe(0);
	expect(t.to).toBe(100);
	expect(t.buckets.length).toBe(4);
	expect(t.buckets.reduce((a, b) => a + b, 0)).toBe(4);
	expect(t.buckets[0]).toBe(1); // t=0
	expect(t.buckets[2]).toBe(1); // t=50
	expect(t.buckets[3]).toBe(2); // t=100, clamped into the last slot rather than overflowing
});

test('timeline: from/to narrows both the histogram and the ticks', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 0, 100);
	await seedNodeVersion(client, 'n2', 400, 500);
	const t = await timeline(client, { from: 300, to: 600, buckets: 3 });
	expect(t.min).toBe(0); // extent is unwindowed
	expect(t.max).toBe(500);
	expect(t.from).toBe(300);
	expect(t.to).toBe(600);
	expect(t.ticks).toEqual([400, 500]);
	expect(t.buckets.reduce((a, b) => a + b, 0)).toBe(2);
});

test('timeline: a single-instant graph does not divide by zero', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 7000, 7000);
	await seedNodeVersion(client, 'n2', 7000, 7000);
	const t = await timeline(client, { buckets: 3 });
	expect(t.min).toBe(7000);
	expect(t.max).toBe(7000);
	expect(t.ticks).toEqual([7000]);
	expect(t.buckets[0]).toBe(4);
	expect(t.buckets.reduce((a, b) => a + b, 0)).toBe(4);
});

test('timeline: the tick list is capped and flags truncation, sampling every k-th instant', async () => {
	const { client } = await freshGraph();
	// valid_from at 1000, 1010, ..., 1050, plus every valid_to at 9_000_000 (deduped by DISTINCT
	// to one instant) → seven distinct change points: 1000..1050 and 9_000_000.
	for (let i = 0; i < 6; i++) await seedNodeVersion(client, `n${i}`, 1000 + i * 10, 9_000_000);
	const t = await timeline(client, { limits: { maxRows: 3 } });
	expect(t.ticks.length).toBe(3);
	expect(t.ticksTruncated).toBe(true);
	// count=7, cap=3 ⇒ k=ceil((7-1)/(3-1))=ceil(6/2)=3: rn 0,3,6 of
	// {1000,1010,1020,1030,1040,1050,9_000_000}, i.e. 1000, 1030, 9_000_000 — spread across the
	// window, not the most recent 3.
	expect(t.ticks).toEqual([1000, 1030, 9_000_000]);
	expect(t.ticks).toEqual([...t.ticks].sort((a, b) => a - b));
});

test('timeline: a cap of one still returns exactly one tick', async () => {
	const { client } = await freshGraph();
	// Same seven distinct change points as above — any two of them are enough to reach the
	// `rn % k = 0 OR rn = lastRn` selection that a cap of one cannot fit both halves of.
	for (let i = 0; i < 6; i++) await seedNodeVersion(client, `n${i}`, 1000 + i * 10, 9_000_000);
	const t = await timeline(client, { limits: { maxRows: 1 } });
	expect(t.ticksTruncated).toBe(true);
	expect(t.ticks.length).toBe(1);
});

test('timeline: a truncated tick list samples across the window rather than slicing one end', async () => {
	const { client } = await freshGraph();
	// 40 distinct instants spread evenly over [1000, 40000]. `to` is FOREVER (still open) so only
	// the 40 valid_from values are change points — a shared non-FOREVER `to` would add one more,
	// far outside this range, and skew the window this test is trying to measure.
	for (let i = 0; i < 40; i++) await seedNodeVersion(client, `n${i}`, 1000 + i * 1000, FOREVER);
	const t = await timeline(client, { limits: { maxRows: 8 } });

	expect(t.ticksTruncated).toBe(true);
	// Not just "at most 8": using the whole budget evenly is half the point of the sample, and a
	// stride that came out too coarse (5 of an allowed 8) would pass an <= check silently.
	expect(t.ticks.length).toBe(8);
	// Both ends of the window are always reachable.
	expect(t.ticks[0]).toBe(t.min);
	expect(t.ticks[t.ticks.length - 1]).toBe(t.max);
	// Ascending, and genuinely spread — not bunched into one end.
	expect(t.ticks.every((v, i, a) => i === 0 || (a[i - 1] as number) <= v)).toBe(true);
	const mid = t.ticks[Math.floor(t.ticks.length / 2)] as number;
	const midPct = ((mid - (t.min as number)) / ((t.max as number) - (t.min as number))) * 100;
	expect(midPct).toBeGreaterThan(25);
	expect(midPct).toBeLessThan(75);
});

test('timeline: an untruncated tick list is still every distinct instant', async () => {
	const { client } = await freshGraph();
	for (let i = 0; i < 5; i++) await seedNodeVersion(client, `n${i}`, 1000 + i * 10, 9_000_000);
	const t = await timeline(client);
	expect(t.ticksTruncated).toBe(false);
	expect(t.ticks).toEqual([1000, 1010, 1020, 1030, 1040, 9_000_000]);
});

test('timeline: buckets is clamped to the supported range', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 0, 100);
	expect((await timeline(client, { buckets: 0 })).buckets.length).toBe(1);
	expect((await timeline(client, { buckets: 99_999 })).buckets.length).toBe(1000);
});
