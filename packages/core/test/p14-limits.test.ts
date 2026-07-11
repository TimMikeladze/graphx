import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { Graph } from '../src/graph.ts';
import { hybridRetrieve } from '../src/hybrid.ts';
import { journey } from '../src/journey.ts';
import { type EmbedFn, retrieve } from '../src/retrieve.ts';
import { init } from '../src/schema.ts';
import { makeTestDb } from './harness.ts';

// P14 — §19.2 governance applied to the walk read paths: the maxRows row cap and the
// fan-out (supernode) guard. The guard is SQL-enforced in the recursive walk — a node
// whose live degree exceeds maxFanout is emitted but NOT expanded, so a supernode
// can't blow up the traversal. timeoutMs is wired as fail-safe abandonment (M7); its
// semantics are unit-tested in p14-governance — here we only assert non-breakage.

const SCHEMA = defineGraphSchema({
	nodes: { doc: z.object({ title: z.string() }) },
	edges: { links: { from: 'doc', to: 'doc' } },
});

const stubEmbed: EmbedFn = async () => [1, 0, 0, 0];

async function freshGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const client = makeTestDb().client;
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

/** A seed doc (embedding [1,0,0,0]) with `fanout` forward `links` to embedding-less leaves. */
async function supernode(g: Graph<typeof SCHEMA>, fanout: number): Promise<string> {
	const s = await g.addNode({ type: 'doc', data: { title: 'seed' }, emb: [1, 0, 0, 0] });
	for (let i = 0; i < fanout; i++) {
		const leaf = await g.addNode({ type: 'doc', data: { title: `leaf${i}` } });
		await g.addEdge({ rel: 'links', src: s.id, dst: leaf.id });
	}
	return s.id;
}

// --- retrieve -------------------------------------------------------------------

test('P14 fanout: retrieve does NOT expand a node whose out-degree exceeds maxFanout', async () => {
	const { client, g } = await freshGraph();
	const s = await supernode(g, 30);
	const guarded = await retrieve(g.raw, stubEmbed, {
		query: 'seed',
		direction: 'forward',
		maxDepth: 2,
		limits: { maxFanout: 5 },
	});
	// 30 out-edges > 5 → seed emitted at depth 0 but not expanded → only the seed.
	expect(guarded.map((r) => r.id)).toEqual([s]);

	const open = await retrieve(g.raw, stubEmbed, {
		query: 'seed',
		direction: 'forward',
		maxDepth: 2,
		limits: { maxFanout: 1000 },
	});
	expect(open.length).toBeGreaterThan(1); // high cap → expands to the leaves
	client.close();
});

test('P14 cap: retrieve honors maxRows', async () => {
	const { client, g } = await freshGraph();
	await supernode(g, 5);
	const capped = await retrieve(g.raw, stubEmbed, {
		query: 'seed',
		direction: 'forward',
		maxDepth: 1,
		limits: { maxRows: 2, maxFanout: 1000 },
	});
	expect(capped.length).toBe(2);
	client.close();
});

test('P14 timeout: retrieve completes with a generous timeout wired (non-breakage)', async () => {
	const { client, g } = await freshGraph();
	await supernode(g, 3);
	const rows = await retrieve(g.raw, stubEmbed, {
		query: 'seed',
		direction: 'forward',
		limits: { timeoutMs: 5000 },
	});
	expect(rows.length).toBeGreaterThan(0);
	client.close();
});

// --- hybridRetrieve -------------------------------------------------------------

test('P14 fanout: hybridRetrieve does NOT expand a supernode beyond maxFanout', async () => {
	const { client, g } = await freshGraph();
	const s = await supernode(g, 30);
	const guarded = await hybridRetrieve(g.raw, stubEmbed, {
		query: 'seed',
		direction: 'forward',
		maxDepth: 2,
		limits: { maxFanout: 5 },
	});
	expect(guarded.map((r) => r.id)).toEqual([s]);

	const open = await hybridRetrieve(g.raw, stubEmbed, {
		query: 'seed',
		direction: 'forward',
		maxDepth: 2,
		limits: { maxFanout: 1000 },
	});
	expect(open.length).toBeGreaterThan(1);
	client.close();
});

test('P14 cap: hybridRetrieve honors maxRows', async () => {
	const { client, g } = await freshGraph();
	await supernode(g, 5);
	const capped = await hybridRetrieve(g.raw, stubEmbed, {
		query: 'seed',
		direction: 'forward',
		maxDepth: 1,
		limits: { maxRows: 2, maxFanout: 1000 },
	});
	expect(capped.length).toBe(2);
	client.close();
});

// --- journey --------------------------------------------------------------------

test('P14 fanout: journey does NOT expand a supernode beyond maxFanout', async () => {
	const { client, g } = await freshGraph();
	const s = await supernode(g, 30);
	const guarded = await journey(g.raw, {
		start: s,
		from: 0,
		direction: 'forward',
		limits: { maxFanout: 5 },
	});
	expect(guarded.length).toBe(0); // not expanded → nothing reached beyond the start

	const open = await journey(g.raw, {
		start: s,
		from: 0,
		direction: 'forward',
		limits: { maxFanout: 1000 },
	});
	expect(open.length).toBeGreaterThan(0);
	client.close();
});

test('P14 cap: journey honors maxRows', async () => {
	const { client, g } = await freshGraph();
	const s = await supernode(g, 5);
	const capped = await journey(g.raw, {
		start: s,
		from: 0,
		direction: 'forward',
		limits: { maxRows: 2, maxFanout: 1000 },
	});
	expect(capped.length).toBe(2);
	client.close();
});
