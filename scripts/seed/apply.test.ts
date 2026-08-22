import { expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { Graph, hashEmbed, history, init, retrieve } from '../../packages/core/src/index.ts';
import { applyPlan } from './apply.ts';
import { generate } from './generate.ts';
import { demoSchema } from './schema.ts';
import { withHistory } from './temporal.ts';

// End-to-end over a small graph: the plan the generator produces must actually load, and the
// reads the admin explorer depends on (slice, as-of, history, semantic search) must work on it.

const NOW = 1_780_000_000_000;
const DIM = 64;
const embed = hashEmbed(DIM);

async function loaded(nodes: number) {
	const client = createClient({ url: ':memory:' });
	await init(client, DIM);
	const plan = withHistory(generate({ nodes, seed: 3, now: NOW }), { seed: 4, now: NOW });
	const result = await applyPlan(client, plan, embed);
	return { client, plan, result, graph: new Graph(client, demoSchema) };
}

test('applyPlan: loads every identity, version and edge', async () => {
	const { client, plan, result } = await loaded(600);
	expect(result.nodes).toBe(600);
	expect(result.versions).toBe(plan.nodes.length);
	expect(result.edges).toBe(plan.edges.length);

	const identities = await client.execute('SELECT COUNT(*) AS c FROM node_identity');
	expect(Number(identities.rows[0]?.c)).toBe(600);
	const versions = await client.execute('SELECT COUNT(*) AS c FROM node_versions');
	expect(Number(versions.rows[0]?.c)).toBe(plan.nodes.length);
	// live rows = identities, minus any whose whole timeline is closed (the generator makes none)
	const live = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(live.rows[0]?.c)).toBe(600);
	client.close();
});

test('applyPlan: the canvas slice returns nodes with edges among them', async () => {
	const { client, graph } = await loaded(600);
	const slice = await graph.graphSlice();
	expect(slice.nodes.length).toBe(600);
	expect(slice.links.length).toBeGreaterThan(300);
	expect(slice.truncated).toBe(false);
	const ids = new Set(slice.nodes.map((n) => n.id));
	for (const link of slice.links) {
		expect(ids.has(link.source)).toBe(true);
		expect(ids.has(link.target)).toBe(true);
	}
	client.close();
});

test('applyPlan: the slice is smaller earlier in the temporal window', async () => {
	const { client, graph } = await loaded(600);
	const early = await graph.graphSlice({ asOf: NOW - 60 * 86_400_000 });
	const late = await graph.graphSlice({ asOf: NOW - 1 });
	expect(early.nodes.length).toBeGreaterThan(0);
	expect(early.nodes.length).toBeLessThan(late.nodes.length);
	client.close();
});

test('applyPlan: versioned nodes read back with real history', async () => {
	const { client, plan } = await loaded(600);
	const counts = new Map<string, number>();
	for (const n of plan.nodes) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
	const [id, expected] = [...counts].find(([, c]) => c > 1) as [string, number];
	expect((await history(client, id)).length).toBe(expected);
	client.close();
});

test('applyPlan: type filter and full-text search narrow the slice', async () => {
	const { client, graph } = await loaded(600);
	const people = await graph.graphSlice({ type: 'person' });
	expect(people.nodes.length).toBeGreaterThan(0);
	expect(people.nodes.length).toBeLessThan(600);
	expect(people.nodes.every((n) => n.type === 'person')).toBe(true);

	const matches = await graph.listNodes({ q: 'latency' });
	expect(matches.nodes.length).toBeGreaterThan(0);
	client.close();
});

test('applyPlan: semantic retrieval is seeded by the ANN index', async () => {
	const { client } = await loaded(600);
	const hits = await retrieve(client, embed, { query: 'billing invoice ledger', k: 5 });
	expect(hits.length).toBeGreaterThan(0);
	client.close();
});

test('applyPlan: an empty plan is a no-op', async () => {
	const client = createClient({ url: ':memory:' });
	await init(client, DIM);
	const result = await applyPlan(client, generate({ nodes: 0, seed: 1, now: NOW }), embed);
	expect(result).toEqual({ nodes: 0, versions: 0, edges: 0, embedded: 0 });
	client.close();
});

test('applyPlan: embeds every live node when under the cap', async () => {
	const { client, result } = await loaded(600);
	expect(result.embedded).toBe(600);
	const withEmb = await client.execute('SELECT COUNT(*) AS c FROM nodes WHERE emb IS NOT NULL');
	expect(Number(withEmb.rows[0]?.c)).toBe(600);
	client.close();
});

test('applyPlan: caps the embedded sample and still spreads it across types', async () => {
	const client = createClient({ url: ':memory:' });
	await init(client, DIM);
	const plan = withHistory(generate({ nodes: 600, seed: 3, now: NOW }), { seed: 4, now: NOW });
	const result = await applyPlan(client, plan, embed, { maxEmbedded: 100 });
	expect(result.embedded).toBeLessThanOrEqual(100);
	expect(result.embedded).toBeGreaterThan(50);

	const sampled = await client.execute(
		'SELECT COUNT(DISTINCT type) AS c FROM nodes WHERE emb IS NOT NULL',
	);
	// The stride runs over a type-interleaved load order, so a sample of ~100 hits most types.
	expect(Number(sampled.rows[0]?.c)).toBeGreaterThan(5);

	// Semantic search still works, over the sample.
	expect(
		(await retrieve(client, embed, { query: 'storage replication', k: 5 })).length,
	).toBeGreaterThan(0);
	client.close();
});
