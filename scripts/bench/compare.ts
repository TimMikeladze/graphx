/**
 * Diff two benchmark runs and render the result as markdown.
 *
 * The point of this file is to make a comparison readable without making it authoritative. Two
 * runs on the same GitHub-hosted runner routinely differ by tens of percent on identical code —
 * the VM is shared, the page cache is cold at unpredictable moments, and nothing about a
 * virtualized CI box is a controlled environment. So:
 *
 *  - Deltas are reported, never enforced. Nothing here sets an exit code on a slowdown.
 *  - A delta inside the noise band is rendered plainly; only what is outside it is marked, and a
 *    mark means "look at this", not "this regressed".
 *  - Rows are sorted by the size of the p50 change, so the one thing worth reading is at the top.
 *
 * A comparison is only meaningful when both runs measured the same corpus, which the harness
 * guarantees by fingerprinting the generator inputs — if the two sides disagree about corpus
 * size, the row says so instead of quietly dividing one by the other.
 *
 *   bun scripts/bench/compare.ts base.json head.json [--band 30] [--out summary.md]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { ms } from './report.ts';
import type { Stats } from './runner.ts';
import type { Result } from './types.ts';

export interface RunFile {
	meta: { driver: string; startedAt: string; durationMs: number; scales: string[] };
	results: Result[];
}

export interface Delta {
	suite: string;
	case: string;
	variant: string;
	base: Stats | null;
	head: Stats | null;
	/** Percent change in p50, head relative to base. `null` when one side is missing. */
	p50Pct: number | null;
	p95Pct: number | null;
	/** Set when the two sides measured differently sized corpora — the delta is not comparable. */
	corpusMismatch: boolean;
}

/** Identity of a measured cell across two runs. */
function keyOf(result: Result): string {
	return `${result.suite}\u0000${result.case}\u0000${result.variant}`;
}

function pct(base: number, head: number): number | null {
	if (!Number.isFinite(base) || !Number.isFinite(head) || base === 0) return null;
	return ((head - base) / base) * 100;
}

/**
 * Join two runs on (suite, case, variant). Cells present on only one side are kept — a case that
 * appeared or disappeared is information, and silently dropping it would make the table look like
 * a clean comparison when it is not.
 */
export function compareRuns(base: Result[], head: Result[]): Delta[] {
	const baseByKey = new Map(base.map((r) => [keyOf(r), r]));
	const headByKey = new Map(head.map((r) => [keyOf(r), r]));
	const keys = [...new Set([...baseByKey.keys(), ...headByKey.keys()])];

	const deltas = keys.map((key): Delta => {
		const b = baseByKey.get(key);
		const h = headByKey.get(key);
		const sample = (b ?? h) as Result;
		return {
			suite: sample.suite,
			case: sample.case,
			variant: sample.variant,
			base: b?.stats ?? null,
			head: h?.stats ?? null,
			p50Pct: b && h ? pct(b.stats.p50, h.stats.p50) : null,
			p95Pct: b && h ? pct(b.stats.p95, h.stats.p95) : null,
			corpusMismatch: b !== undefined && h !== undefined && b.corpus.nodes !== h.corpus.nodes,
		};
	});

	// Biggest movers first; cells missing a side sort last, since there is nothing to read in them.
	return deltas.sort((a, z) => Math.abs(z.p50Pct ?? -1) - Math.abs(a.p50Pct ?? -1));
}

function signed(value: number | null): string {
	if (value === null) return '—';
	const rounded = value >= 10 || value <= -10 ? value.toFixed(0) : value.toFixed(1);
	return `${value > 0 ? '+' : ''}${rounded}%`;
}

/** `⚠` outside the band, `·` inside it, and an explicit word when a side is missing. */
function mark(delta: Delta, band: number): string {
	if (delta.base === null) return 'new';
	if (delta.head === null) return 'gone';
	if (delta.corpusMismatch) return 'corpus differs';
	if (delta.p50Pct === null) return '·';
	return Math.abs(delta.p50Pct) > band ? '⚠' : '·';
}

export interface RenderOpts {
	/**
	 * Percent change treated as indistinguishable from runner noise (default 30).
	 *
	 * 30 rather than a tighter number because it was measured, not guessed: two back-to-back runs
	 * of identical code on one machine still moved a case by 35% at p50 once the page cache was
	 * warm, and by 73% when it was not. A band that flags those is a band nobody reads.
	 */
	band?: number;
	baseLabel?: string;
	headLabel?: string;
}

export function renderComparison(deltas: Delta[], opts: RenderOpts = {}): string {
	const band = opts.band ?? 30;
	const base = opts.baseLabel ?? 'base';
	const head = opts.headLabel ?? 'head';

	const rows = deltas.map((d) => [
		mark(d, band),
		`${d.suite} / ${d.case}`,
		d.variant,
		d.base ? ms(d.base.p50) : '—',
		d.head ? ms(d.head.p50) : '—',
		signed(d.p50Pct),
		d.base ? ms(d.base.p95) : '—',
		d.head ? ms(d.head.p95) : '—',
		signed(d.p95Pct),
	]);

	const header = [
		'',
		'case',
		'corpus',
		`${base} p50`,
		`${head} p50`,
		'Δ p50',
		`${base} p95`,
		`${head} p95`,
		'Δ p95',
	];
	const align = ['---', '---', '---', '---:', '---:', '---:', '---:', '---:', '---:'];
	const table = [
		`| ${header.join(' | ')} |`,
		`| ${align.join(' | ')} |`,
		...rows.map((r) => `| ${r.join(' | ')} |`),
	].join('\n');

	const flagged = deltas.filter((d) => mark(d, band) === '⚠').length;

	return [
		`### Benchmark: \`${head}\` vs \`${base}\``,
		'',
		`${deltas.length} cases compared, ${flagged} outside the ±${band}% band.`,
		'',
		'These are timings from a shared CI runner, where identical code routinely varies by tens of',
		'percent. A ⚠ marks a change worth looking at; it is not evidence of a regression on its own.',
		'Reproduce anything interesting locally with `bun run bench` before acting on it.',
		'',
		table,
	].join('\n');
}

function readRun(path: string): RunFile {
	return JSON.parse(readFileSync(path, 'utf8')) as RunFile;
}

function main(argv: string[]): void {
	const positional: string[] = [];
	let band = 30;
	let out: string | undefined;
	let baseLabel: string | undefined;
	let headLabel: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === '--band') band = Number(argv[++i]);
		else if (arg === '--out') out = argv[++i];
		else if (arg === '--base-label') baseLabel = argv[++i];
		else if (arg === '--head-label') headLabel = argv[++i];
		else positional.push(arg);
	}
	const [basePath, headPath] = positional;
	if (!basePath || !headPath) {
		throw new Error('usage: compare.ts <base.json> <head.json> [--band N] [--out FILE]');
	}
	const markdown = renderComparison(
		compareRuns(readRun(basePath).results, readRun(headPath).results),
		{ band, baseLabel, headLabel },
	);
	if (out) writeFileSync(out, `${markdown}\n`);
	console.log(markdown);
}

if (import.meta.main) main(process.argv.slice(2));
