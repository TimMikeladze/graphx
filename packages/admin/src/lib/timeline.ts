/**
 * Scrub arithmetic for the timeline bar — snapping, stepping, presets, and the time↔pixel
 * mapping. Pure and DOM-free so the bar's maths is testable without rendering it.
 */

/** The relative windows the bar offers as one-click jumps. */
export type TimePreset = '1h' | '1d' | '7d';

export const PRESETS: readonly TimePreset[] = ['1h', '1d', '7d'];

const PRESET_MS: Record<TimePreset, number> = {
	'1h': 3_600_000,
	'1d': 86_400_000,
	'7d': 604_800_000,
};

/** The preset window's start, relative to `now`. */
export function presetTime(preset: TimePreset, now: number): number {
	return now - PRESET_MS[preset];
}

/**
 * The tick closest to `t`. Dragging is continuous but releasing snaps here, so the handle never
 * settles in a gap where nothing changed. Ties go to the earlier tick — a scrub that lands exactly
 * between two changes shows the state that had already happened.
 */
export function nearestTick(ticks: number[], t: number): number | undefined {
	let best: number | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const tick of ticks) {
		const dist = Math.abs(t - tick);
		if (dist < bestDist) {
			best = tick;
			bestDist = dist;
		}
	}
	return best;
}

/**
 * The next tick strictly after `t` (`dir` 1) or strictly before it (`dir` -1). `undefined` at the
 * ends, which is how the caller knows to stop stepping — and how playback knows it has finished.
 */
export function stepTick(ticks: number[], t: number, dir: -1 | 1): number | undefined {
	if (dir === 1) return ticks.find((tick) => tick > t);
	for (let i = ticks.length - 1; i >= 0; i--) {
		const tick = ticks[i];
		if (tick !== undefined && tick < t) return tick;
	}
	return undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pixel offset of `t` within a `width`-wide track spanning `[from, to]`. */
export function timeToX(t: number, from: number, to: number, width: number): number {
	const span = to - from;
	if (span <= 0) return 0;
	return clamp(((t - from) / span) * width, 0, width);
}

/** The time a pixel offset represents — the inverse of {@link timeToX}. */
export function xToTime(x: number, from: number, to: number, width: number): number {
	const span = to - from;
	if (span <= 0 || width <= 0) return from;
	return clamp(from + (x / width) * span, from, to);
}
