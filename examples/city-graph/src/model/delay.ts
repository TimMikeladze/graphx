/**
 * Link travel time as volume rises. Two textbook terms:
 *
 *  - BPR (Bureau of Public Roads): `t0 · (1 + 0.15 · x⁴)`, x = volume / capacity.
 *  - At a signal, the HCM control delay: Webster's uniform delay
 *    `C(1 − g/C)² / (2(1 − min(x, 1) · g/C))` plus the incremental (oversaturation) delay
 *    `900T[(x − 1) + √((x − 1)² + 4x / (cT))]` over a T = 0.25 h analysis period.
 */

export interface Signal {
	cycleSec: number;
	greenSec: number;
}

export function bpr(t0: number, volume: number, capacity: number): number {
	const x = volume / Math.max(capacity, 1);
	return t0 * (1 + 0.15 * x ** 4);
}

/** Mean seconds of delay per vehicle at a fixed-time signal. */
export function signalDelay(sig: Signal, volume: number, capacity: number): number {
	const C = sig.cycleSec;
	const gC = Math.min(Math.max(sig.greenSec / C, 0.05), 0.95);
	const x = volume / Math.max(capacity, 1);
	const uniform = (C * (1 - gC) ** 2) / (2 * (1 - Math.min(x, 1) * gC));
	const T = 0.25;
	const c = Math.max(capacity * gC, 1);
	const incremental = 900 * T * (x - 1 + Math.sqrt((x - 1) ** 2 + (4 * x) / (c * T)));
	return Math.min(uniform + incremental, 900);
}

/** Seconds to traverse a link carrying `volume` veh/h, including the signal at its far end. */
export function linkSeconds(
	t0: number,
	volume: number,
	capacity: number,
	sig: Signal | null,
): number {
	return bpr(t0, volume, capacity) + (sig ? signalDelay(sig, volume, capacity) : 0);
}
