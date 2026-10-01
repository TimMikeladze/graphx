import { afterEach, expect, test } from 'bun:test';
import { z } from 'zod';
import { declareUniqueNodeProp, materializeConstraints } from '../../src/core/constraints.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { createDuckClient } from '../../src/core/duck.ts';
import { fork, ForkError } from '../../src/core/fork.ts';
import { Graph } from '../../src/core/graph.ts';
import { createLocalBlobStore } from '../../src/core/local-blobs.ts';
import { init, readEmbeddingMeta } from '../../src/core/schema.ts';
import {
	indexBackedConstraints,
	libsqlOnly,
	makeTestDb,
	stubEmbedder,
	TEST_DRIVER,
} from './harness.ts';

const SCHEMA = defineGraphSchema({
	nodes: { light: z.object({ name: z.string(), green: z.number() }) },
	edges: {
		road: { from: 'light', to: 'light' },
		next: { from: 'light', to: 'light', single: true },
	},
});

const embedder = stubEmbedder((t) => [t.length, 1, 0, 0], { dim: 4 });

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const t of teardowns.splice(0)) await t();
});

function db(): DbClient {
	const t = makeTestDb({ file: true });
	teardowns.push(t.teardown);
	return t.client;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function seeded(opts: { embed?: boolean } = {}) {
	const raw = db();
	await init(raw, opts.embed ? embedder : undefined);
	await materializeConstraints(raw, SCHEMA);
	const g = new Graph(raw, SCHEMA, opts.embed ? { embedder } : {});
	const a = await g.addNode({ type: 'light', data: { name: 'A', green: 30 }, body: 'alpha' });
	const b = await g.addNode({ type: 'light', data: { name: 'B', green: 40 }, body: 'beta' });
	const road = await g.addEdge({ rel: 'road', src: a.id, dst: b.id, weight: 7 });
	return { raw, g, a, b, road };
}

test('a full fork copies the graph and its history, then the two diverge', async () => {
	const { g, a, b, road } = await seeded();
	const t1 = Date.now();
	await tick();
	await g.updateNode(a.id, { data: { name: 'A', green: 35 } });

	const branch = await g.fork(db());
	expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 35 });
	expect((await branch.getNode(a.id, { asOf: t1 }))?.data).toEqual({ name: 'A', green: 30 });
	expect((await branch.listEdges()).edges.map((e) => e.id)).toEqual([road.id]);

	await branch.updateNode(b.id, { data: { name: 'B', green: 60 } });
	await g.deleteEdge(road.id);
	expect((await g.getNode(b.id))?.data).toEqual({ name: 'B', green: 40 });
	expect((await branch.getNode(b.id))?.data).toEqual({ name: 'B', green: 60 });
	expect((await g.listEdges()).edges).toHaveLength(0);
	expect((await branch.listEdges()).edges).toHaveLength(1);
});

test('asOf forks the world as it stood: later versions stay behind, open ones reopen', async () => {
	const { raw, g, a, b, road } = await seeded();
	await tick();
	const cut = Date.now();
	await tick();
	await g.updateNode(a.id, { data: { name: 'A', green: 99 } });
	await g.deleteEdge(road.id);
	const late = await g.addNode({ type: 'light', data: { name: 'C', green: 1 } });

	const target = db();
	const result = await fork(raw, target, { asOf: cut });
	expect(result).toMatchObject({ asOf: cut, nodes: 2, nodeVersions: 2, edges: 1, edgeVersions: 1 });

	const branch = new Graph(target, SCHEMA);
	expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 30 });
	expect(await branch.getNode(late.id)).toBeNull();
	expect((await branch.listEdges()).edges.map((e) => e.id)).toEqual([road.id]);
	expect((await branch.getNode(b.id))?.data).toEqual({ name: 'B', green: 40 });
	// The reopened version is live: the fork can write over it like any other node.
	await branch.updateNode(a.id, { data: { name: 'A', green: 45 } });
	expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 45 });
});

