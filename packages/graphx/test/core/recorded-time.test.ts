import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { snapshotCSR } from '../../src/core/algorithms.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { hashEmbed } from '../../src/core/embedder.ts';
import { Graph } from '../../src/core/graph.ts';
import { journey } from '../../src/core/journey.ts';
import { match } from '../../src/core/pattern.ts';
import { init } from '../../src/core/schema.ts';
import { diff, type TimeSlice } from '../../src/core/temporal.ts';
import { timeline } from '../../src/core/timeline.ts';
import { makeTestDb } from './harness.ts';

// Phase 3 of docs/bitemporal.md: every read takes `recordedAsOf` beside `asOf` (D1). `asOf` is
// the world at an instant; `recordedAsOf` is what graphx believed at an instant.

const SCHEMA = defineGraphSchema({
	nodes: { plant: z.object({ name: z.string(), yield: z.number() }) },
	edges: { feeds: { from: 'plant', to: 'plant' } },
});

const teardowns: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of teardowns) await teardown();
});

async function setup(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, hashEmbed(8));
	return { client, g: new Graph(client, SCHEMA, { embedder: hashEmbed(8) }) };
}

/** An instant strictly between the write before it and the write after it. */
async function instant(): Promise<number> {
	await Bun.sleep(3);
	const t = Date.now();
	await Bun.sleep(3);
	return t;
}

const Y = (year: number) => Date.UTC(year, 0, 1);

test('a correction: valid time says what was true, recorded time what we believed when', async () => {
	const { g } = await setup();
	const h = await g.addNode({
		type: 'plant',
		data: { name: 'H1', yield: 0.9 },
		validFrom: Y(1992),
	});
	const beforeFix = await instant();
	await g.correctNode(h.id, { data: { yield: 0.88 } }, { validFrom: Y(1992) });

	const yieldIn = async (s: TimeSlice) =>
		((await g.getNode(h.id, s))?.data as { yield: number } | undefined)?.yield ?? null;
	expect(await yieldIn({ asOf: Y(1995) })).toBe(0.88);
	expect(await yieldIn({ asOf: Y(1995), recordedAsOf: beforeFix })).toBe(0.9);
	expect(await yieldIn({ recordedAsOf: beforeFix })).toBe(0.9); // the live value we believed then
	expect(await yieldIn({})).toBe(0.88);
	// before graphx knew about it at all
	expect(await yieldIn({ recordedAsOf: Y(1992) })).toBeNull();
});

test('equivalence: on a graph written only live, recordedAsOf t agrees with asOf t', async () => {
	const { client, g } = await setup();
	const instants: number[] = [await instant()];
	const a = await g.addNode({ type: 'plant', data: { name: 'a', yield: 1 } });
	const b = await g.addNode({ type: 'plant', data: { name: 'b', yield: 1 } });
	instants.push(await instant());
	const ab = await g.addEdge({ rel: 'feeds', src: a.id, dst: b.id });
	instants.push(await instant());
	const c = await g.addNode({ type: 'plant', data: { name: 'c', yield: 2 } });
	await g.addEdge({ rel: 'feeds', src: b.id, dst: c.id });
	instants.push(await instant());
	await g.updateNode(b.id, { data: { yield: 5 } });
	instants.push(await instant());
	await g.deleteEdge(ab.id);
	await g.deleteNode(c.id);
	instants.push(await instant());

	for (const t of instants) {
		const one: TimeSlice = { asOf: t };
		const both: TimeSlice = { asOf: t, recordedAsOf: t };
		for (const id of [a.id, b.id, c.id]) {
			expect(await g.getNode(id, both)).toEqual(await g.getNode(id, one));
		}
		expect(await g.listNodes(both)).toEqual(await g.listNodes(one));
		expect(await g.listEdges(both)).toEqual(await g.listEdges(one));
		expect(await g.neighbors(a.id, both)).toEqual(await g.neighbors(a.id, one));
		expect(await g.graphSlice(both)).toEqual(await g.graphSlice(one));
		const pattern = async (s: TimeSlice) => {
			let q = match(SCHEMA, client).node('x', 'plant').out('feeds').node('y', 'plant');
			if (s.asOf !== undefined) q = q.asOf(s.asOf);
			if (s.recordedAsOf !== undefined) q = q.recordedAsOf(s.recordedAsOf);
			return (await q.select('x', 'y')).run();
		};
		expect(await pattern(both)).toEqual(await pattern(one));
		const csr = async (s: TimeSlice) => {
			const m = await snapshotCSR(client, s);
			return { ids: m.idxToId, edges: m.targets.length };
		};
		expect(await csr(both)).toEqual(await csr(one));
	}
});

