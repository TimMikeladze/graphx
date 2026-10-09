import type { Graph, GraphSchema } from '../core/graph.ts';
import { FOREVER } from '../core/runtime.ts';

/**
 * Were the judgments right? Every edge Jev writes is bitemporal and tagged `source: 'jev'`, so
 * the history already records what it decided and what people later closed. Bucket those
 * edges by their `weight` (the probability Jev gave) and read off, per bucket, how many are
 * still live and how many were closed — the overturn rate you set thresholds against.
 */

export interface CalibrationBucket {
	/** `[low, high)` of `weight`; the last bucket includes 1. */
	range: [number, number];
	written: number;
	live: number;
	/** Closed since — retracted by a curator, or superseded. */
	closed: number;
	/** `closed / written`, or `null` for an empty bucket. */
	closedRate: number | null;
}

export async function jevCalibration<S extends GraphSchema>(
	g: Graph<S>,
	opts: { rel: string; buckets?: number; source?: string },
): Promise<CalibrationBucket[]> {
	const n = opts.buckets ?? 5;
	const r = await g.raw.execute({
		sql: 'SELECT weight, valid_to FROM edge_versions WHERE rel = ? AND source = ? AND recorded_to = 8640000000000000',
		args: [opts.rel, opts.source ?? 'jev'],
	});
	const buckets: CalibrationBucket[] = Array.from({ length: n }, (_, i) => ({
		range: [i / n, (i + 1) / n],
		written: 0,
		live: 0,
		closed: 0,
		closedRate: null,
	}));
	for (const row of r.rows) {
		const w = Math.min(Math.max(Number(row.weight), 0), 1);
		const b = buckets[Math.min(n - 1, Math.floor(w * n))] as CalibrationBucket;
		b.written++;
		if (Number(row.valid_to) >= FOREVER) b.live++;
		else b.closed++;
	}
	for (const b of buckets) b.closedRate = b.written ? b.closed / b.written : null;
	return buckets;
}
