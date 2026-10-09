import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { bulkLoad } from '../../src/core/bulk.ts';
import { declareUniqueNodeProp } from '../../src/core/constraints.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { InMemoryEvents } from '../../src/core/events.ts';
import { Graph } from '../../src/core/graph.ts';
import { FOREVER } from '../../src/core/runtime.ts';
import { init } from '../../src/core/schema.ts';
import { makeTestDb } from './harness.ts';

// Phase 2 of docs/bitemporal.md: one write primitive (D2) — a write replaces content over a
// valid-time portion, superseding what it overlaps and keeping the parts outside it.

const SCHEMA = defineGraphSchema({
	nodes: {
		plant: z.object({ yield: z.number(), tag: z.string().optional() }),
		person: z.object({ name: z.string() }),
	},
	edges: { feeds: { from: 'plant', to: 'plant' } },
});

const teardowns: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of teardowns) await teardown();
});

async function setup(): Promise<{
	client: DbClient;
	g: Graph<typeof SCHEMA>;
	events: InMemoryEvents;
}> {
	// file-backed: writes run transactions, which detach a :memory: libSQL client
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client);
	const events = new InMemoryEvents();
	return { client, g: new Graph(client, SCHEMA, { events: { sink: events } }), events };
}

const Y = (year: number) => Date.UTC(year, 0, 1);
const yieldAt = async (g: Graph<typeof SCHEMA>, id: string, asOf?: number) =>
	((await g.getNode(id, asOf === undefined ? {} : { asOf }))?.data as { yield: number } | undefined)
		?.yield ?? null;

/** Current beliefs of one id, oldest first. */
async function beliefs(client: DbClient, id: string): Promise<Array<[number, number]>> {
	const r = await client.execute({
		sql: 'SELECT valid_from, valid_to FROM node_versions WHERE id = ? AND recorded_to = ? ORDER BY valid_from',
		args: [id, FOREVER],
	});
	return r.rows.map((row) => [Number(row.valid_from), Number(row.valid_to)]);
}

test('a correction replaces a fact from a past date on; the old belief stays stored', async () => {
	const { client, g, events } = await setup();
	const h = await g.addNode({ type: 'plant', data: { yield: 0.9 }, validFrom: Y(1992) });
	await g.correctNode(h.id, { data: { yield: 0.88 } }, { validFrom: Y(1992) });

	expect(await yieldAt(g, h.id, Y(1995))).toBe(0.88);
	expect(await yieldAt(g, h.id)).toBe(0.88);
	expect(await beliefs(client, h.id)).toEqual([[Y(1992), FOREVER]]);
	const all = await client.execute({
		sql: 'SELECT data, recorded_to FROM node_versions WHERE id = ? ORDER BY ver',
		args: [h.id],
	});
	expect(
		all.rows.map((r) => [JSON.parse(String(r.data)).yield, Number(r.recorded_to) < FOREVER]),
	).toEqual([
		[0.9, true],
		[0.88, false],
	]);
	expect(events.byOp('node.correct').map((e) => e.ts)).toEqual([Y(1992)]);
});

test('a correction over the middle of an interval leaves both sides as they were', async () => {
	const { client, g } = await setup();
	const h = await g.addNode({ type: 'plant', data: { yield: 0.9 }, validFrom: Y(1992) });
	await g.correctNode(h.id, { data: { yield: 0.5 } }, { validFrom: Y(1994), validTo: Y(1996) });

	expect(await beliefs(client, h.id)).toEqual([
		[Y(1992), Y(1994)],
		[Y(1994), Y(1996)],
		[Y(1996), FOREVER],
	]);
	expect(await yieldAt(g, h.id, Y(1993))).toBe(0.9);
	expect(await yieldAt(g, h.id, Y(1995))).toBe(0.5);
	expect(await yieldAt(g, h.id, Y(1997))).toBe(0.9);
	expect(await yieldAt(g, h.id)).toBe(0.9);
});

