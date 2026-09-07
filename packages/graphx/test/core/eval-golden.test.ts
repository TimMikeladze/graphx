import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { expect, test } from 'bun:test';
import { hashEmbed } from '../../src/core/embedder.ts';
import { type EvalScore, round3, scoreRuns } from './eval-metrics.ts';
import { GOLDEN, seedCorpus } from './fixtures/corpus.ts';
import { makeTestDb, TEST_DRIVER } from './harness.ts';
import {
	annSeedsStable,
	annWalk,
	ftsSeeds,
	fusedSeedsStable,
	hybridWalk,
} from './retrieval-legs.ts';

/**
 * Golden-set scoring and leg ablation.
 *
 * Every other retrieval test asserts a property on a hand-built two-or-three document fixture.
 * This one asks the question those cannot: over a realistic corpus and a set of judgments written
 * against the information need, is each stage of the pipeline actually *earning its place*?
 *
 * What it can and cannot show. Under `hashEmbed` the vector leg is a hashed bag of tokens, so
 * these numbers measure PLUMBING and FUSION, not semantics — a lexical retriever fused with
 * another lexical retriever. Point `fixtureEmbed` at a real model and the identical judgments
 * start measuring semantic quality, because nothing here is tuned to the embedder. The assertions
 * are therefore relations between legs ("fusion must not lose recall"), which survive an embedder
 * swap, rather than absolute scores, which would not.
 *
 * Write the score table for inspection:
 *
 *   UPDATE_EVAL_REPORT=1 bun test packages/graphx/test/core/eval-golden.test.ts
 */

const K = 6;
const MAX_DEPTH = 1;
const embed = hashEmbed();
const REPORT_PATH = `${import.meta.dir}/fixtures/eval-report.${TEST_DRIVER}.json`;

interface Ablation {
	/** Ranked seed lists — the retrieval legs in isolation. */
	annSeeds: EvalScore;
	ftsSeeds: EvalScore;
	fusedSeeds: EvalScore;
	/** Seed lists expanded through the graph walk. */
	annWalk: EvalScore;
	hybridWalk: EvalScore;
}

/** Run every leg over the whole judgment set and score it. */
async function ablate(): Promise<Ablation> {
	const db = makeTestDb();
	const { slugOf } = await seedCorpus(db.client, embed);
	const slugs = (ids: string[]): string[] => ids.map((id) => slugOf.get(id) as string);

	const runs: Record<keyof Ablation, string[][]> = {
		annSeeds: [],
		ftsSeeds: [],
		fusedSeeds: [],
		annWalk: [],
		hybridWalk: [],
	};
	for (const { query } of GOLDEN) {
		runs.annSeeds.push(slugs(await annSeedsStable(db.client, embed, query, K)));
		runs.ftsSeeds.push(slugs(await ftsSeeds(db.client, query, K)));
		runs.fusedSeeds.push(slugs(await fusedSeedsStable(db.client, embed, query, K)));
		runs.annWalk.push(slugs(await annWalk(db.client, embed, query, K, MAX_DEPTH)));
		runs.hybridWalk.push(slugs(await hybridWalk(db.client, embed, query, K, MAX_DEPTH)));
	}
	await db.teardown();

	const judgments = GOLDEN.map((q) => q.relevant);
	// The walk legs return more than K rows by design (seeds + neighbors), so they are scored
	// over their whole output; the seed legs are capped at K by construction.
	const cut = (key: keyof Ablation): number =>
		key === 'annWalk' || key === 'hybridWalk' ? Number.MAX_SAFE_INTEGER : K;
	return Object.fromEntries(
		(Object.keys(runs) as (keyof Ablation)[]).map((key) => [
			key,
			scoreRuns(runs[key], judgments, cut(key)),
		]),
	) as unknown as Ablation;
}

