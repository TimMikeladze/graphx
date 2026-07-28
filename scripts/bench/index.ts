/**
 * The benchmark entry point.
 *
 *   bun run bench                              every suite, every scale
 *   bun run bench retrieval traversal          named suites only
 *   bun run bench --scale 1k,10k               a shorter ladder
 *   bun run bench --iters 30                   cap the samples per case
 *   bun run bench --wipe                       rebuild every cached corpus first
 *   GRAPHX_BENCH_DRIVER=postgres bun run bench the same suites through the dialect seam
 *
 * The purpose is bottleneck discovery, not regression gating: nothing here asserts a threshold or
 * compares against a committed baseline. Results land in `bench/results/` for hand comparison.
 *
 * One corpus is opened per suite variant and shared by every read-only case in it. A mutating
 * case instead takes a private restored copy, so its writes cannot leak into anything measured
 * after it.
 *
 * Cached corpora live in `bench/.corpus/` and are not small — the full ladder plus the `ann`
 * variants is a few hundred megabytes, most of it vector index. `--wipe` reclaims it.
 */
import process from 'node:process';
import {
	ALL_SCALES,
	type Corpus,
	DRIVER,
	freshCorpus,
	isScale,
	openCorpus,
	type Scale,
	wipeCorpora,
} from './corpus.ts';
import { formatResults, writeReport } from './report.ts';
import { measure } from './runner.ts';
import { annSuite } from './suites/ann.ts';
import { retrievalSuite } from './suites/retrieval.ts';
import { temporalSuite } from './suites/temporal.ts';
import { traversalSuite } from './suites/traversal.ts';
import { writeSuite } from './suites/write.ts';
import type { AnyBenchCase, Result, Suite, Variant } from './types.ts';

const SUITES: Suite[] = [writeSuite, retrievalSuite, traversalSuite, temporalSuite, annSuite];

interface Args {
	suites: string[];
	scales: Scale[];
	iters?: number;
	wipe: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { suites: [], scales: ALL_SCALES, wipe: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === '--help' || arg === '-h') args.help = true;
		else if (arg === '--wipe') args.wipe = true;
		else if (arg === '--iters') args.iters = Number(argv[++i]);
		else if (arg === '--scale') {
			const requested = String(argv[++i] ?? '')
				.split(',')
				.filter(Boolean);
			const bad = requested.filter((s) => !isScale(s));
			if (bad.length > 0) throw new Error(`unknown scale(s): ${bad.join(', ')}`);
			args.scales = requested.filter(isScale);
		} else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
		else args.suites.push(arg);
	}
	return args;
}

const USAGE = `bench — graphx performance harness

  bun run bench [suite...] [--scale 1k,10k,100k] [--iters N] [--wipe]

suites: ${SUITES.map((s) => s.name).join(', ')}
driver: GRAPHX_BENCH_DRIVER=libsql|postgres (currently ${DRIVER})`;

function log(message: string): void {
	console.log(`[bench] ${message}`);
}

/** The corpora a suite runs against — its own if it declares them, else the scale ladder. */
function variantsOf(suite: Suite, scales: Scale[]): Variant[] {
	if (suite.variants) return suite.variants(scales);
	return scales.map((scale) => ({ label: scale, scale }));
}

function appliesTo(bench: AnyBenchCase, scale: Scale): boolean {
	return bench.scales === undefined || bench.scales.includes(scale);
}

async function runCase(
	suite: Suite,
	bench: AnyBenchCase,
	variant: Variant,
	shared: Corpus,
	iters: number | undefined,
): Promise<Result> {
	// A mutating case gets its own restored copy; everything else reads the shared one.
	const ctx = bench.mutates
		? await freshCorpus(variant.scale, { embedded: variant.embedded, log })
		: shared;
	try {
		const state = bench.setup ? await bench.setup(ctx) : undefined;
		// `--iters` lowers the cap; it never raises a case's own, because some caps exist to keep a
		// case inside its input pool (deleteNode) or its corpus perturbation budget (the bulk cases).
		const cap = bench.measure?.maxIters;
		const maxIters = iters === undefined ? cap : cap === undefined ? iters : Math.min(iters, cap);
		const stats = await measure((i) => bench.run(ctx, i, state as never), {
			...bench.measure,
			...(maxIters === undefined ? {} : { maxIters }),
		});
		return {
			suite: suite.name,
			case: bench.name,
			variant: variant.label,
			scale: variant.scale,
			stats,
			corpus: ctx.stats,
		};
	} finally {
		if (bench.mutates) await ctx.close();
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}
	if (args.wipe) {
		log('wiping cached corpora');
		wipeCorpora();
	}

	const selected =
		args.suites.length === 0
			? SUITES
			: args.suites.map((name) => {
					const suite = SUITES.find((s) => s.name === name);
					if (!suite)
						throw new Error(
							`unknown suite '${name}' — have: ${SUITES.map((s) => s.name).join(', ')}`,
						);
					return suite;
				});

	log(
		`driver=${DRIVER} suites=${selected.map((s) => s.name).join(',')} scales=${args.scales.join(',')}`,
	);

	const startedAt = new Date().toISOString();
	const t0 = performance.now();
	const results: Result[] = [];

	for (const suite of selected) {
		for (const variant of variantsOf(suite, args.scales)) {
			const cases = suite.cases.filter((bench) => appliesTo(bench, variant.scale));
			if (cases.length === 0) continue;
			const shared = await openCorpus(variant.scale, { embedded: variant.embedded, log });
			try {
				for (const bench of cases) {
					log(`${suite.name} / ${variant.label} / ${bench.name}`);
					results.push(await runCase(suite, bench, variant, shared, args.iters));
				}
			} finally {
				await shared.close();
			}
		}
	}

	console.log(formatResults(results));
	const path = writeReport(results, {
		driver: DRIVER,
		scales: args.scales,
		suites: selected.map((s) => s.name),
		startedAt,
		durationMs: Math.round(performance.now() - t0),
	});
	console.log(`\nwrote ${path}`);
}

await main();
