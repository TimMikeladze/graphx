import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { assign, makeNet } from '../src/model/assign.ts';
import { buildModel } from '../src/model/city.ts';
import { bpr, signalDelay } from '../src/model/delay.ts';
import { WINDOWS, windowDemand } from '../src/model/demand.ts';
import { prepareAll } from '../src/prepare.ts';
import { boston, parseBostonLocal } from '../src/time.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/seaport/raw');

test('delay: BPR and the signal term match hand-computed values', () => {
	expect(bpr(60, 0, 1000)).toBe(60);
	expect(bpr(60, 1000, 1000)).toBeCloseTo(69, 9); // 60 · 1.15
	// Empty approach, 90 s cycle, 30 s green: Webster uniform delay (C − g)² / 2C = 20 s — the same
	// term the original seaport demo uses — plus a vanishing incremental term.
	expect(signalDelay({ cycleSec: 90, greenSec: 30 }, 0, 900)).toBeCloseTo(20, 6);
	// More green on the approach → less delay; more volume → more.
	expect(signalDelay({ cycleSec: 90, greenSec: 50 }, 300, 900)).toBeLessThan(
		signalDelay({ cycleSec: 90, greenSec: 30 }, 300, 900),
	);
	expect(signalDelay({ cycleSec: 90, greenSec: 30 }, 900, 900)).toBeGreaterThan(
		signalDelay({ cycleSec: 90, greenSec: 30 }, 300, 900),
	);
});

test('assignment: demand splits across two parallel roads toward equal travel time', () => {
	// 0 → 1 by a fast narrow road or a slow wide one; 2000 veh/h is too much for the fast one alone.
	const net = makeNet(2, [
		{ from: 0, to: 1, t0: 60, cap: 1000, signal: null },
		{ from: 0, to: 1, t0: 90, cap: 3000, signal: null },
	]);
	const a = assign(net, new Map([[0, new Map([[1, 2000]])]]), { iterations: 30 });
	expect(a.volume[0]! + a.volume[1]!).toBeCloseTo(2000, 6);
	expect(a.volume[0]).toBeGreaterThan(0);
	expect(a.volume[1]).toBeGreaterThan(0);
	expect(Math.abs(a.seconds[0]! - a.seconds[1]!)).toBeLessThan(1.5); // Wardrop: used routes cost the same
	expect(a.gap).toBeLessThan(0.01);
});

test('time: Boston wall clock across both DST offsets', () => {
	expect(new Date(boston(2026, 9, 29, 8)).toISOString()).toBe('2026-09-29T12:00:00.000Z'); // EDT
	expect(new Date(boston(2026, 1, 15, 8)).toISOString()).toBe('2026-01-15T13:00:00.000Z'); // EST
	expect(parseBostonLocal('2026-02-15 11:10:34.917')).toBe(Date.UTC(2026, 1, 15, 16, 10, 34));
});

test('demand: 48 windows cover the day once; the morning peak runs home → work', () => {
	expect(WINDOWS.length).toBe(48);
	expect(WINDOWS.reduce((s, w) => s + w.minutes, 0)).toBe(1440);
	const ods = [{ o: 0, d: 1, drivers: 100 }];
	const am = windowDemand(ods, { start: 480, minutes: 15 }, 1);
	const pm = windowDemand(ods, { start: 1035, minutes: 15 }, 1);
	expect(am.get(0)!.get(1)!).toBeGreaterThan(am.get(1)!.get(0)!);
	expect(pm.get(1)!.get(0)!).toBeGreaterThan(pm.get(0)!.get(1)!);
});

test('prepare + model on the Seaport fixture: a connected network, real flows, a retiming that helps its street', async () => {
	const p = await prepareAll(FIXTURE, () => {});
	expect(p.network.intersections.length).toBeGreaterThan(300);
	expect(Object.keys(p.signals).length).toBeGreaterThan(40);
	expect(p.zones.filter((z) => z.kind === 'boston').length).toBeGreaterThan(30);
	expect(p.flows.length).toBeGreaterThan(100);
	expect(p.reports.every((r) => !r.body.includes('&amp;'))).toBe(true);
	expect(p.transit.links.length).toBeGreaterThan(20);

	const peak = { start: 480, minutes: 15 };
	const base = buildModel(p);
	const a = assign(base.net, windowDemand(base.ods, peak), { iterations: 12 });
	expect(a.gap).toBeLessThan(0.1);

	// Give the busiest signalised approach most of the green: its delay must drop.
	let link = -1;
	for (let i = 0; i < base.net.m; i++) {
		if (base.net.signal[i] && (link < 0 || a.volume[i]! > a.volume[link]!)) link = i;
	}
	const seg = p.network.segments[link]!;
	const plan = p.signals[seg.to]!;
	const green = Object.fromEntries(
		Object.keys(plan.green).map((s) => [s, s === seg.street ? plan.cycleSec - 20 : 10]),
	);
	const retimed = buildModel(p, { signals: { [seg.to]: { cycleSec: plan.cycleSec, green } } });
	const b = assign(retimed.net, windowDemand(retimed.ods, peak), { iterations: 12 });
	expect(b.seconds[link]!).toBeLessThan(a.seconds[link]!);

	// Closing it reroutes everything off it.
	const closed = buildModel(p, { closed: [seg.key] });
	const c = assign(closed.net, windowDemand(closed.ods, peak), { iterations: 6 });
	expect(c.volume[link]).toBe(0);
});
