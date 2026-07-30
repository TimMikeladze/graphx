import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { FOREVER } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { duckdbSchema } from '../src/dialect-sql.ts';
import { createDuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';

const SCHEMA = defineGraphSchema({ nodes: { Doc: z.object({}) }, edges: {} });

async function local() {
	const c = createDuckClient();
	await c.executeMultiple(duckdbSchema(4));
	return c;
}

const root = mkdtempSync(join(tmpdir(), 'graphx-fts-freshness-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A bucket-backed client — exercises `duck-commit.ts`'s commit-time rebuild path. */
function bucketBacked(store: MemoryObjectStore) {
	return createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
}

/**
 * Count how many times `rebuildIndex` actually runs, by intercepting the one
 * `DELETE FROM fts_terms` it issues per rebuild at the connection level — below both
 * `DuckClient.execute` and the interactive transaction `ensureFtsFresh` now runs the
 * rebuild inside, so it catches the DELETE regardless of which path issued it. Reaches
 * into the private pool because there is no public rebuild-count seam, and none should
 * exist just for this test.
 */
function countRebuilds(c: ReturnType<typeof createDuckClient>): () => number {
	let rebuilds = 0;
	const pool = (
		c as unknown as {
			pool: {
				acquire: () => Promise<{
					run: (sql: unknown, ...rest: unknown[]) => Promise<unknown>;
					release: () => void;
				}>;
			};
		}
	).pool;
	const origAcquire = pool.acquire.bind(pool);
	pool.acquire = async () => {
		const conn = await origAcquire();
		const origRun = conn.run.bind(conn);
		conn.run = async (sql: unknown, ...rest: unknown[]) => {
			if (typeof sql === 'string' && sql.includes('DELETE FROM fts_terms')) rebuilds++;
			return origRun(sql, ...rest);
		};
		return conn;
	};
	return () => rebuilds;
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
		// Counting rows per page alone does not pin this: a rebuild-per-query implementation
		// (i.e. one with no re-check inside serializeWrite) satisfies "each page has 1 row"
		// exactly as well. Count the rebuilds themselves instead — rebuildIndex issues exactly
		// one `DELETE FROM fts_terms` per rebuild.
		const c = await local();
		const rebuildCount = countRebuilds(c);
		const g = new Graph(c, SCHEMA);
		await g.addNode({ type: 'Doc', body: 'mercury venus', data: {} });
		const pages = await Promise.all([
			g.listNodes({ q: 'mercury' }),
			g.listNodes({ q: 'venus' }),
			g.listNodes({ q: 'mercury' }),
		]);
		for (const p of pages) expect(p.nodes.length).toBe(1);
		expect(rebuildCount()).toBe(1);
		await c.end();
	});

	test('a raw write landing during a rebuild is still found by a later search', async () => {
		// Regression for the lost-update race: the old code wrote both freshness markers
		// AFTER rebuildIndex finished reading node_versions, so a raw write landing in that
		// window was erased twice over — its (nonexistent, for a raw writer) markFtsStale()
		// overwritten back to false, and the recorded signature counting a row the rebuild
		// never read. The fix captures the corpus signature and clears the flag BEFORE the
		// rebuild starts, so such a write costs at worst one extra rebuild rather than being
		// lost forever. Swept across several delays, mirroring the reviewer's repro.
		const c = await local();
		const g = new Graph(c, SCHEMA);
		const delays = [0, 1, 3, 6, 10, 20, 30];
		for (const [i, delay] of delays.entries()) {
			// A fresh doc marks the index stale and forces a real rebuild each iteration.
			await g.addNode({ type: 'Doc', body: `alpha${i}`, data: {} });
			const id = `raw-race-${i}`;
			const term = `narwhal${i}`;
			const rebuildQuery = g.listNodes({ q: 'alpha' });
			const rawInsert = (async () => {
				if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
				await c.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
				await c.execute({
					sql: 'INSERT INTO node_versions (id, type, body, valid_from, valid_to) VALUES (?,?,?,?,?)',
					args: [id, 'Doc', term, 0, FOREVER],
				});
			})();
			await Promise.all([rebuildQuery, rawInsert]);
			expect((await g.listNodes({ q: term })).nodes.length).toBe(1);
		}
		await c.end();
	});

	test('a concurrent reader never sees a half-built index mid-rebuild', async () => {
		// Regression for the half-built-index race: rebuildIndex issues four DELETEs and
		// chunked INSERTs as separate autocommit statements, and readers deliberately do not
		// join the write chain, so a query could land between them and see the emptied index —
		// silently zero results rather than an error. The fix runs the rebuild inside one
		// interactive transaction; DuckDB's MVCC keeps a reader on a different connection
		// pinned to the pre-rebuild snapshot until the transaction commits, so it sees either
		// the full old index or the full new one, never an emptied one in between.
		const c = await local();
		const g = new Graph(c, SCHEMA);
		const N = 50;
		for (let i = 0; i < N; i++) {
			await g.addNode({ type: 'Doc', body: 'alpha', data: {} });
		}
		await g.listNodes({ q: 'alpha' }); // warm: the index now holds all N docs
		await g.addNode({ type: 'Doc', body: 'alpha', data: {} }); // marks it stale again

		const rebuildQuery = g.listNodes({ q: 'alpha' }); // triggers the rebuild
		const delays = [0, 1, 3, 6, 10];
		const reads = delays.map(async (delay) => {
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			const r = await c.execute('SELECT count(*) AS n FROM fts_docs');
			return Number(r.rows[0]?.n ?? 0);
		});
		const [, ...counts] = await Promise.all([rebuildQuery, ...reads]);
		for (const n of counts) expect(n).toBeGreaterThan(0);
		await c.end();
	});

	test('a concurrent reader never sees a half-built index during a bucket-backed commit', async () => {
		// Same half-built-index race as above, but through duck-commit.ts's commit-time
		// rebuild rather than ensureFtsFresh — the second of the two call sites rebuildIndex
		// now owns its own atomicity for, rather than each caller wrapping its own call.
		//
		// A commit does substantially more work before it reaches the FTS rebuild (exporting
		// every other dirty snapshot table first), so a handful of fixed delays is not
		// reliable — unlike the ensureFtsFresh path, there is no way to know in advance when
		// the vulnerable window opens. Poll continuously for the whole commit instead of
		// guessing a delay, so every sample across the commit's whole duration is checked.
		const store = new MemoryObjectStore();
		const c = bucketBacked(store);
		const g = new Graph(c, SCHEMA);
		const N = 50;
		await g.write(async (s) => {
			for (let i = 0; i < N; i++) await s.addNode({ type: 'Doc', body: 'alpha', data: {} });
		});

		let polling = true;
		const observed: number[] = [];
		const poll = (async () => {
			while (polling) {
				const r = await c.execute('SELECT count(*) AS n FROM fts_docs');
				observed.push(Number(r.rows[0]?.n ?? 0));
			}
		})();

		await g.write(async (s) => {
			await s.addNode({ type: 'Doc', body: 'alpha', data: {} }); // dirties node_versions
		});
		polling = false;
		await poll;

		expect(observed.length).toBeGreaterThan(0); // the poll must have actually sampled something
		for (const n of observed) expect(n).toBeGreaterThan(0);
		await c.end();
	});
});
