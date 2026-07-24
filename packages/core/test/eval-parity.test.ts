import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { expect, test } from 'bun:test';
import { hashEmbed } from '../src/retrieve.ts';
import { GOLDEN, seedCorpus } from './fixtures/corpus.ts';
import { makeTestDb, TEST_DRIVER } from './harness.ts';
import { annScored, ftsSeeds } from './retrieval-legs.ts';

/**
 * Cross-dialect ranking parity.
 *
 * libSQL and Postgres run genuinely different retrieval SQL — `vector_top_k` over a DiskANN index
 * vs pgvector `<=>` with HNSW, FTS5 `rank` vs `ts_rank_cd`. Both are cosine and the two backends
 * are meant to be interchangeable, but nothing forced them to AGREE until now: every other test
 * asserts a property ("the nearest seed comes first"), which each dialect can satisfy while
 * ordering the rest differently.
 *
 *   bun test packages/core/test/eval-parity.test.ts                              # libSQL
 *   GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/eval-parity.test.ts  # Postgres
 *
 * Regenerate after an intentional change, ONCE PER DRIVER (each run rewrites only its own
 * `byDialect` section, so the other driver's record survives):
 *
 *   UPDATE_RANKING_GOLDEN=1 bun test packages/core/test/eval-parity.test.ts
 *   UPDATE_RANKING_GOLDEN=1 GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/eval-parity.test.ts
 *
 * The file is split by what the dialects are actually required to agree on:
 *
 *  - `shared` — cosine DISTANCE per document, rounded to 6 places, plus the nearest document.
 *    Asserted against both drivers. Ranking is not compared directly because ties are ordinary
 *    (`halting-problem` and `bletchley-park` sit at exactly the same distance) and a tie that
 *    straddles the top-k cut is resolved by each engine's physical row order — a real difference
 *    in output that is nobody's bug. Distance is the quantity both engines must agree on; rank is
 *    a view over it, so pinning distance catches every genuine divergence without failing on
 *    coin-flips.
 *  - `byDialect` — the lexical leg. Both dialects now OR their terms, but Postgres stems and
 *    drops stopwords while FTS5's default tokenizer does neither, so the matched sets still
 *    differ on the same text. Recorded per driver.
 *
 * Nothing downstream of an ANN tie-break is recorded at all. libSQL's `vector_top_k` orders tied
 * rows nondeterministically — the SAME query against the SAME database returns `[halting-problem,
 * bletchley-park]` on one call and the reverse on the next (see the determinism test in
 * `eval-invariants.test.ts`). Pinning the fused ranking or the hybrid walk would therefore be a
 * flaky test rather than a regression guard, so parity is asserted on distances, which are exact.
 */

const GOLDEN_PATH = `${import.meta.dir}/fixtures/ranking-golden.json`;
const K = 6;
const embed = hashEmbed();

/** Rankings are recorded by SLUG: node ids are ULIDs minted per run and differ every time. */
interface RankingGolden {
	/** Dialect-independent: `slug → cosine distance` (6dp) plus the nearest document. */
	shared: Record<string, { nearest: string; dist: Record<string, number> }>;
	/** Dialect-dependent lexical results, keyed by driver name. Sorted — FTS rank can tie too. */
	byDialect: Record<string, Record<string, { ftsSet: string[] }>>;
}

/** Recorded precision. Kept generous so the file shows the real values; comparison uses TOLERANCE. */
function round9(n: number): number {
	return Math.round(n * 1e9) / 1e9;
}

/**
 * Decimal places the two engines must agree to. They compute cosine over the same float32 vectors
 * but with different kernels, so values drift around the 8th significant digit (0.692206502 vs
 * 0.692206494). Comparing rounded values would fail whenever a pair straddles a rounding boundary;
 * a tolerance asserts what actually matters — agreement far tighter than any ranking-relevant gap.
 */
const DIST_PLACES = 5;

function readGolden(): RankingGolden {
	if (!existsSync(GOLDEN_PATH)) return { shared: {}, byDialect: {} };
	return JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as RankingGolden;
}

