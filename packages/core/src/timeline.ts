import { FOREVER } from './db.ts';
import type { DbClient } from './dialect.ts';
import { type QueryLimits, resolveLimits } from './governance.ts';

/**
 * The change-point timeline — the aggregate behind the admin explorer's scrubber.
 *
 * A change point is any instant at which the live graph changed: every `valid_from`, and every
 * `valid_to` that is not the FOREVER sentinel. The `valid_to` half is not optional. A retraction
 * (`deleteNode`/`deleteEdge`) and a single-valued edge supersession both move a `valid_to`
 * WITHOUT writing a new `valid_from` row, so a `valid_from`-only timeline — which is exactly what
 * {@link changeFeed} emits, by decision A.3 — would silently hide every delete.
 */

/** Histogram slots when the caller does not ask for a count. */
export const DEFAULT_TIMELINE_BUCKETS = 240;
/** Upper bound on `buckets`: a scrubber never needs more slots than a wide screen has pixels. */
export const MAX_TIMELINE_BUCKETS = 1000;

/** Options for {@link timeline}. */
export interface TimelineOpts {
	/** Window start, inclusive (epoch ms). Defaults to the graph's earliest change point. */
	from?: number;
	/** Window end, inclusive (epoch ms). Defaults to the graph's latest change point. */
	to?: number;
	/** Histogram slots over the window. Clamped to [1, {@link MAX_TIMELINE_BUCKETS}]. */
	buckets?: number;
	/** §19.2 governance caps; `maxRows` bounds the tick list (default 10k). */
	limits?: Partial<QueryLimits>;
}

/** The change-point extent, a density histogram over a window, and the instants to snap to. */
export interface Timeline {
	/** Earliest change point over ALL time, ignoring `from`/`to`. `null` on an empty graph. */
	min: number | null;
	/** Latest change point over ALL time, ignoring `from`/`to`. `null` on an empty graph. */
	max: number | null;
	/** Change-point count over the full extent. */
	total: number;
	/** The window actually bucketed — the resolved `from`/`to`. */
	from: number;
	to: number;
	/** Length is the resolved bucket count; each slot is a change-point count over the window. */
	buckets: number[];
	/** Distinct change instants in the window, ascending. Drives snap-to-change and step. */
	ticks: number[];
	/** True when `ticks` hit the row cap — narrow the window for an exact list. */
	ticksTruncated: boolean;
}

/** Every change point in the graph, as a single `t` column. */
const CHANGE_POINTS = `
	SELECT valid_from AS t FROM node_versions
	UNION ALL SELECT valid_to AS t FROM node_versions WHERE valid_to < ${FOREVER}
	UNION ALL SELECT valid_from AS t FROM edge_versions
	UNION ALL SELECT valid_to AS t FROM edge_versions WHERE valid_to < ${FOREVER}`;

/** Read one numeric column off the first row, treating a missing row or NULL as `null`. */
function num(row: Record<string, unknown> | undefined, key: string): number | null {
	const v = row?.[key];
	return v === undefined || v === null ? null : Number(v);
}

/**
 * Aggregate the graph's change points into an extent, a density histogram and a snap-tick list.
 *
 * Three queries: the unwindowed extent (so a caller always knows the full range it is scrubbing
 * within), the windowed ticks, and the windowed histogram.
 */
export async function timeline(raw: DbClient, opts: TimelineOpts = {}): Promise<Timeline> {
	const buckets = Math.min(
		Math.max(1, Math.trunc(opts.buckets ?? DEFAULT_TIMELINE_BUCKETS)),
		MAX_TIMELINE_BUCKETS,
	);
	const cap = resolveLimits(opts.limits).maxRows;

	const extent = await raw.execute({
		sql: `SELECT MIN(t) AS lo, MAX(t) AS hi, COUNT(*) AS n FROM (${CHANGE_POINTS}) cp`,
		args: [],
	});
	const head = extent.rows[0] as unknown as Record<string, unknown> | undefined;
	const lo = num(head, 'lo');
	const hi = num(head, 'hi');
	if (lo === null || hi === null) {
		return {
			min: null,
			max: null,
			total: 0,
			from: opts.from ?? 0,
			to: opts.to ?? 0,
			buckets: Array.from({ length: buckets }, () => 0),
			ticks: [],
			ticksTruncated: false,
		};
	}
	const total = num(head, 'n') ?? 0;
	const from = opts.from ?? lo;
	const to = opts.to ?? hi;

	// Over-fetch one past the cap to detect truncation without a second query (the `feedStream`
	// trick from temporal.ts).
	const tickRows = await raw.execute({
		sql: `SELECT DISTINCT t FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ? ORDER BY t LIMIT ?`,
		args: [from, to, cap + 1],
	});
	const found = (tickRows.rows as unknown as Array<Record<string, unknown>>).map((r) =>
		Number(r.t),
	);
	const ticksTruncated = found.length > cap;
	const ticks = ticksTruncated ? found.slice(0, cap) : found;

	const counts = Array.from({ length: buckets }, () => 0);
	const span = to - from;
	if (span <= 0) {
		// Every change point in the window shares one instant — there is nothing to spread, and
		// dividing by the span would be a divide-by-zero. One slot holds them all.
		const one = await raw.execute({
			sql: `SELECT COUNT(*) AS n FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ?`,
			args: [from, to],
		});
		counts[0] = num(one.rows[0] as unknown as Record<string, unknown>, 'n') ?? 0;
		return { min: lo, max: hi, total, from, to, buckets: counts, ticks, ticksTruncated };
	}

	// BIGINT, not INTEGER. The real overflow guard is that `valid_from`/`valid_to` are declared
	// `bigint` on Postgres (dialect-sql.ts:110-111, 128-129), so `t`'s arithmetic is already
	// promoted to 64-bit by the column type before this cast ever runs. The cast still earns its
	// place: it makes the intended width explicit rather than leaning on implicit promotion, and
	// it is the one spelling valid on both dialects (native on Postgres, INTEGER affinity on SQLite).
	const bucketRows = await raw.execute({
		sql: `SELECT CAST((t - ?) * ? / ? AS BIGINT) AS b, COUNT(*) AS n
			FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ? GROUP BY b ORDER BY b`,
		args: [from, buckets, span, from, to],
	});
	for (const r of bucketRows.rows as unknown as Array<Record<string, unknown>>) {
		// t === to bins one past the end; clamp rather than branch in SQL.
		const idx = Math.min(buckets - 1, Math.max(0, Number(r.b)));
		counts[idx] = (counts[idx] ?? 0) + Number(r.n);
	}
	return { min: lo, max: hi, total, from, to, buckets: counts, ticks, ticksTruncated };
}
