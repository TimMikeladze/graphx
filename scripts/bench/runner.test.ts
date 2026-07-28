import { expect, test } from 'bun:test';
import { measure, percentile, summarize } from './runner.ts';

// The runner's contract is its statistics and its stopping rule; both are pure enough to test
// against a fake clock, which is the only way to assert the elapsed-time branch deterministically.

test('percentile: nearest rank, no interpolation', () => {
	const s = [10, 20, 30, 40];
	expect(percentile(s, 0.5)).toBe(20); // ceil(0.5*4) = 2 -> 20
	expect(percentile(s, 0.95)).toBe(40); // ceil(0.95*4) = 4 -> 40
	expect(percentile(s, 0)).toBe(10); // clamped up to rank 1
	expect(percentile(s, 1)).toBe(40);
});

test('percentile: unsorted input is sorted first, and the caller array is untouched', () => {
	const s = [30, 10, 40, 20];
	expect(percentile(s, 0.5)).toBe(20);
	expect(s).toEqual([30, 10, 40, 20]);
});

test('percentile: empty samples are NaN, not a throw', () => {
	expect(percentile([], 0.5)).toBeNaN();
});

test('summarize: reports p50/p95/min/max/iters and derives ops/sec from p50', () => {
	const stats = summarize([1, 2, 4, 8]);
	expect(stats.p50).toBe(2);
	expect(stats.p95).toBe(8);
	expect(stats.min).toBe(1);
	expect(stats.max).toBe(8);
	expect(stats.iters).toBe(4);
	expect(stats.opsPerSec).toBe(500); // 1000 / 2ms
});

test('measure: warmup iterations are excluded from the samples', async () => {
	// A fake clock advancing 1ms per read makes each call take exactly 2 ticks (t0, then the read
	// after fn) — so every sample is 2, and only the sample COUNT distinguishes the runs.
	let t = 0;
	const clock = () => t++;
	const calls: number[] = [];
	const stats = await measure(
		async (i) => {
			calls.push(i);
		},
		{ warmup: 3, minIters: 10, maxIters: 10, maxMillis: Number.POSITIVE_INFINITY, clock },
	);
	expect(stats.iters).toBe(10);
	expect(calls.length).toBe(13); // 3 warmup + 10 measured
});

test('measure: the iteration index is continuous across warmup and measurement', async () => {
	const calls: number[] = [];
	await measure(
		async (i) => {
			calls.push(i);
		},
		{ warmup: 2, minIters: 3, maxIters: 3, maxMillis: Number.POSITIVE_INFINITY, clock: () => 0 },
	);
	expect(calls).toEqual([0, 1, 2, 3, 4]);
});

test('measure: stops at maxIters when time has not run out', async () => {
	const stats = await measure(async () => {}, {
		warmup: 0,
		minIters: 1,
		maxIters: 7,
		maxMillis: Number.POSITIVE_INFINITY,
		clock: () => 0,
	});
	expect(stats.iters).toBe(7);
});

test('measure: stops once maxMillis is spent', async () => {
	// Clock advances 10 per read; each iteration consumes 3 reads (t0, post-fn, elapsed check),
	// so measured time passes 100 well before the 1000-iteration cap.
	let t = 0;
	const clock = () => (t += 10);
	const stats = await measure(async () => {}, {
		warmup: 0,
		minIters: 1,
		maxIters: 1000,
		maxMillis: 100,
		clock,
	});
	expect(stats.iters).toBeGreaterThan(0);
	expect(stats.iters).toBeLessThan(1000);
});

test('measure: minIters wins over an already-exhausted time budget', async () => {
	// maxMillis 0 means the budget is spent on the first check; the floor must still be honored.
	let t = 0;
	const clock = () => (t += 1000);
	const stats = await measure(async () => {}, {
		warmup: 0,
		minIters: 5,
		maxIters: 1000,
		maxMillis: 0,
		clock,
	});
	expect(stats.iters).toBe(5);
});
