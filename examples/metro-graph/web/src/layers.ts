import type { Color } from '@deck.gl/core';

/**
 * Map colour. Frequency is magnitude, so it is one hue (blue) stepped by lightness: rare service
 * recedes into the basemap, frequent service stands out. A scenario's change is polarity, so it
 * is diverging: blue more trips, red fewer, gray for no change. Every coloured thing also has a
 * tooltip and a panel row.
 */

type Ramp = [number, number, number][];

const lerp = (a: number[], b: number[], f: number) =>
	a.map((x, i) => Math.round(x + (b[i]! - x) * f));

function sample(ramp: Ramp, f: number): [number, number, number] {
	const x = Math.min(Math.max(f, 0), 1) * (ramp.length - 1);
	const i = Math.min(Math.floor(x), ramp.length - 2);
	return lerp(ramp[i]!, ramp[i + 1]!, x - i) as [number, number, number];
}

/** Colour for a travel-time ratio (1 = free flow). */

const BLUE = [57, 135, 229];
const RED = [227, 73, 72];
const GRAY = { dark: [90, 90, 86], light: [200, 199, 194] };

/** Colour for a change: positive (more trips) blue, negative (fewer) red. */
export function deltaColor(delta: number, scale: number, theme: 'dark' | 'light'): Color {
	const f = Math.min(Math.abs(delta) / scale, 1);
	const pole = delta > 0 ? BLUE : RED;
	return [...lerp(GRAY[theme], pole, f), f < 0.05 ? 90 : 235] as unknown as Color;
}

/** Sequential blue for a 0–1 magnitude. */
export function blueColor(f: number, theme: 'dark' | 'light'): Color {
	const ramp: Ramp =
		theme === 'dark'
			? [
					[24, 40, 64],
					[28, 92, 171],
					[57, 135, 229],
					[134, 182, 239],
					[205, 226, 251],
				]
			: [
					[205, 226, 251],
					[134, 182, 239],
					[57, 135, 229],
					[28, 92, 171],
					[13, 54, 107],
				];
	return [...sample(ramp, f), 200];
}

/** Crash mode slots: vehicle, cyclist, pedestrian — categorical slots 1–3 (validated all-pairs). */
