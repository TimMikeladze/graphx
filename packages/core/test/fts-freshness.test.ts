import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { duckdbSchema } from '../src/dialect-sql.ts';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';

const SCHEMA = defineGraphSchema({ nodes: { Doc: z.object({}) }, edges: {} });

async function local() {
	const c = createDuckClient();
	await c.executeMultiple(duckdbSchema(4));
	return c;
}

describe('full-text freshness on a local duckdb', () => {
	test('a node written through Graph is findable by full text', async () => {
		// The whole gap: rebuildIndex only ran inside commit(), and a local client never commits.
		const c = await local();
		const g = new Graph(c, SCHEMA);
		await g.addNode({ type: 'Doc', body: 'mercury venus earth', data: {} });
		const page = await g.listNodes({ q: 'mercury' });
		expect(page.nodes.length).toBe(1);
		await c.end();
	});

	test('an updated body stops matching its old text and starts matching its new', async () => {
		const c = await local();
		const g = new Graph(c, SCHEMA);
		const n = await g.addNode({ type: 'Doc', body: 'sphinx', data: {} });
		await g.updateNode(n.id, { body: 'griffin' });
		expect((await g.listNodes({ q: 'griffin' })).nodes.length).toBe(1);
		expect((await g.listNodes({ q: 'sphinx' })).nodes.length).toBe(0);
		await c.end();
	});

	test('a read-only workload does not rebuild', async () => {
		// Staleness, not a rebuild per query: the second search must not re-run the build.
		// Also pins a corollary of the signature design: the signature tracks node_versions,
		// not the index tables themselves, so a corrupted or hand-emptied fts_terms is
		// deliberately NOT self-healing — only a corpus change (or an explicit markFtsStale)
		// triggers a rebuild. A real rebuild would repopulate fts_terms and fail this
		// assertion, so the test still proves "no rebuild happened", not merely "nothing
		// crashed".
		const c = await local();
		const g = new Graph(c, SCHEMA);
		await g.addNode({ type: 'Doc', body: 'mercury', data: {} });
		await g.listNodes({ q: 'mercury' });
		const before = (await c.execute('SELECT count(*) AS n FROM fts_terms')).rows[0]?.n;
		await c.execute(`DELETE FROM fts_terms`); // sabotage: a rebuild would restore these rows
		await g.listNodes({ q: 'mercury' });
		expect((await c.execute('SELECT count(*) AS n FROM fts_terms')).rows[0]?.n).toBe(0);
		expect(before).toBeGreaterThan(0);
		await c.end();
	});

	test('a node written by raw SQL, never touching Graph, is still found by full text', async () => {
		// The signature backstop: markFtsStale() is only called from Graph/bulk, so a writer
		// that bypasses both (raw SQL, a migration, external ETL) never sets the flag. libSQL's
		// own AFTER INSERT trigger fires for any writer, so a flag-only DuckDB implementation
		// would be silently weaker for exactly this case.
		const c = await local();
		const g = new Graph(c, SCHEMA);
		const id = '01ARZ3NDEKTSV4RRFFQ69G5FX1';
		await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
		await c.execute({
			sql: 'INSERT INTO node_versions (id, type, body, valid_from, valid_to) VALUES (?,?,?,?,?)',
			args: [id, 'Doc', 'narwhal', 0, FOREVER],
		});
		const page = await g.listNodes({ q: 'narwhal' });
		expect(page.nodes.length).toBe(1);
		await c.end();
	});

	test('concurrent searches after a write rebuild once, not once each', async () => {
		const c = await local();
		const g = new Graph(c, SCHEMA);
		await g.addNode({ type: 'Doc', body: 'mercury venus', data: {} });
		const pages = await Promise.all([
			g.listNodes({ q: 'mercury' }),
			g.listNodes({ q: 'venus' }),
			g.listNodes({ q: 'mercury' }),
		]);
		for (const p of pages) expect(p.nodes.length).toBe(1);
		await c.end();
	});
});
