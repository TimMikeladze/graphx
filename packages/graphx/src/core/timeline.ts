import { FOREVER } from './db.ts';
import type { DbClient, SqlResult } from './dialect.ts';
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
	/**
	 * Distinct change instants in the window, ascending. Drives snap-to-change and step.
	 *
	 * On truncation this is a SAMPLE spread evenly across the window — every k-th instant by
	 * rank, always including both ends — not a contiguous slice from either end. A contiguous
	 * slice is the wrong shape either way: earliest-N strands the newest changes past the cut,
	 * and most-recent-N collapses onto the narrow high-density tail near "now" where real graphs
	 * concentrate most of their changes.
	 */
	ticks: number[];
	/** True when `ticks` is a sample rather than the exact list — snapping is approximate; narrow the window (`from`/`to`) for exact precision. */
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
 * The unwindowed extent (so a caller always knows the full range it is scrubbing within), a
 * windowed distinct-instant count (to decide whether the tick list needs sampling and, if so,
 * how coarse), the windowed ticks themselves, and the windowed histogram.
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

	// Count first: below the cap, the plain distinct list stands. Above it, sample every k-th
	// instant by rank so the tick list stays spread across the whole window instead of bunching
	// at one end, always keeping rn=0 and rn=count-1 so both ends stay exact.
	const countRow = await raw.execute({
		sql: `SELECT COUNT(*) AS n FROM (SELECT DISTINCT t FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ?) d`,
		args: [from, to],
	});
	const distinctCount = num(countRow.rows[0] as unknown as Record<string, unknown>, 'n') ?? 0;

	const ticksTruncated = distinctCount > cap;
	let tickRows: SqlResult;
	if (!ticksTruncated) {
		tickRows = await raw.execute({
			sql: `SELECT DISTINCT t FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ? ORDER BY t`,
			args: [from, to],
		});
	} else if (cap <= 1) {
		// A cap this low (a governance-degenerate case no caller exercises — default maxRows is
		// 10k) can't fit both forced endpoints: rn=0 is already selected by any modulo, so forcing
		// rn=lastRn too would return two rows for a cap of one. Fall back to the single most
		// recent instant instead.
		const lastRn = distinctCount - 1;
		tickRows = await raw.execute({
			sql: `SELECT t FROM (
				SELECT t, row_number() OVER (ORDER BY t) - 1 AS rn
				FROM (SELECT DISTINCT t FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ?) d
			) r
			WHERE rn = ?
			ORDER BY t`,
			args: [from, to, lastRn],
		});
	} else {
		// k = ceil((count-1)/(cap-1)), NOT ceil(count/cap): sizing the stride against the number of
		// GAPS between the two forced endpoints (cap-1) rather than the number of slots (cap) is
		// what keeps the modulo selection plus the forced last element from ever exceeding cap. With
		// ceil(count/cap), count=40/cap=8 gives k=5 — the modulo set (rn 0,5,...,35, eight elements)
		// already fills the cap, so forcing the true last (rn=39, not a multiple of 5) makes nine.
		// This formula both bounds the modulo set to at most cap-1 AND guarantees that whenever it
		// would otherwise hit exactly cap-1, the endpoint is already a multiple of k — so the forced
		// add is never a genuine extra.
		const k = Math.ceil((distinctCount - 1) / (cap - 1));
		const lastRn = distinctCount - 1;
		tickRows = await raw.execute({
			sql: `SELECT t FROM (
				SELECT t, row_number() OVER (ORDER BY t) - 1 AS rn
				FROM (SELECT DISTINCT t FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ?) d
			) r
			WHERE rn % ? = 0 OR rn = ?
			ORDER BY t`,
			args: [from, to, k, lastRn],
		});
	}
	const ticks = (tickRows.rows as unknown as Array<Record<string, unknown>>).map((r) =>
		Number(r.t),
	);

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
