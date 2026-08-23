import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { bulkEdges, bulkLoad } from '../../src/core/bulk.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { createDuckClient } from '../../src/core/duck.ts';
import { Graph } from '../../src/core/graph.ts';
import { journey } from '../../src/core/journey.ts';
import { match } from '../../src/core/pattern.ts';
import { init } from '../../src/core/schema.ts';

// T11 — the bulk/journey/pattern duckdb arms, exercised end-to-end against a real DuckDB
// client through the real Graph write path (g.addNode/g.addEdge). This only works because
// the schema fix (dialect-sql.ts's duckdbSchema) made node_versions/edge_versions real
// tables again — an earlier version split them into live/history tables behind UNION ALL
// compatibility views, which DuckDB refuses to INSERT into. See dialect-sql.ts's
// duckdbSchema doc comment and the commit history for the full story.

const SCHEMA = defineGraphSchema({
	nodes: {
		Doc: z.object({
			slug: z.string().optional(),
			rank: z.number().optional(),
			i: z.number().optional(),
		}),
	},
	edges: {
		links: { from: 'Doc', to: 'Doc' },
		next: { from: 'Doc', to: 'Doc' },
	},
});

async function graph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const client = createDuckClient();
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

describe('duckdb query paths', () => {
	test('a pattern .where() on a string prop matches', async () => {
		const { client, g } = await graph();
		await g.addNode({ type: 'Doc', data: { slug: 'alpha' } });
		await g.addNode({ type: 'Doc', data: { slug: 'beta' } });
		const q = await match(SCHEMA, client).node('d', 'Doc').where('d', 'slug', 'alpha').select('d');
		const rows = await q.run();
		expect(rows).toHaveLength(1);
		await client.end();
	});

	test('a pattern .where() on a numeric prop matches', async () => {
		const { client, g } = await graph();
		await g.addNode({ type: 'Doc', data: { rank: 3 } });
		const q = await match(SCHEMA, client).node('d', 'Doc').where('d', 'rank', 3).select('d');
		const rows = await q.run();
		expect(rows).toHaveLength(1);
		await client.end();
	});

	test('keyset pagination returns every row exactly once', async () => {
		const { client, g } = await graph();
		for (let i = 0; i < 7; i++) await g.addNode({ type: 'Doc', data: { i } });
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const r = await g.listNodes({ type: 'Doc', limit: 3, cursor });
			for (const n of r.nodes) {
				expect(seen.has(n.id)).toBe(false);
				seen.add(n.id);
			}
			if (!r.nextCursor) break;
			cursor = r.nextCursor;
		}
		expect(seen.size).toBe(7);
		await client.end();
	});

	test('bulkLoad inserts nodes and edges', async () => {
		const { client, g } = await graph();
		// The brief calls a single `g.bulkLoad({ nodes, edges })`; the real API is two
		// standalone functions from bulk.ts — bulkLoad for nodes, bulkEdges for edges.
		await bulkLoad(client, SCHEMA, [
			{ id: '01AAA', type: 'Doc', data: {} },
			{ id: '01BBB', type: 'Doc', data: {} },
		]);
		await bulkEdges(client, SCHEMA, [{ src: '01AAA', dst: '01BBB', rel: 'links' }]);
		expect((await g.listNodes({ type: 'Doc' })).nodes).toHaveLength(2);
		expect(await g.neighbors('01AAA')).toHaveLength(1);
		await client.end();
	});

	test('journey walks a chain', async () => {
		const { client, g } = await graph();
		const a = await g.addNode({ type: 'Doc', data: {} });
		const b = await g.addNode({ type: 'Doc', data: {} });
		const c = await g.addNode({ type: 'Doc', data: {} });
		await g.addEdge({ src: a.id, dst: b.id, rel: 'next' });
		await g.addEdge({ src: b.id, dst: c.id, rel: 'next' });
		// journey() is standalone (raw, opts), not a Graph method; `from` (epoch ms) is
		// required — 0 walks the whole timeline, matching p7-journey.test.ts's convention.
		const hops = await journey(client, { start: a.id, from: 0, rels: ['next'], maxDepth: 3 });
		expect(hops.map((h) => h.id)).toContain(c.id);
		await client.end();
	});

	// pattern.ts's row-value keyset takes an OR-form on duckdb (row-value comparison with
	// untyped parameters is unverified there — see pattern.ts's keysetPredicate), generalized
	// over however many aliases `.select(...)` picks. Both arities get their own committed
	// page-boundary no-dup/no-skip test: a hardcoded 2-column form would emit invalid SQL for
	// the 1-alias case (referencing an undefined second column), and the pagination test above
	// (g.listNodes, a single-column `id > ?` cursor) never goes through pattern.ts at all, so
	// it would not have caught a bug here.

	test('pattern .page() keysets a single-alias result with no overlap or skip', async () => {
		const { client, g } = await graph();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push((await g.addNode({ type: 'Doc', data: { i } })).id);
		const seen = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const q = await match(SCHEMA, client).node('d', 'Doc').select('d');
			const p = await q.page({ limit: 2, cursor });
			for (const row of p.rows) {
				expect(seen.has(row.d.id)).toBe(false);
				seen.add(row.d.id);
			}
			if (!p.nextCursor) break;
			cursor = p.nextCursor;
		}
		expect(seen).toEqual(new Set(ids));
		await client.end();
	});

	test('pattern .page() keysets a two-alias composite key with no overlap or skip', async () => {
		const { client, g } = await graph();
		const hub = await g.addNode({ type: 'Doc', data: {} });
		const neighbors: string[] = [];
		for (let i = 0; i < 5; i++) {
			const n = await g.addNode({ type: 'Doc', data: {} });
			await g.addEdge({ src: hub.id, dst: n.id, rel: 'next' });
			neighbors.push(n.id);
		}
		const seenPairs: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			const q = await match(SCHEMA, client)
				.node('a', 'Doc')
				.out('next')
				.node('b', 'Doc')
				.select('a', 'b');
			const p = await q.page({ limit: 2, cursor });
			for (const row of p.rows) {
				expect(row.a.id).toBe(hub.id);
				seenPairs.push(row.b.id);
			}
			if (!p.nextCursor) break;
			cursor = p.nextCursor;
		}
		expect(new Set(seenPairs)).toEqual(new Set(neighbors));
		expect(seenPairs.length).toBe(5);
		await client.end();
	});
});