test('vectors travel; a cut re-embeds the nodes whose stored vector is from a later version', async () => {
	const { raw, g, a, b } = await seeded({ embed: true });
	await tick();
	const cut = Date.now();
	await tick();
	await g.updateNode(a.id, { body: 'a much longer body' });

	const full = await fork(raw, db());
	expect(full.vectors).toBe(2);
	expect(full.needsEmbedding).toEqual([]);

	const target = db();
	const cutResult = await fork(raw, target, { asOf: cut });
	expect(cutResult.vectors).toBe(1);
	expect(cutResult.needsEmbedding).toEqual([a.id]);

	const branch = await g.fork(db(), { asOf: cut });
	const report = await branch.embeddingReport();
	expect(report).toMatchObject({ embedded: 2, unembedded: 0, stale: 0 });
	const hits = await branch.retrieve({ query: 'alpha', k: 2 });
	expect(hits.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());
});

test('constraints are re-declared on the target', async () => {
	const { raw, g, a, b } = await seeded();
	await declareUniqueNodeProp(raw, { type: 'light', prop: 'name' });
	await g.addEdge({ rel: 'next', src: a.id, dst: b.id });

	const target = db();
	const result = await fork(raw, target);
	expect(result.constraints).toBe(2);
	const branch = new Graph(target, SCHEMA);
	await expect(branch.addNode({ type: 'light', data: { name: 'A', green: 1 } })).rejects.toThrow();
});

test('refuses a non-empty target and the source itself', async () => {
	const { raw } = await seeded();
	const { raw: other } = await seeded();
	await expect(fork(raw, other)).rejects.toBeInstanceOf(ForkError);
	await expect(fork(raw, raw)).rejects.toBeInstanceOf(ForkError);
});

libsqlOnly('local blobs referenced by copied versions travel with the fork', async () => {
	const { raw, g } = await seeded();
	const blobs = await createLocalBlobStore(raw);
	const ref = await blobs.put(new Uint8Array([1, 2, 3]));
	await blobs.put(new Uint8Array([9])); // unreferenced: stays behind
	await g.addNode({ type: 'light', data: { name: 'D', green: 1 }, uri: ref.uri });

	const target = db();
	expect((await fork(raw, target)).blobs).toBe(1);
	expect(await (await createLocalBlobStore(target)).get(ref.uri)).toEqual(
		new Uint8Array([1, 2, 3]),
	);
});

test.skipIf(TEST_DRIVER !== 'libsql')('forks across backends (libSQL → DuckDB)', async () => {
	const { g, a, b } = await seeded();
	const duck = createDuckClient();
	teardowns.push(() => duck.end());
	const branch = await g.fork(duck);
	expect((await branch.getNode(a.id))?.data).toEqual({ name: 'A', green: 30 });
	expect((await branch.neighbors(a.id)).map((n) => n.id)).toEqual([b.id]);
});

indexBackedConstraints('a copy that fails part-way leaves the target empty again', async () => {
	const { raw, g } = await seeded({ embed: true });
	await g.addNode({ type: 'light', data: { name: 'A', green: 1 } }); // a second 'A' is fine here…
	await raw.execute({
		sql: 'INSERT INTO graph_meta (key, value) VALUES (?, ?)',
		args: ['team', 'roads'],
	});
	const target = db();
	await init(target);
	await declareUniqueNodeProp(target, { type: 'light', prop: 'name' }); // …and refused here

	await expect(fork(raw, target, { method: 'copy' })).rejects.toThrow();
	for (const t of ['node_identity', 'node_versions', 'edge_identity', 'edge_versions']) {
		const n = (await target.execute(`SELECT count(*) AS n FROM ${t}`)).rows[0]?.n;
		expect(Number(n)).toBe(0);
	}
	const keys = (await target.execute('SELECT key FROM graph_meta')).rows.map((r) => String(r.key));
	expect(keys).not.toContain('team');
	expect(await readEmbeddingMeta(target)).toBeNull();
});
