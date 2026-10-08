import type { Color } from '@deck.gl/core';

/**
 * Map colour. Congestion is magnitude, so it is one hue (orange) stepped by lightness — the low
 * end recedes into the basemap, the high end stands out. A scenario's change is polarity, so it
 * is diverging: blue faster, red slower, a neutral gray for no change. Identity never rides on
 * colour alone — every coloured thing has a tooltip and a panel row.
 */

type Ramp = [number, number, number][];

const CONGESTION: Record<'dark' | 'light', Ramp> = {
	// free flow → 3× slower
	dark: [
		[74, 58, 50],
		[122, 66, 38],
		[171, 77, 35],
		[217, 89, 38],
		[240, 138, 93],
		[255, 196, 163],
	],
	light: [
		[226, 214, 205],
		[243, 181, 150],
		[235, 134, 92],
		[217, 89, 38],
		[166, 62, 22],
		[110, 38, 12],
	],
};

const lerp = (a: number[], b: number[], f: number) =>
	a.map((x, i) => Math.round(x + (b[i]! - x) * f));

function sample(ramp: Ramp, f: number): [number, number, number] {
	const x = Math.min(Math.max(f, 0), 1) * (ramp.length - 1);
	const i = Math.min(Math.floor(x), ramp.length - 2);
	return lerp(ramp[i]!, ramp[i + 1]!, x - i) as [number, number, number];
}

/** Colour for a travel-time ratio (1 = free flow). */
export function congestionColor(ratio: number, theme: 'dark' | 'light'): Color {
	return [...sample(CONGESTION[theme], (ratio - 1) / 2), 235];
}

export const CONGESTION_STOPS = [1, 1.4, 1.8, 2.2, 2.6, 3];

const BLUE = [57, 135, 229];
const RED = [227, 73, 72];
const GRAY = { dark: [90, 90, 86], light: [200, 199, 194] };

/** Colour for a change in seconds: negative (faster) blue, positive (slower) red. */
export function deltaColor(delta: number, scale: number, theme: 'dark' | 'light'): Color {
	const f = Math.min(Math.abs(delta) / scale, 1);
	const pole = delta < 0 ? BLUE : RED;
	return [...lerp(GRAY[theme], pole, f), f < 0.05 ? 90 : 235] as unknown as Color;
}

/** Sequential blue for a 0–1 magnitude (zones, critical intersections). */
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
export const MODE_COLORS: Record<'dark' | 'light', Record<'mv' | 'bike' | 'ped', Color>> = {
	dark: { mv: [57, 135, 229], bike: [217, 89, 38], ped: [25, 158, 112] },
	light: { mv: [42, 120, 214], bike: [235, 104, 52], ped: [27, 175, 122] },
};

export function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
