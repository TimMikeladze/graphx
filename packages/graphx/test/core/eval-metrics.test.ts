import { expect, test } from 'bun:test';
import { ndcgAtK, recallAtK, reciprocalRank, round3, scoreRuns } from './eval-metrics.ts';

// The metrics are the yardstick every quality test reads — so they are checked here against
// values computed by hand, not against themselves.

const J = { a: 2, b: 1, c: 1 }; // three relevant docs, `a` graded highest

test('recallAtK: counts relevant docs inside the cut, ignoring irrelevant ones', () => {
	expect(recallAtK(['a', 'b', 'c'], J, 3)).toBe(1);
	expect(recallAtK(['a', 'x', 'y'], J, 3)).toBeCloseTo(1 / 3);
	expect(recallAtK(['x', 'y', 'z'], J, 3)).toBe(0);
	// padding the list with junk does NOT reduce recall (that is precision's job)
	expect(recallAtK(['a', 'x', 'b', 'y', 'c'], J, 5)).toBe(1);
});

test('recallAtK: the cut is enforced — a relevant doc past k does not count', () => {
	expect(recallAtK(['x', 'x', 'x', 'a', 'b', 'c'], J, 3)).toBe(0);
	expect(recallAtK(['x', 'a', 'b', 'c'], J, 2)).toBeCloseTo(1 / 3);
});

test('recallAtK: an empty judgment set is vacuously satisfied', () => {
	expect(recallAtK(['a'], {}, 5)).toBe(1);
	expect(recallAtK(['a'], { a: 0 }, 5)).toBe(1);
});

test('reciprocalRank: 1/rank of the first relevant hit, 0 when there is none', () => {
	expect(reciprocalRank(['a', 'b'], J)).toBe(1);
	expect(reciprocalRank(['x', 'a'], J)).toBe(1 / 2);
	expect(reciprocalRank(['x', 'y', 'c'], J)).toBeCloseTo(1 / 3);
	expect(reciprocalRank(['x', 'y'], J)).toBe(0);
	// grade does not matter, only relevance — a gain-1 hit at rank 1 still scores 1
	expect(reciprocalRank(['b', 'a'], J)).toBe(1);
});

test('ndcgAtK: 1 for the ideal ordering, and grade-sensitive (unlike recall)', () => {
	expect(ndcgAtK(['a', 'b', 'c'], J, 3)).toBe(1);
	// same three docs, but the gain-2 doc demoted → same recall, strictly lower nDCG
	expect(recallAtK(['b', 'c', 'a'], J, 3)).toBe(recallAtK(['a', 'b', 'c'], J, 3));
	expect(ndcgAtK(['b', 'c', 'a'], J, 3)).toBeLessThan(1);
	expect(ndcgAtK(['x', 'y', 'z'], J, 3)).toBe(0);
});

test('ndcgAtK: matches the hand-computed value', () => {
	// ranked [b, a]: gains 1, 2 → DCG = (2^1−1)/log2(2) + (2^2−1)/log2(3) = 1 + 3/1.58496 = 2.89279
	// ideal  [a, b]: gains 2, 1 → IDCG = 3/1 + 1/1.58496 = 3.63093
	expect(round3(ndcgAtK(['b', 'a'], { a: 2, b: 1 }, 2))).toBe(round3(2.89279 / 3.63093));
});

test('scoreRuns: aggregates per-query scores and reports the per-query recalls', () => {
	const runs = [
		['a', 'b', 'c'], // perfect
		['x', 'a', 'y'], // recall 1/3, RR 1/2
	];
	const s = scoreRuns(runs, [J, J], 3);
	expect(s.perQuery).toEqual([1, 1 / 3]);
	expect(s.recall).toBeCloseTo((1 + 1 / 3) / 2);
	expect(s.mrr).toBeCloseTo((1 + 1 / 2) / 2);
	expect(s.ndcg).toBeGreaterThan(0);
	expect(s.ndcg).toBeLessThan(1);
});

test('scoreRuns: an empty run set scores 0 rather than dividing by zero', () => {
	expect(scoreRuns([], [], 3)).toEqual({ recall: 0, mrr: 0, ndcg: 0, perQuery: [] });
});
