/**
 * When trips happen. LODES says who commutes where, once a day; this spreads that over a
 * weekday and adds the rest of the traffic that is not commuting.
 *
 * All of these are modelling assumptions, documented here and in the README.
 */

/** A modelled time window: start minute of the day and length in minutes. */
export interface Window {
	start: number;
	minutes: number;
}

/** 15-minute windows through both peaks, hourly elsewhere — 48 in a day. */
export const WINDOWS: Window[] = (() => {
	const w: Window[] = [];
	const hourly = (from: number, to: number) => {
		for (let h = from; h < to; h++) w.push({ start: h * 60, minutes: 60 });
	};
	const quarter = (from: number, to: number) => {
		for (let m = from * 60; m < to * 60; m += 15) w.push({ start: m, minutes: 15 });
	};
	hourly(0, 6);
	quarter(6, 10);
	hourly(10, 15);
	quarter(15, 19);
	hourly(19, 24);
	return w;
})();

/** Frank–Wolfe iterations per window: more where the peaks make equilibrium hard to reach. */
export const iterationsFor = (w: Window) => (w.minutes === 15 ? 12 : 6);

/**
 * Share of commuters who drive on a given weekday: residents of the city drive less than people
 * coming in, and LODES counts jobs, not trips — with hybrid work, about 70% of jobs are
 * commuted to on a weekday.
 */
export const DRIVE_SHARE = { resident: 0.3 * 0.7, inbound: 0.42 * 0.7 };

/** Morning departures (home → work) per hour of day, as a share of all morning commutes. */
const AM_DEPART: Record<number, number> = { 5: 0.04, 6: 0.14, 7: 0.33, 8: 0.31, 9: 0.13, 10: 0.05 };
/** Evening departures (work → home). */
const PM_DEPART: Record<number, number> = {
	14: 0.04,
	15: 0.11,
	16: 0.24,
	17: 0.31,
	18: 0.2,
	19: 0.07,
	20: 0.03,
};

/**
 * Non-commute traffic — deliveries, errands, school runs, through traffic — as a share of the
 * day per hour (a typical urban weekday count profile, sums to 1).
 */
const BACKGROUND_HOURLY = [
	0.008, 0.005, 0.004, 0.004, 0.007, 0.018, 0.045, 0.066, 0.068, 0.056, 0.052, 0.055, 0.058, 0.058,
	0.061, 0.068, 0.074, 0.074, 0.061, 0.047, 0.038, 0.032, 0.024, 0.016,
];

/**
 * Background trips per day, as a multiple of driving commute trips (one each way). Commuting
 * is about a fifth of urban weekday travel; calibrated so peak-hour arterials run near capacity.
 */
export const BACKGROUND_MULTIPLE = 1.6;

/**
 * One knob over all demand, calibrated so the 08:00 peak averages about twice the free-flow
 * time per vehicle-second driven — big-city rush hour — rather than gridlock or empty streets.
 * The network stops at the city line, so trips that would use roads outside it cannot.
 */
export const DEMAND_CALIBRATION = 0.68;

/** A curve given per hour, spread evenly across the minutes of that hour, read over a window. */
function shareOf(curve: (hour: number) => number, w: Window): number {
	let s = 0;
	for (let m = w.start; m < w.start + w.minutes; m++) s += curve(Math.floor(m / 60)) / 60;
	return s;
}

/** Shares of the morning commute, the evening commute and background traffic that fall in `w`. */
export function windowShares(w: Window): { am: number; pm: number; background: number } {
	return {
		am: shareOf((h) => AM_DEPART[h] ?? 0, w),
		pm: shareOf((h) => PM_DEPART[h] ?? 0, w),
		background: shareOf((h) => BACKGROUND_HOURLY[h] ?? 0, w),
	};
}

export interface OD {
	/** Origin node index. */
	o: number;
	/** Destination node index. */
	d: number;
	/** Driving commuters (one trip each way per day). */
	drivers: number;
}

/**
 * Vehicle trips per hour between node pairs in window `w`: the morning commute home → work,
 * the evening commute work → home, and background traffic spread both ways in proportion.
 */
export function windowDemand(
	ods: OD[],
	w: Window,
	scale = DEMAND_CALIBRATION,
): Map<number, Map<number, number>> {
	const s = windowShares(w);
	const perHour = 60 / w.minutes;
	const out = new Map<number, Map<number, number>>();
	const add = (o: number, d: number, v: number) => {
		if (v <= 0 || o === d) return;
		let m = out.get(o);
		if (!m) out.set(o, (m = new Map()));
		m.set(d, (m.get(d) ?? 0) + v);
	};
	for (const od of ods) {
		const day = od.drivers * scale;
		const bg = day * BACKGROUND_MULTIPLE * s.background; // per direction
		add(od.o, od.d, (day * s.am + bg) * perHour);
		add(od.d, od.o, (day * s.pm + bg) * perHour);
	}
	return out;
}
