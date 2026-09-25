/**
 * Turn a bench results file into a Benchable run payload (https://benchable.sh), for
 * `benchable submit`, which sends it and prints the verdict per metric.
 *
 *   bun run bench:benchable --latest --out bench/benchable.json
 *   bunx benchable submit --metrics bench/benchable.json
 *
 * Each case becomes one `bench.<suite>.<case>.<variant>.ms` metric carrying mean, stddev and
 * sample count, so Benchable judges it with Welch's t-test rather than a flat percentage.
 * Branch and commit come from GitHub Actions env, else git.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { Result } from './types.ts';

interface ResultsFile {
	meta: { driver: string; startedAt: string; scales: string[] };
	results: Result[];
}

export interface BenchableMetric {
	value: number;
	unit: string;
	direction: 'lower';
	samples: number;
	mean: number;
	stddev: number;
	min: number;
	max: number;
	p50: number;
	p95: number;
}

/** Metric keys are dotted paths; squash everything else so a case name is a stable key segment. */
export function metricKey(r: Pick<Result, 'suite' | 'case' | 'variant'>): string {
	const seg = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_|_$/g, '');
	return `bench.${seg(r.suite)}.${seg(r.case)}.${seg(r.variant)}.ms`;
}

export function toMetrics(file: ResultsFile): Record<string, BenchableMetric> {
	const metrics: Record<string, BenchableMetric> = {};
	for (const r of file.results) {
		const s = r.stats;
		if (!Number.isFinite(s.p50)) continue;
		metrics[metricKey(r)] = {
			value: s.p50,
			unit: 'ms',
			direction: 'lower',
			samples: s.iters,
			// Files written before mean/stddev existed still upload; they just get a plain delta.
			mean: s.mean ?? s.p50,
			stddev: s.stddev ?? 0,
			min: s.min,
			max: s.max,
			p50: s.p50,
			p95: s.p95,
		};
	}
	return metrics;
}

function git(...args: string[]): string | undefined {
	const out = spawnSync('git', args, { encoding: 'utf8' });
	return out.status === 0 ? out.stdout.trim() || undefined : undefined;
}

function latest(dir: string): string {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => join(dir, f))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	if (files.length === 0) throw new Error(`no results in ${dir}`);
	return files[0] as string;
}

function main(argv: string[]): void {
	const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
	const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
	const path = argv.includes('--latest')
		? latest(process.env.GRAPHX_BENCH_RESULTS_DIR ?? 'bench/results')
		: positional[0];
	if (!path) throw new Error('usage: benchable.ts <results.json> | --latest [--out file]');

	const file = JSON.parse(readFileSync(path, 'utf8')) as ResultsFile;
	const env = process.env;
	const commitSha = env.GITHUB_SHA ?? git('rev-parse', 'HEAD');
	const body = {
		branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git('rev-parse', '--abbrev-ref', 'HEAD'),
		commitSha,
		// Baselines are matched per environment, so a laptop never races a CI runner.
		environment: `${env.CI ? 'ci' : 'local'}-${platform()}-${arch()}-${file.meta.driver}`,
		startedAt: file.meta.startedAt || undefined,
		// A retried CI step returns the original run instead of recording a duplicate.
		idempotencyKey: `${commitSha}-${file.meta.startedAt}`,
		metadata: { driver: file.meta.driver, scales: file.meta.scales.join(','), bun: process.versions.bun },
		metrics: toMetrics(file),
	};
	const json = JSON.stringify(body, null, 2);
	if (out) writeFileSync(out, json);
	else console.log(json);
}

if (import.meta.main) main(process.argv.slice(2));
