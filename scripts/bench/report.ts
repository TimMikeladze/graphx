/**
 * Presentation. Two outputs from one result set: a table to read now, and a JSON file to diff
 * against the next run by hand.
 *
 * Every row carries its corpus statistics into the JSON. A latency without the size of the graph
 * it was measured on is not a fact anyone can use later, and "which corpus was that?" is exactly
 * the question a two-week-old result file gets asked.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import type { CorpusStats } from './corpus.ts';
import type { Result } from './types.ts';

/**
 * Overridable so CI can point two checkouts of the repo at one output directory and then compare
 * their result files without knowing where either one landed.
 */
const RESULTS_DIR = process.env.GRAPHX_BENCH_RESULTS_DIR
	? resolve(process.env.GRAPHX_BENCH_RESULTS_DIR)
	: resolve(import.meta.dirname, '../../bench/results');

/** Adaptive precision: sub-millisecond calls need decimals, multi-second ones do not. */
export function ms(value: number): string {
	if (!Number.isFinite(value)) return '—';
	if (value < 1) return value.toFixed(3);
	if (value < 100) return value.toFixed(2);
	return value.toFixed(1);
}

export function rate(value: number): string {
	if (!Number.isFinite(value)) return '—';
	if (value >= 1000) return `${Math.round(value).toLocaleString()}`;
	if (value >= 10) return value.toFixed(0);
	return value.toFixed(1);
}

const HEADERS = ['case', 'corpus', 'p50 ms', 'p95 ms', 'min', 'max', 'n', 'ops/s'];

function row(result: Result): string[] {
	const s = result.stats;
	return [
		result.case,
		result.variant,
		ms(s.p50),
		ms(s.p95),
		ms(s.min),
		ms(s.max),
		String(s.iters),
		rate(s.opsPerSec),
	];
}

/** Left-align the first two columns (names), right-align the numbers. */
function render(rows: string[][]): string {
	const widths = HEADERS.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)));
	const line = (cells: string[]): string =>
		cells
			.map((cell, c) => {
				const w = widths[c] as number;
				return c < 2 ? cell.padEnd(w) : cell.padStart(w);
			})
			.join('  ')
			.trimEnd();
	const divider = widths.map((w) => '-'.repeat(w)).join('  ');
	return [line(HEADERS), divider, ...rows.map(line)].join('\n');
}

function describeCorpus(stats: CorpusStats): string {
	return `${stats.nodes.toLocaleString()} nodes, ${stats.versions.toLocaleString()} versions, ${stats.edges.toLocaleString()} edges, ${stats.embedded.toLocaleString()} embedded`;
}

export function formatResults(results: Result[]): string {
	const out: string[] = [];
	const suites = [...new Set(results.map((r) => r.suite))];
	for (const suite of suites) {
		const inSuite = results.filter((r) => r.suite === suite);
		out.push('', `## ${suite}`, '');
		for (const variant of new Set(inSuite.map((r) => r.variant))) {
			const first = inSuite.find((r) => r.variant === variant) as Result;
			out.push(`   ${variant}: ${describeCorpus(first.corpus)}`);
		}
		out.push('', render(inSuite.map(row)));
	}
	return out.join('\n');
}

export interface ReportMeta {
	driver: string;
	scales: string[];
	suites: string[];
	startedAt: string;
	durationMs: number;
}

/** Write the machine-readable copy and return its path. */
export function writeReport(results: Result[], meta: ReportMeta): string {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const stamp = meta.startedAt.replace(/[:.]/g, '-');
	const path = `${RESULTS_DIR}/${meta.driver}-${stamp}.json`;
	writeFileSync(path, `${JSON.stringify({ meta, results }, null, 2)}\n`);
	return path;
}
