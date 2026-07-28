/**
 * The shape a suite contributes. A case owns the call being measured and nothing else — the
 * runner owns timing, the corpus owns data, the report owns presentation.
 */
import type { Corpus, Scale } from './corpus.ts';
import type { MeasureOpts, Stats } from './runner.ts';

/**
 * One corpus a suite runs against. Usually a point on the scale ladder; the `ann` suite instead
 * holds the node count fixed and varies the vector count, because that is the axis its cost lives
 * on.
 */
export interface Variant {
	/** How this variant is labeled in the report ("10k", "10k/5k vec"). */
	label: string;
	scale: Scale;
	/** Cap on embedded nodes; omit for the default. Part of the corpus cache key. */
	embedded?: number;
}

export interface BenchCase<T = void> {
	name: string;
	/** Restrict to some points on the ladder; omit to run everywhere the suite runs. */
	scales?: Scale[];
	/**
	 * The case writes. Mutating cases get a private, restored-per-case copy of the corpus so
	 * their measurements do not accumulate each other's rows.
	 */
	mutates?: boolean;
	/** Per-variant preparation, run outside the timed region. */
	setup?(ctx: Corpus): Promise<T>;
	/** The timed call. `i` is a continuous iteration index — vary inputs by it. */
	run(ctx: Corpus, i: number, state: T): Promise<unknown>;
	/** Override the stopping rule for a case known to be slow (or to be bounded by its inputs). */
	measure?: MeasureOpts;
}

/**
 * Cases are heterogeneous in their setup state, and a suite holds them in one array. Declaring
 * `setup`/`run` as methods (not properties) makes that assignment bivariant, so the erased type
 * needs no `any`.
 */
export type AnyBenchCase = BenchCase<never>;

/** Identity with inference — lets a case's `setup` return type flow into its `run`. */
export function defineCase<T>(bench: BenchCase<T>): AnyBenchCase {
	return bench as AnyBenchCase;
}

export interface Suite {
	name: string;
	cases: AnyBenchCase[];
	/**
	 * The corpora this suite runs against, given the scales the user asked for. Defaults to one
	 * variant per selected scale.
	 */
	variants?(scales: Scale[]): Variant[];
}

/** One measured cell of the report. */
export interface Result {
	suite: string;
	case: string;
	variant: string;
	scale: Scale;
	stats: Stats;
	corpus: Corpus['stats'];
}

/** Cycle through a case's input pool by iteration index. */
export function pick<T>(pool: readonly T[], i: number): T {
	return pool[i % pool.length] as T;
}
