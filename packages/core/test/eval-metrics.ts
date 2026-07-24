/**
 * Ranking metrics for retrieval evaluation. Pure functions over a ranked id list plus graded
 * judgments — no database, no embedder.
 *
 * These are the yardstick every quality test reads, so they are unit-tested themselves
 * (`eval-metrics.test.ts`) against hand-computed values. A silently wrong metric would report
 * a healthy score for a broken retriever, which is worse than having no metric at all.
 */

/** Graded judgments for one query: id (or slug) → gain. Anything absent has gain 0. */
export type Judgments = Record<string, number>;

/**
 * Fraction of the relevant set present in the top `k`. Unlike precision this is insensitive to
 * how many irrelevant results came along, which is the right emphasis for a retriever whose
 * output is fed to a reranker or an LLM.
 */
export function recallAtK(ranked: string[], judgments: Judgments, k: number): number {
	const relevant = Object.keys(judgments).filter((id) => (judgments[id] as number) > 0);
	if (relevant.length === 0) return 1;
	const top = new Set(ranked.slice(0, k));
	return relevant.filter((id) => top.has(id)).length / relevant.length;
}

/**
 * Reciprocal rank of the FIRST relevant result (1-indexed), or 0 when none appears. Averaging
 * this across queries gives MRR — the metric that cares only about how fast a user reaches
 * something useful.
 */
export function reciprocalRank(ranked: string[], judgments: Judgments): number {
	for (let i = 0; i < ranked.length; i++) {
		if ((judgments[ranked[i] as string] ?? 0) > 0) return 1 / (i + 1);
	}
	return 0;
}

/** Discounted cumulative gain with the standard exponential gain, `(2^g − 1) / log2(rank + 1)`. */
function dcg(gains: number[]): number {
	return gains.reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
}

/**
 * Normalized DCG at `k` — the only metric here that reads the *grades*, so it distinguishes a
 * run that puts a gain-2 document first from one that leads with a gain-1 document. 1 = the
 * ideal ordering; 0 = nothing relevant in the top `k`.
 */
export function ndcgAtK(ranked: string[], judgments: Judgments, k: number): number {
	const actual = ranked.slice(0, k).map((id) => judgments[id] ?? 0);
	const ideal = Object.values(judgments)
		.filter((g) => g > 0)
		.sort((a, b) => b - a)
		.slice(0, k);
	const idealDcg = dcg(ideal);
	return idealDcg === 0 ? 1 : dcg(actual) / idealDcg;
}

/** Aggregate scores for a retrieval strategy over a whole query set. */
export interface EvalScore {
	/** Mean recall@k across queries. */
	recall: number;
	/** Mean reciprocal rank across queries. */
	mrr: number;
	/** Mean nDCG@k across queries. */
	ndcg: number;
	/** Per-query recall@k, in query order — for pinpointing which need regressed. */
	perQuery: number[];
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Score one strategy over a query set. `runs[i]` is the ranked id list for `judgments[i]`. */
export function scoreRuns(runs: string[][], judgments: Judgments[], k: number): EvalScore {
	const recalls = runs.map((r, i) => recallAtK(r, judgments[i] as Judgments, k));
	return {
		recall: mean(recalls),
		mrr: mean(runs.map((r, i) => reciprocalRank(r, judgments[i] as Judgments))),
		ndcg: mean(runs.map((r, i) => ndcgAtK(r, judgments[i] as Judgments, k))),
		perQuery: recalls,
	};
}

/** Round to 3 decimals for readable assertion failures and stable golden files. */
export function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}
