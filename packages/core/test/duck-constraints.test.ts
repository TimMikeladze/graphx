import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { declareSingleValuedRel, declareUniqueNodeProp } from '../src/constraints.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';

// T12 — application-level constraint enforcement on DuckDB, exercised through the real
// Graph write path. Uses the standalone declareUniqueNodeProp/declareSingleValuedRel
// functions (constraints.ts) and a real Graph<SCHEMA>, matching the convention every
// other constraints/query test in this package uses (p14-constraints.test.ts,
// duck-queries.test.ts) — Graph's constructor requires a schema, and these two
// declarations are module functions, not Graph methods.

const SCHEMA = defineGraphSchema({
	nodes: {
		Doc: z.object({ slug: z.string().optional(), extra: z.number().optional() }),
		Note: z.object({ slug: z.string().optional() }),
	},
	edges: {
		owner: { from: 'Doc', to: 'Doc', single: true },
	},
});

async function graph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const client = createDuckClient();
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

describe('duckdb constraints', () => {
	test('a declared unique prop rejects a duplicate on insert', async () => {
		const { client, g } = await graph();
		await declareUniqueNodeProp(client, { type: 'Doc', prop: 'slug' });
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await expect(g.addNode({ type: 'Doc', data: { slug: 'a' } })).rejects.toThrow(
			/constraint violation/i,
		);
		await client.end();
	});

	test('the same value is allowed under a different type', async () => {
		const { client, g } = await graph();
		await declareUniqueNodeProp(client, { type: 'Doc', prop: 'slug' });
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await g.addNode({ type: 'Note', data: { slug: 'a' } });
		await client.end();
	});

	test('uniqueness is over LIVE rows only — a deleted value can be reused', async () => {
		const { client, g } = await graph();
		await declareUniqueNodeProp(client, { type: 'Doc', prop: 'slug' });
		const n = await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await g.deleteNode(n.id);
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await client.end();
	});

	test('updating a node to a taken value is rejected', async () => {
		const { client, g } = await graph();
		await declareUniqueNodeProp(client, { type: 'Doc', prop: 'slug' });
		await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		const b = await g.addNode({ type: 'Doc', data: { slug: 'b' } });
		await expect(g.updateNode(b.id, { data: { slug: 'a' } })).rejects.toThrow(
			/constraint violation/i,
		);
		await client.end();
	});

	test('updating a node to its own value is allowed', async () => {
		const { client, g } = await graph();
		await declareUniqueNodeProp(client, { type: 'Doc', prop: 'slug' });
		const a = await g.addNode({ type: 'Doc', data: { slug: 'a' } });
		await g.updateNode(a.id, { data: { slug: 'a', extra: 1 } });
		await client.end();
	});

	test('a single-valued rel is enforced by addEdge, not a store-level index', async () => {
		const { client, g } = await graph();
		await declareSingleValuedRel(client, 'owner');
		const a = await g.addNode({ type: 'Doc', data: {} });
		const b = await g.addNode({ type: 'Doc', data: {} });
		const c = await g.addNode({ type: 'Doc', data: {} });
		await g.addEdge({ src: a.id, dst: b.id, rel: 'owner' });
		await g.addEdge({ src: a.id, dst: c.id, rel: 'owner' });
		// The second write supersedes the first rather than coexisting with it.
		const live = await g.neighbors(a.id, { rels: ['owner'] });
		expect(live).toHaveLength(1);
		await client.end();
	});
});