test(`ranking parity: ${TEST_DRIVER} matches the committed golden ranking`, async () => {
	const db = makeTestDb();
	const { slugOf } = await seedCorpus(db.client, embed);
	const slugs = (ids: string[]): string[] => ids.map((id) => slugOf.get(id) as string);

	const shared: RankingGolden['shared'] = {};
	const mine: RankingGolden['byDialect'][string] = {};
	for (const { query } of GOLDEN) {
		const scored = await annScored(db.client, embed, query);
		const dist: Record<string, number> = {};
		for (const s of scored) dist[slugOf.get(s.id) as string] = round9(s.dist);
		shared[query] = { nearest: slugOf.get(scored[0]?.id as string) as string, dist };
		mine[query] = { ftsSet: slugs(await ftsSeeds(db.client, query, K)).sort() };
	}
	await db.teardown();

	if (process.env.UPDATE_RANKING_GOLDEN !== undefined) {
		const file = readGolden();
		file.shared = shared;
		file.byDialect[TEST_DRIVER] = mine;
		writeFileSync(GOLDEN_PATH, `${JSON.stringify(file, null, '\t')}\n`);
		return;
	}

	const expected = readGolden();
	expect(Object.keys(expected.shared).length).toBeGreaterThan(0);
	const expectedMine = expected.byDialect[TEST_DRIVER];
	// A driver with no recorded section would otherwise pass vacuously.
	expect(expectedMine).toBeDefined();

	// Per-query assertions so a failure names the query that diverged.
	for (const { query } of GOLDEN) {
		const want = expected.shared[query] as RankingGolden['shared'][string];
		const got = shared[query] as RankingGolden['shared'][string];
		expect({ query, nearest: got.nearest }).toEqual({ query, nearest: want.nearest });
		// Same documents scored, and every distance within tolerance of the recorded value.
		expect({ query, docs: Object.keys(got.dist).sort() }).toEqual({
			query,
			docs: Object.keys(want.dist).sort(),
		});
		for (const [slug, d] of Object.entries(got.dist)) {
			expect({ query, slug, d }).toEqual({
				query,
				slug,
				d: expect.closeTo(want.dist[slug] as number, DIST_PLACES) as unknown as number,
			});
		}
		expect({ query, ...mine[query] }).toEqual({ query, ...(expectedMine as typeof mine)[query] });
	}
});

test('the golden file covers every query in the judgment set, on this driver', () => {
	if (process.env.UPDATE_RANKING_GOLDEN !== undefined) return;
	const expected = readGolden();
	const queries = GOLDEN.map((q) => q.query).sort();
	// A query added to GOLDEN without regenerating would otherwise be silently unchecked.
	expect(Object.keys(expected.shared).sort()).toEqual(queries);
	expect(Object.keys(expected.byDialect[TEST_DRIVER] ?? {}).sort()).toEqual(queries);
});

test('the lexical leg ORs its terms on BOTH dialects', async () => {
	const db = makeTestDb();
	const { slugOf } = await seedCorpus(db.client, embed);

	// Regression guard for the divergence this suite originally found. Postgres used to hand the
	// raw text to `websearch_to_tsquery`, which ANDs its terms, while libSQL's `sanitizeMatch`
	// ORs them — so a multi-term query only matched a document containing EVERY stem:
	//
	//   libSQL   "who" OR "designed" OR "the" OR "analytical" OR "engine"   → 6 documents
	//   Postgres 'design' & 'analyt' & 'engin'                              → 0 documents
	//
	// With nothing in the lexical leg, `hybridRetrieve` degraded to vector-only — the exact
	// failure mode hybrid retrieval exists to prevent. Both dialects now OR.
	const hits = await ftsSeeds(db.client, 'who designed the analytical engine', K);
	expect(hits.length).toBeGreaterThan(1);

	// The specific documents that AND semantics could never return: each matches SOME terms but
	// no single one contains "designed" and "analytical" and "engine" together.
	const found = new Set(hits.map((id) => slugOf.get(id)));
	expect(found.has('analytical-engine')).toBe(true);
	expect(found.has('charles-babbage')).toBe(true);

	// A term matching nothing must not drag the whole query down to zero hits.
	const withNoise = await ftsSeeds(db.client, 'analytical zzzznotaword', K);
	expect(withNoise.length).toBeGreaterThan(0);

	// A query of nothing but stopwords/noise returns nothing rather than erroring.
	expect((await ftsSeeds(db.client, 'zzzznotaword qqqqnotaword', K)).length).toBe(0);
	await db.teardown();
});

test('the lexical leg tolerates hostile input on BOTH dialects', async () => {
	const db = makeTestDb();
	await seedCorpus(db.client, embed);

	// libSQL is protected by `sanitizeMatch` quoting every token; Postgres is protected by never
	// letting user text reach `tsquery` syntax — each fragment is a tsquery Postgres itself
	// produced. Both must survive operator soup without throwing or changing the query shape.
	for (const nasty of [
		'"',
		'analytical OR 1',
		'body: secret',
		'a NEAR b',
		'analytical*',
		"'); DROP TABLE node_versions; --",
		'foo(bar',
		'^analytical',
		'-analytical',
		'""""',
		'a | b & c',
		'!analytical',
	]) {
		const rows = await ftsSeeds(db.client, nasty, K);
		expect(Array.isArray(rows)).toBe(true);
	}
	await db.teardown();
});
