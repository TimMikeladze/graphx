import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { departures, timesFor } from '../src/edits.ts';
import { simplify } from '../src/geo.ts';
import { parseTime, pickDates, prepareGtfs } from '../src/gtfs.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/gtfs');

test('parseTime keeps times past midnight', () => {
	expect(parseTime('07:45:00')).toBe(27_900);
	expect(parseTime('25:10:30')).toBe(90_630);
});

test('pickDates finds the first Tuesday, Saturday and Sunday on or after the start', () => {
	expect(pickDates('20260928')).toEqual({
		weekday: '20260929',
		saturday: '20261003',
		sunday: '20261004',
	});
});

test('prepareGtfs groups trips into patterns with consistent stop times', async () => {
	const p = await prepareGtfs(FIXTURE, () => {});
	expect(p.routes.map((r) => r.short).sort()).toEqual(['1', '13', 'South Lake Union Streetcar']);
	expect(p.routes.find((r) => r.short === 'South Lake Union Streetcar')?.mode).toBe('streetcar');
	const keys = new Set(p.patterns.map((x) => x.key));
	for (const t of p.trips) {
		expect(keys.has(t.pattern)).toBe(true);
		const pattern = p.patterns.find((x) => x.key === t.pattern)!;
		expect(t.times.length).toBe(pattern.stops.length);
		expect(t.times[0]).toBe(0);
		expect(t.days.length).toBeGreaterThan(0);
	}
	for (const x of p.patterns) {
		expect(x.offsets.length).toBe(x.stops.length);
		expect(x.coords.length).toBeGreaterThan(1);
	}
	expect(p.hops.every((h) => h.seconds > 0)).toBe(true);
});

test('simplify keeps endpoints and drops collinear points', () => {
	const line: [number, number][] = [
		[-122.3, 47.6],
		[-122.29, 47.6],
		[-122.28, 47.6],
	];
	expect(simplify(line, 5)).toEqual([line[0]!, line[2]!]);
});

test('departures are evenly spaced and stop before `to`', () => {
	expect(departures(3600, 3600 + 1800, 10)).toEqual([3600, 4200, 4800]);
});

test('timesFor copies the trip nearest in start time', () => {
	const mk = (start: number, last: number) =>
		({ start, times: [0, last] }) as Parameters<typeof timesFor>[1][number];
	expect(timesFor(8 * 3600, [mk(6 * 3600, 600), mk(8 * 3600 + 300, 900)], [0, 1])).toEqual([
		0, 900,
	]);
	expect(timesFor(0, [], [0, 42])).toEqual([0, 42]);
});