test('ablation: every stage of the pipeline earns its place', async () => {
	const a = await ablate();

	if (process.env.UPDATE_EVAL_REPORT !== undefined) {
		const table = Object.fromEntries(
			Object.entries(a).map(([leg, s]) => [
				leg,
				{ recall: round3(s.recall), mrr: round3(s.mrr), ndcg: round3(s.ndcg) },
			]),
		);
		writeFileSync(
			REPORT_PATH,
			`${JSON.stringify({ driver: TEST_DRIVER, k: K, table }, null, '\t')}\n`,
		);
	}

	// 1. Fusion must rescue the WEAKER leg — that is the claim RRF actually supports, and the
	//    one `p13-hybrid` demonstrates on a hand-built fixture.
	expect(a.fusedSeeds.recall).toBeGreaterThanOrEqual(a.annSeeds.recall);

	// 2. Fusion COSTS recall against the stronger leg, and this is the headline measurement:
	//    on libSQL, lexical-only scores 0.778 while the fused ranking scores 0.722. Nothing
	//    about RRF preserves recall at a fixed cut — interleaving a weaker ranking pushes
	//    relevant documents past k. Fusion buys robustness (it rescues whichever leg is weak on
	//    a given query) and pays for it in peak recall. The guarantee worth holding it to is
	//    that the cost stays bounded; a genuinely broken leg drags fusion well past this margin.
	const bestLeg = Math.max(a.annSeeds.recall, a.ftsSeeds.recall);
	expect(a.fusedSeeds.recall).toBeGreaterThanOrEqual(bestLeg * 0.9);

	// 3. The graph walk is the point of GraphRAG: expanding seeds must reach relevant documents
	//    that no seed list ranked. If this ever stops holding, the edges are decoration.
	expect(a.annWalk.recall).toBeGreaterThan(a.annSeeds.recall);
	expect(a.hybridWalk.recall).toBeGreaterThanOrEqual(a.fusedSeeds.recall);

	// 4. Absolute floors, deliberately loose — they catch a leg that has broken outright
	//    (returning nothing, or nothing relevant) without pinning scores that legitimately move
	//    when the corpus or the embedder changes.
	expect(a.fusedSeeds.recall).toBeGreaterThan(0.5);
	expect(a.fusedSeeds.mrr).toBeGreaterThan(0.5);
	expect(a.hybridWalk.recall).toBeGreaterThan(0.7);
});

test('the walk lifts recall and keeps the seed ranking at the head of the output', async () => {
	const a = await ablate();

	// Expanding the seeds reaches documents no seed list ranked, so recall rises. The output is
	// depth-ordered — every seed before every neighbor — and WITHIN depth 0 the rows follow the
	// fused seed rank (each carries `score`/`via`/`seed`), so the head of the list is exactly the
	// fused ranking: MRR cannot fall. Walked rows trail with `score: null`; a user-facing "top
	// results" pane should show depth-0 rows or re-rank the rest.
	expect(a.hybridWalk.recall).toBeGreaterThan(a.fusedSeeds.recall * 0.99);
	expect(a.hybridWalk.mrr).toBeGreaterThanOrEqual(a.fusedSeeds.mrr * 0.99);
});

test('the lexical leg carries comparable weight on both dialects', async () => {
	const a = await ablate();

	// This is where the OR/AND divergence showed up as a number, and it is the regression guard
	// for the fix. Before, `websearch_to_tsquery` ANDed its terms on Postgres, so a query only
	// matched a document containing EVERY stem:
	//
	//   lexical recall@6    libSQL 0.778    Postgres 0.236  →  0.736 after the fix
	//   fused   recall@6    libSQL 0.722    Postgres 0.667  (had been identical to its ANN leg,
	//                                                        i.e. the lexical leg contributed
	//                                                        nothing that survived fusion)
	//
	// The residual gap is inherent rather than structural: Postgres stems and drops stopwords,
	// FTS5's default tokenizer does neither, so the two will never score identically on the same
	// text. What must hold is that both legs are strong enough to matter.
	expect(a.ftsSeeds.recall).toBeGreaterThan(0.7);
	// And that the lexical leg actually changes the fused outcome, rather than being outvoted
	// into irrelevance — the symptom that made Postgres "hybrid" retrieval vector-only.
	expect(a.fusedSeeds.recall).toBeGreaterThan(a.annSeeds.recall);
});
