import { describe, expect, test } from 'bun:test';
import truth from './fixtures/fts-ground-truth.json';
import { createDuckClient } from '../src/duck.ts';
import { buildIndex } from '../src/fts/build.ts';
import { bm25Cte, FTS_DDL } from '../src/fts/index-tables.ts';
import { tokenize } from '../src/fts/tokenize.ts';

/** A DuckDB loaded with our index over the ground-truth corpus. No fts extension involved. */
async function indexed() {
	const c = createDuckClient();
	await c.executeMultiple(FTS_DDL);
	const ix = buildIndex(truth.corpus.map((d) => ({ ver: d.ver, body: d.body, live: true })));
	for (const d of ix.docs) {
		await c.execute({ sql: 'INSERT INTO fts_docs VALUES (?,?,?)', args: [d.ver, d.len, d.live] });
	}
	for (const t of ix.terms) {
		await c.execute({
			sql: 'INSERT INTO fts_terms VALUES (?,?,?,?)',
			args: [t.ver, t.term, t.tf, t.live],
		});
	}
	for (const d of ix.dict) {
		await c.execute({ sql: 'INSERT INTO fts_dict VALUES (?,?)', args: [d.term, d.df] });
	}
	await c.execute({
		sql: 'INSERT INTO fts_stats (num_docs, avgdl) VALUES (?,?)',
		args: [ix.stats.num_docs, ix.stats.avgdl],
	});
	return c;
}

async function score(c: Awaited<ReturnType<typeof indexed>>, query: string) {
	const r = await c.execute({
		sql: `WITH scored AS (${bm25Cte('all')}) SELECT ver, score FROM scored ORDER BY score DESC, ver`,
		args: [JSON.stringify(tokenize(query))],
	});
	return r.rows.map((row) => ({ ver: Number(row.ver), score: Number(row.score) }));
}

describe('bm25', () => {
	test('reproduces DuckDB match_bm25 to within floating-point noise', async () => {
		// The whole reason Task 1 exists. If this drifts, the formula is wrong - not the fixture.
		const c = await indexed();
		for (const [query, expected] of Object.entries(truth.duckdb.bm25)) {
			const got = await score(c, query);
			expect(got.map((g) => g.ver)).toEqual(expected.map((e) => e.ver));
			for (let i = 0; i < expected.length; i++) {
				expect(got[i]?.score).toBeCloseTo(expected[i]?.score as number, 6);
			}
		}
		await c.end();
	});

	test('a query whose terms are all absent scores nothing rather than erroring', async () => {
		const c = await indexed();
		expect(await score(c, 'missing')).toEqual([]);
		await c.end();
	});

	test('an empty term list scores nothing', async () => {
		// sanitizeMatch returns null here and the caller skips the leg, but the SQL must not
		// blow up if it is ever reached with an empty array.
		const c = await indexed();
		const r = await c.execute({
			sql: `WITH scored AS (${bm25Cte('all')}) SELECT count(*) AS n FROM scored`,
			args: ['[]'],
		});
		expect(r.rows[0]?.n).toBe(0);
		await c.end();
	});

	test('a repeated term outranks a single mention of it', async () => {
		const c = await indexed();
		const ranked = await score(c, 'graph');
		// ver 5 is 'graph graph graph repeated term document'.
		expect(ranked[0]?.ver).toBe(5);
		await c.end();
	});

	test('the live scope excludes history rows', async () => {
		const c = await indexed();
		await c.execute(`UPDATE fts_docs SET live = false WHERE ver = 5`);
		await c.execute(`UPDATE fts_terms SET live = false WHERE ver = 5`);
		const r = await c.execute({
			sql: `WITH scored AS (${bm25Cte('live')}) SELECT ver FROM scored ORDER BY score DESC`,
			args: [JSON.stringify(tokenize('graph'))],
		});
		const vers = r.rows.map((row) => Number(row.ver));
		expect(vers).not.toContain(5);
		// 'graph' also appears in vers 1, 2, 3, and 7 - they must still come back live.
		expect(vers.sort()).toEqual([1, 2, 3, 7]);
		await c.end();
	});

	test('a second row in fts_stats is rejected rather than silently doubling every score', async () => {
		const c = await indexed();
		await expect(
			c.execute({
				sql: 'INSERT INTO fts_stats (num_docs, avgdl) VALUES (?,?)',
				args: [9, 6.0],
			}),
		).rejects.toThrow();
		await c.end();
	});
});