test('a retraction removes a past period; deleteNode and updateNode can be backdated', async () => {
	const { g } = await setup();
	const h = await g.addNode({ type: 'plant', data: { yield: 0.9 }, validFrom: Y(1990) });
	await g.retractNode(h.id, { validFrom: Y(1993), validTo: Y(1994) });
	expect(await yieldAt(g, h.id, Y(1993) + 1)).toBeNull();
	expect(await yieldAt(g, h.id, Y(1992))).toBe(0.9);

	await g.updateNode(h.id, { data: { yield: 0.7 } }, { validFrom: Y(2000) });
	expect(await yieldAt(g, h.id, Y(1999))).toBe(0.9);
	expect(await yieldAt(g, h.id, Y(2001))).toBe(0.7);

	await g.deleteNode(h.id, { validFrom: Y(2010) });
	expect(await yieldAt(g, h.id)).toBeNull();
	expect(await yieldAt(g, h.id, Y(2005))).toBe(0.7);
	await expect(g.retractNode(h.id, { validFrom: Y(2015), validTo: Y(2016) })).rejects.toThrow(
		/no version/,
	);
});

test('nothing is future-dated (D3)', async () => {
	const { client, g } = await setup();
	const later = Date.now() + 60_000;
	await expect(g.addNode({ type: 'plant', data: { yield: 1 }, validFrom: later })).rejects.toThrow(
		/future/,
	);
	const h = await g.addNode({ type: 'plant', data: { yield: 1 }, validFrom: Y(2000) });
	await expect(g.updateNode(h.id, { data: { yield: 2 } }, { validFrom: later })).rejects.toThrow(
		/future/,
	);
	// a finite end after now would end the fact without a write
	await expect(
		g.correctNode(h.id, { data: { yield: 2 } }, { validFrom: Y(2001), validTo: later }),
	).rejects.toThrow(/validTo/);
	await expect(
		bulkLoad(client, SCHEMA, [{ type: 'plant', data: { yield: 1 }, validFrom: later }]),
	).rejects.toThrow(/future/);
});

test('edges: backdated add, past weight correction, retraction', async () => {
	const { client, g } = await setup();
	const a = await g.addNode({ type: 'plant', data: { yield: 1 }, validFrom: Y(1990) });
	const b = await g.addNode({ type: 'plant', data: { yield: 1 }, validFrom: Y(1990) });
	const e = await g.addEdge({ rel: 'feeds', src: a.id, dst: b.id, weight: 1, validFrom: Y(1991) });
	await g.correctEdge(e.id, { weight: 3 }, { validFrom: Y(1995), validTo: Y(1996) });
	await g.retractEdge(e.id, { validFrom: Y(2000) });

	const weights = await client.execute({
		sql: 'SELECT weight, valid_from, valid_to FROM edge_versions WHERE id = ? AND recorded_to = ? ORDER BY valid_from',
		args: [e.id, FOREVER],
	});
	expect(
		weights.rows.map((r) => [Number(r.weight), Number(r.valid_from), Number(r.valid_to)]),
	).toEqual([
		[1, Y(1991), Y(1995)],
		[3, Y(1995), Y(1996)],
		[1, Y(1996), Y(2000)],
	]);
	expect((await g.neighbors(a.id, { asOf: Y(1995) + 1 })).map((n) => n.id)).toEqual([b.id]);
	expect(await g.neighbors(a.id)).toEqual([]);
});

test('a unique prop holds for live corrections; a past one may repeat a value', async () => {
	const { g, client } = await setup();
	await declareUniqueNodeProp(client, { type: 'plant', prop: 'tag' });
	const a = await g.addNode({ type: 'plant', data: { yield: 1, tag: 'A' }, validFrom: Y(1990) });
	await g.addNode({ type: 'plant', data: { yield: 1, tag: 'B' }, validFrom: Y(1990) });
	await expect(
		g.correctNode(a.id, { data: { tag: 'B' } }, { validFrom: Y(1995) }),
	).rejects.toThrow();
	// history may say A was tagged B once: only live rows are unique
	await g.correctNode(a.id, { data: { tag: 'B' } }, { validFrom: Y(1991), validTo: Y(1992) });
	expect((await g.getNode(a.id))?.data).toEqual({ yield: 1, tag: 'A' });
});

