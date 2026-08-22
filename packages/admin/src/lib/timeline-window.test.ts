import { describe, expect, it } from 'bun:test';
import { zoomWindow } from './timeline-window';

// The extent used throughout: 1000 wide, so halving and doubling land on round numbers.
const MIN = 1000;
const MAX = 2000;

describe('zoomWindow', () => {
	it('halves the span around the centre when zooming in', () => {
		expect(zoomWindow({}, 1500, 0.5, MIN, MAX)).toEqual({ from: 1250, to: 1750 });
	});

	it('keeps the centre inside the new window', () => {
		const w = zoomWindow({}, 1200, 0.5, MIN, MAX);
		expect(w.from!).toBeLessThanOrEqual(1200);
		expect(w.to!).toBeGreaterThanOrEqual(1200);
	});

	it('zooms in repeatedly, narrowing each time', () => {
		const a = zoomWindow({}, 1500, 0.5, MIN, MAX);
		const b = zoomWindow(a, 1500, 0.5, MIN, MAX);
		expect(b.to! - b.from!).toBe((a.to! - a.from!) / 2);
	});

	it('collapses to the full range when zooming out past the extent', () => {
		// A window at half the extent, doubled, exactly reaches the extent — which is the full range,
		// and must be spelled `{}` so it compares equal to the Full range button's result.
		expect(zoomWindow({ from: 1250, to: 1750 }, 1500, 2, MIN, MAX)).toEqual({});
		// Well past the extent collapses too, rather than clamping to a window that merely matches.
		expect(zoomWindow({ from: 1250, to: 1750 }, 1500, 100, MIN, MAX)).toEqual({});
		// Already full: zooming out is idempotent.
		expect(zoomWindow({}, 1500, 2, MIN, MAX)).toEqual({});
	});

	it('shifts rather than truncates when the centre is near an edge', () => {
		// Centred on the extent minimum, half the span would start below it. The window keeps the
		// span it was asked for and slides inward instead of losing half of it.
		const lo = zoomWindow({}, MIN, 0.5, MIN, MAX);
		expect(lo).toEqual({ from: 1000, to: 1500 });
		const hi = zoomWindow({}, MAX, 0.5, MIN, MAX);
		expect(hi).toEqual({ from: 1500, to: 2000 });
		expect(lo.to! - lo.from!).toBe(500);
		expect(hi.to! - hi.from!).toBe(500);
	});

	it('returns to the full range after zooming in and back out, at any depth', () => {
		// Integer bounds are rounded outward precisely so this holds. Rounding to nearest shaves half
		// a millisecond per edge, and the loss compounds with depth — a twice-narrowed window widened
		// twice would land milliseconds short of the extent, never satisfy the full-range test, and
		// leave the Full range button on screen forever. Real epoch values, odd width so nothing
		// divides evenly.
		const lo = 1_777_596_317_038;
		const hi = 1_785_276_678_457;

		for (const depth of [1, 2, 3, 5]) {
			let w = zoomWindow({}, hi, 0.5, lo, hi);
			for (let i = 1; i < depth; i++) w = zoomWindow(w, hi, 0.5, lo, hi);
			expect(w.from).toBeDefined();
			for (let i = 0; i < depth; i++) w = zoomWindow(w, hi, 2, lo, hi);
			expect(w).toEqual({});
		}
	});

	it('never returns a window narrower than asked for', () => {
		// Outward rounding is what guarantees the round trip above, so pin it directly.
		const w = zoomWindow({}, 1_777_596_317_038, 1 / 3, 1_777_596_317_038, 1_785_276_678_457);
		const asked = (1_785_276_678_457 - 1_777_596_317_038) / 3;
		expect(w.to! - w.from!).toBeGreaterThanOrEqual(Math.floor(asked));
	});

	it('is a no-op on a zero-width extent', () => {
		// An empty or single-instant graph. There is nothing to zoom into, and dividing by the span
		// would be the bug this guards.
		expect(zoomWindow({}, 7, 0.5, 7, 7)).toEqual({});
		expect(zoomWindow({ from: 7, to: 7 }, 7, 0.5, 7, 7)).toEqual({ from: 7, to: 7 });
	});

	it('returns integer bounds', () => {
		// 1000 / 3 does not divide evenly; the result still has to be bindable as epoch ms.
		const w = zoomWindow({}, 1500, 1 / 3, MIN, MAX);
		expect(Number.isInteger(w.from!)).toBe(true);
		expect(Number.isInteger(w.to!)).toBe(true);
	});
});
