import { expect, test } from 'bun:test';
import { compareRuns, renderComparison } from './compare.ts';
import type { Stats } from './runner.ts';
import type { Result } from './types.ts';

// The comparison's job is to join two runs honestly: never invent a delta it cannot compute, and
// never drop a cell that exists on only one side, because both of those turn an incomplete
// comparison into one that looks complete.

function stats(p50: number, p95 = p50 * 1.5): Stats {
	return { p50, p95, min: p50 * 0.9, max: p95, iters: 10, opsPerSec: 1000 / p50 };
}

function result(name: string, p50: number, nodes = 1_000): Result {
	return {
		suite: 'retrieval',
		case: name,
		variant: '1k',
		scale: '1k',
		stats: stats(p50),
		corpus: { nodes, versions: nodes, edges: nodes * 2, embedded: nodes },
	};
}

test('compareRuns: percent change is head relative to base', () => {
	const [delta] = compareRuns([result('a', 10)], [result('a', 15)]);
	expect(delta?.p50Pct).toBeCloseTo(50);
});

test('compareRuns: an improvement is negative', () => {
	const [delta] = compareRuns([result('a', 10)], [result('a', 5)]);
	expect(delta?.p50Pct).toBeCloseTo(-50);
});

test('compareRuns: joins on suite + case + variant', () => {
	const deltas = compareRuns(
		[result('a', 10), result('b', 20)],
		[result('b', 20), result('a', 10)],
	);
	expect(deltas.length).toBe(2);
	for (const d of deltas) expect(d.p50Pct).toBeCloseTo(0);
});

test('compareRuns: a case present on one side only is kept, not dropped', () => {
	const deltas = compareRuns([result('gone', 10)], [result('new', 10)]);
	expect(deltas.length).toBe(2);
	const gone = deltas.find((d) => d.case === 'gone');
	const added = deltas.find((d) => d.case === 'new');
	expect(gone?.head).toBeNull();
	expect(gone?.p50Pct).toBeNull();
	expect(added?.base).toBeNull();
});

test('compareRuns: differently sized corpora are flagged rather than divided', () => {
	const [delta] = compareRuns([result('a', 10, 1_000)], [result('a', 20, 10_000)]);
	expect(delta?.corpusMismatch).toBe(true);
});

test('compareRuns: biggest mover first', () => {
	const base = [result('small', 10), result('big', 10)];
	const head = [result('small', 11), result('big', 40)];
	const deltas = compareRuns(base, head);
	expect(deltas[0]?.case).toBe('big');
});

test('compareRuns: a zero base yields no delta rather than Infinity', () => {
	const [delta] = compareRuns([result('a', 0)], [result('a', 5)]);
	expect(delta?.p50Pct).toBeNull();
});

test('renderComparison: marks only what is outside the band', () => {
	const deltas = compareRuns(
		[result('noisy', 10), result('slower', 10)],
		[result('noisy', 11), result('slower', 30)],
	);
	const markdown = renderComparison(deltas, { band: 20 });
	expect(markdown).toContain('| ⚠ | retrieval / slower');
	expect(markdown).toContain('| · | retrieval / noisy');
	expect(markdown).toContain('1 outside the ±20% band');
});

test('renderComparison: says plainly that CI timings are noisy', () => {
	const markdown = renderComparison(compareRuns([result('a', 10)], [result('a', 10)]));
	expect(markdown).toContain('shared CI runner');
	expect(markdown).toContain('not evidence of a regression');
});
