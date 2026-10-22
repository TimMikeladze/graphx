import type { PatternRow } from './api.ts';

export interface SimBus {
	pattern: number;
	position: [number, number];
	start: number;
}

/** Point `d` metres along a pattern's line. */
function along(p: PatternRow, d: number): [number, number] {
	const { cum, coords } = p;
	let lo = 0;
	let hi = cum.length - 1;
	while (lo < hi - 1) {
		const mid = (lo + hi) >> 1;
		if (cum[mid]! <= d) lo = mid;
		else hi = mid;
	}
	const span = cum[hi]! - cum[lo]! || 1;
	const f = Math.min(Math.max((d - cum[lo]!) / span, 0), 1);
	const a = coords[lo]!;
	const b = coords[hi]!;
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/**
 * Where every scheduled bus is at `t` seconds into the service day. Each trip follows its
 * pattern's median stop offsets, stretched to the trip's own duration.
 */
export function scheduledBuses(patterns: PatternRow[], t: number, dayBit: number): SimBus[] {
	const out: SimBus[] = [];
	patterns.forEach((p, k) => {
		const last = p.offsets[p.offsets.length - 1] || 1;
		for (const [start, dur, mask] of p.trips) {
			if (start > t) break;
			if (!(mask & dayBit) || t > start + dur) continue;
			const e = ((t - start) / (dur || 1)) * last;
			let i = 0;
			while (i < p.offsets.length - 2 && p.offsets[i + 1]! <= e) i++;
			const seg = p.offsets[i + 1]! - p.offsets[i]! || 1;
			const f = Math.min(Math.max((e - p.offsets[i]!) / seg, 0), 1);
			const d = p.stopDist[i]! + (p.stopDist[i + 1]! - p.stopDist[i]!) * f;
			out.push({ pattern: k, position: along(p, d), start });
		}
	});
	return out;
}

/** Trips of a pattern that start in the hour around `t` on that day. */
export function tripsPerHour(p: PatternRow, t: number, dayBit: number): number {
	let n = 0;
	for (const [start, , mask] of p.trips)
		if (mask & dayBit && start >= t - 1800 && start < t + 1800) n++;
	return n;
}
