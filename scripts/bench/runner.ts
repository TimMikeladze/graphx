/**
 * The timing core. Everything about *how long* an operation takes is decided here; a suite
 * contributes only the call.
 *
 * Two decisions shape the numbers this produces, and both are deliberate:
 *
 *  - **Warmup is discarded.** The first call into a case pays for the SQLite page cache, the
 *    prepared statement, and whatever the JIT has not seen yet. Folded into the samples that cost
 *    lands entirely in one measurement and skews the tail, so it is paid before the clock starts.
 *  - **p50 and p95, never the mean.** A mean hides GC pauses and write-lock waits inside an
 *    average, and those pauses are exactly what a bottleneck hunt is looking for.
 *
 * The iteration count is not fixed. Each case runs until either `maxMillis` of measured time has
 * elapsed or `maxIters` samples exist, with a floor of `minIters` — so a microsecond call gets a
 * hundred samples and a five-second bulk load gets five, without either being tuned by hand.
 */

export interface Stats {
	/** Median duration in ms. */
	p50: number;
	/** 95th-percentile duration in ms — where the lock waits and GC pauses show. */
	p95: number;
	min: number;
	max: number;
	/** Arithmetic mean in ms — with `stddev`, what a significance test needs. */
	mean: number;
	/** Sample standard deviation in ms (n − 1); 0 for a single sample. */
	stddev: number;
	/** Measured samples (excludes warmup). */
	iters: number;
	/** Derived from p50, not from the total: `1000 / p50`. */
	opsPerSec: number;
}

export interface MeasureOpts {
	/** Iterations run and discarded before measuring (default 3). */
	warmup?: number;
	/** Minimum measured samples, even if `maxMillis` is already spent (default 5). */
	minIters?: number;
	/** Maximum measured samples (default 100). */
	maxIters?: number;
	/** Stop once this much measured time has elapsed, subject to `minIters` (default 2000). */
	maxMillis?: number;
	/** Injectable clock — the tests drive this; production passes nothing. */
	clock?: () => number;
}

/**
 * Nearest-rank percentile over an ascending copy of `samples`: rank = ceil(p × n), 1-indexed,
 * clamped into range. No interpolation — an interpolated p95 reports a duration that never
 * occurred, which is the wrong thing to hand someone chasing a specific slow call.
 */
export function percentile(samples: number[], p: number): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	const rank = Math.ceil(p * sorted.length);
	const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[idx] as number;
}

export function summarize(samples: number[]): Stats {
	const p50 = percentile(samples, 0.5);
	const n = samples.length;
	const mean = n === 0 ? Number.NaN : samples.reduce((a, b) => a + b, 0) / n;
	const variance = n < 2 ? 0 : samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
	return {
		p50,
		p95: percentile(samples, 0.95),
		min: samples.length === 0 ? Number.NaN : Math.min(...samples),
		max: samples.length === 0 ? Number.NaN : Math.max(...samples),
		mean,
		stddev: Math.sqrt(variance),
		iters: samples.length,
		opsPerSec: p50 > 0 ? 1000 / p50 : Number.NaN,
	};
}

/**
 * Run `fn` under the warmup-then-sample protocol and summarize.
 *
 * `fn` receives a monotonically increasing iteration index that never repeats across warmup and
 * measurement. Cases use it to vary their inputs — a different node id, a different query — so
 * that a hundred iterations do not measure one row with a permanently warm cache.
 */
export async function measure(
	fn: (i: number) => Promise<unknown>,
	opts: MeasureOpts = {},
): Promise<Stats> {
	const warmup = opts.warmup ?? 3;
	const minIters = opts.minIters ?? 5;
	const maxIters = opts.maxIters ?? 100;
	const maxMillis = opts.maxMillis ?? 2000;
	const clock = opts.clock ?? (() => performance.now());

	let i = 0;
	for (let w = 0; w < warmup; w++) await fn(i++);

	const samples: number[] = [];
	const started = clock();
	while (samples.length < maxIters) {
		const t0 = clock();
		await fn(i++);
		samples.push(clock() - t0);
		if (samples.length >= minIters && clock() - started >= maxMillis) break;
	}
	return summarize(samples);
}