test('bulkLoad mode correct replaces what it covers and keeps the stored rest', async () => {
	const { client, g } = await setup();
	await bulkLoad(client, SCHEMA, [
		{ id: 'H1', type: 'plant', data: { yield: 0.9 }, validFrom: Y(1992) },
	]);
	await expect(
		bulkLoad(client, SCHEMA, [
			{ id: 'H1', type: 'plant', data: { yield: 0.5 }, validFrom: Y(1994), validTo: Y(1996) },
		]),
	).rejects.toThrow(/mode: 'correct'/);
	await bulkLoad(
		client,
		SCHEMA,
		[{ id: 'H1', type: 'plant', data: { yield: 0.5 }, validFrom: Y(1994), validTo: Y(1996) }],
		{ mode: 'correct' },
	);
	expect(await beliefs(client, 'H1')).toEqual([
		[Y(1992), Y(1994)],
		[Y(1994), Y(1996)],
		[Y(1996), FOREVER],
	]);
	expect(await yieldAt(g, 'H1', Y(1995))).toBe(0.5);
	expect(await yieldAt(g, 'H1')).toBe(0.9);
});

test('property: random corrections and retractions keep current beliefs consistent with a model', async () => {
	const { client, g } = await setup();
	// A tiny LCG so a failure replays exactly.
	let seed = 42;
	const rand = (n: number) => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed % n;
	};
	const T0 = 1000;
	const SPAN = 40;
	const h = await g.addNode({ type: 'plant', data: { yield: 0 }, validFrom: T0 });
	// model: value at each integer instant in [T0, T0+SPAN), plus the open tail after it
	const model: Array<number | null> = Array.from({ length: SPAN }, () => 0);
	let tail: number | null = 0;
	const at = (t: number) => (t - T0 < SPAN ? model[t - T0]! : tail);

	for (let step = 0; step < 60; step++) {
		const from = T0 + rand(SPAN);
		const open = rand(4) === 0;
		const to = open ? FOREVER : from + 1 + rand(T0 + SPAN - from);
		const covers = (v: number | null) => {
			for (let t = from; t < Math.min(to, T0 + SPAN); t++) model[t - T0] = v;
			if (open) tail = v;
		};
		const anyIn = () => {
			for (let t = from; t < Math.min(to, T0 + SPAN); t++) if (model[t - T0] !== null) return true;
			return open && tail !== null;
		};
		if (rand(3) === 0) {
			const ok = anyIn();
			const p = g.retractNode(h.id, { validFrom: from, validTo: to });
			if (ok) {
				await p;
				covers(null);
			} else {
				await expect(p).rejects.toThrow(/no version/);
			}
		} else {
			const v = step + 1;
			const ok = at(from) !== null || tail !== null;
			const p = g.correctNode(h.id, { data: { yield: v } }, { validFrom: from, validTo: to });
			if (ok) {
				await p;
				covers(v);
			} else {
				await expect(p).rejects.toThrow(/no version/);
			}
		}

		// current beliefs never overlap, and at most one is open
		const bs = await beliefs(client, h.id);
		for (let i = 1; i < bs.length; i++) expect(bs[i]![0]).toBeGreaterThanOrEqual(bs[i - 1]![1]);
		expect(bs.filter(([, end]) => end === FOREVER).length).toBeLessThanOrEqual(1);
		for (const t of [from, to === FOREVER ? T0 + SPAN : to, T0 + rand(SPAN)]) {
			expect(await yieldAt(g, h.id, t)).toBe(at(t));
		}
		expect(await yieldAt(g, h.id)).toBe(tail);
	}
});
