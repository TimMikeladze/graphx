/**
 * Cut the checked-in test fixture from the full feed: a few routes, only the service that runs on
 * the three modelled days, and the stops and shapes those trips use.
 *
 *   bun src/make-fixture.ts [routeShortNames...]   # default 1 13 "South Lake Union Streetcar"
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { csvRecords, textOf } from './csv.ts';
import { DATA } from './download.ts';
import { pickDates, serviceDays } from './gtfs.ts';

const SRC = join(DATA, 'gtfs');
const OUT = join(import.meta.dir, '../fixtures/gtfs');
const names = process.argv.slice(2).length
	? process.argv.slice(2)
	: ['1', '13', 'South Lake Union Streetcar'];

const rows = async (file: string) => {
	const out: Record<string, string>[] = [];
	for await (const r of csvRecords(textOf(join(SRC, file)))) out.push(r);
	return out;
};
const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const write = (file: string, recs: Record<string, string>[]) => {
	const cols = Object.keys(recs[0] ?? {});
	const body = [cols.join(','), ...recs.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))];
	return Bun.write(join(OUT, file), `${body.join('\n')}\n`);
};

mkdirSync(OUT, { recursive: true });
const info = await rows('feed_info.txt');
const picked = pickDates(info[0]!.feed_start_date!);
const dates = Object.values(picked);
const routes = (await rows('routes.txt')).filter((r) => names.includes(r.route_short_name!));
const routeIds = new Set(routes.map((r) => r.route_id!));
const calendar = await rows('calendar.txt');
const exceptions = (await rows('calendar_dates.txt')).filter((e) => dates.includes(e.date!));
const runs = serviceDays(calendar, exceptions, picked);
const trips = (await rows('trips.txt')).filter(
	(t) => routeIds.has(t.route_id!) && runs.has(t.service_id!),
);
const services = new Set(trips.map((t) => t.service_id!));
const tripIds = new Set(trips.map((t) => t.trip_id!));
const stopTimes: Record<string, string>[] = [];
for await (const st of csvRecords(textOf(join(SRC, 'stop_times.txt'))))
	if (tripIds.has(st.trip_id!)) stopTimes.push(st);
const stopIds = new Set(stopTimes.map((s) => s.stop_id!));
const shapeIds = new Set(trips.map((t) => t.shape_id!));
const shapes: Record<string, string>[] = [];
for await (const p of csvRecords(textOf(join(SRC, 'shapes.txt'))))
	if (shapeIds.has(p.shape_id!)) shapes.push(p);
const agencies = new Set(routes.map((r) => r.agency_id!));

await write('feed_info.txt', info);
await write(
	'agency.txt',
	(await rows('agency.txt')).filter((a) => agencies.has(a.agency_id!)),
);
await write('routes.txt', routes);
await write(
	'calendar.txt',
	calendar.filter((c) => services.has(c.service_id!)),
);
await write(
	'calendar_dates.txt',
	exceptions.filter((e) => services.has(e.service_id!)),
);
await write('trips.txt', trips);
await write('stop_times.txt', stopTimes);
await write(
	'stops.txt',
	(await rows('stops.txt')).filter((s) => stopIds.has(s.stop_id!)),
);
await write('shapes.txt', shapes);
console.log(
	`${routes.length} routes, ${trips.length} trips, ${stopTimes.length} stop times, ${stopIds.size} stops → ${OUT}`,
);