test('recordedAsOf reaches edges, traversal, retrieval and the time axes', async () => {
	const { client, g } = await setup();
	const a = await g.addNode({
		type: 'plant',
		data: { name: 'apple orchard', yield: 1 },
		body: 'apple orchard',
		validFrom: Y(1990),
	});
	const b = await g.addNode({
		type: 'plant',
		data: { name: 'pear', yield: 1 },
		validFrom: Y(1990),
	});
	const e = await g.addEdge({ rel: 'feeds', src: a.id, dst: b.id, weight: 1, validFrom: Y(2000) });
	const beforeFix = await instant();
	// we learn the edge never held in 2000–2010, and the apple orchard was a pear orchard
	await g.retractEdge(e.id, { validFrom: Y(2000), validTo: Y(2010) });
	await g.correctNode(
		a.id,
		{ data: { name: 'pear orchard' }, body: 'pear orchard' },
		{ validFrom: Y(1990) },
	);
	const afterFix = await instant();

	const at = Y(2005);
	expect((await g.neighbors(a.id, { asOf: at })).map((n) => n.id)).toEqual([]);
	expect((await g.neighbors(a.id, { asOf: at, recordedAsOf: beforeFix })).map((n) => n.id)).toEqual(
		[b.id],
	);
	expect((await g.listEdges({ asOf: at, recordedAsOf: beforeFix })).edges.map((x) => x.id)).toEqual(
		[e.id],
	);
	// a time-respecting walk from 2001: believed then, the edge was open, so b is reached at once;
	// now it opens in 2010
	const arrival = async (recordedAsOf?: number) =>
		(await journey(client, { start: a.id, from: Y(2001), recordedAsOf })).find((r) => r.id === b.id)
			?.arrival_t;
	expect(await arrival(beforeFix)).toBe(Y(2001));
	expect(await arrival()).toBe(Y(2010));
	const csr = await snapshotCSR(client, { asOf: at, recordedAsOf: beforeFix });
	expect(csr.targets.length).toBe(1);

	const named = async (s: TimeSlice) => (await g.getNode(a.id, s))?.data.name;
	expect(await named({ asOf: Y(1995) })).toBe('pear orchard');
	expect(await named({ asOf: Y(1995), recordedAsOf: beforeFix })).toBe('apple orchard');

	// retrieval in a past recorded slice keeps only what was believed then
	const hits = await g.retrieve({ query: 'orchard', k: 2, maxDepth: 0, recordedAsOf: Y(1990) });
	expect(hits).toEqual([]);

	// the recorded axis sees the fix; the valid axis puts it back in 1990/2000
	const recorded = await diff(client, beforeFix, afterFix, { axis: 'recorded' });
	expect(recorded.edges.map((x) => String(x.id))).toContain(e.id);
	expect(recorded.nodes.map((x) => String(x.id))).toContain(a.id);
	const valid = await diff(client, beforeFix, afterFix);
	expect(valid.edges).toEqual([]);
	const tl = await timeline(client, { axis: 'recorded', from: beforeFix, to: afterFix });
	expect(tl.ticks.length).toBeGreaterThan(0);
	expect((await timeline(client, { from: beforeFix, to: afterFix })).ticks).toEqual([]);
});
