import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Day, PatternData, RouteData, StopData, TripData } from '../schema.ts';
import { csvRecords, textOf } from './csv.ts';
import { haversine, simplify } from './geo.ts';

/** A GTFS feed reduced to what the graph holds. Written to `data/prepared.json` by `load`. */
export interface Prepared {
	feed: { publisher: string; version: string; start: string; end: string };
	/** The service dates each day kind was read from, `YYYYMMDD`. */
	dates: Record<Day, string>;
	routes: RouteData[];
	stops: StopData[];
	patterns: PatternData[];
	trips: TripData[];
	hops: Array<{ route: string; from: string; to: string; seconds: number; trips: number }>;
}

const MODES: Record<string, RouteData['mode']> = {
	'0': 'streetcar',
	'1': 'rail',
	'2': 'rail',
	'3': 'bus',
	'4': 'ferry',
};

/** `25:10:30` → 90630. GTFS times pass 24:00 for trips after midnight. */
export function parseTime(s: string): number {
	const [h, m, sec] = s.trim().split(':').map(Number);
	return h! * 3600 + m! * 60 + (sec ?? 0);
}

const ymd = (d: Date) =>
	`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
const fromYmd = (s: string) =>
	new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const WEEKDAY_NAMES = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
] as const;

/** The first Tuesday, Saturday and Sunday on or after the feed start. */
export function pickDates(start: string): Record<Day, string> {
	const first = (dow: number) => {
		const d = fromYmd(start);
		while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
		return ymd(d);
	};
	return { weekday: first(2), saturday: first(6), sunday: first(0) };
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
};

/** service_id → the day kinds it runs on, from calendar flags plus calendar_dates exceptions. */
export function serviceDays(
	calendar: Record<string, string>[],
	exceptions: Record<string, string>[],
	dates: Record<Day, string>,
): Map<string, Set<Day>> {
	const runs = new Map<string, Set<Day>>();
	for (const [day, date] of Object.entries(dates) as [Day, string][]) {
		const dow = WEEKDAY_NAMES[fromYmd(date).getUTCDay()]!;
		const active = new Set<string>();
		for (const c of calendar)
			if (c[dow] === '1' && c.start_date! <= date && c.end_date! >= date) active.add(c.service_id!);
		for (const e of exceptions) {
			if (e.date !== date) continue;
			if (e.exception_type === '1') active.add(e.service_id!);
			else active.delete(e.service_id!);
		}
		for (const s of active) {
			if (!runs.has(s)) runs.set(s, new Set());
			runs.get(s)!.add(day);
		}
	}
	return runs;
}

async function records(dir: string, file: string): Promise<Record<string, string>[]> {
	const path = join(dir, file);
	if (!existsSync(path)) return [];
	const out: Record<string, string>[] = [];
	for await (const r of csvRecords(textOf(path))) out.push(r);
	return out;
}

/** Parse an unzipped GTFS directory. */
export async function prepareGtfs(
	dir: string,
	log: (s: string) => void = console.log,
): Promise<Prepared> {
	const info = (await records(dir, 'feed_info.txt'))[0] ?? {};
	const calendar = await records(dir, 'calendar.txt');
	const exceptions = await records(dir, 'calendar_dates.txt');
	const start =
		info.feed_start_date ||
		calendar.map((c) => c.start_date!).sort()[0] ||
		exceptions.map((c) => c.date!).sort()[0]!;
	const dates = pickDates(start);

	const runs = serviceDays(calendar, exceptions, dates);

	const agencies = new Map(
		(await records(dir, 'agency.txt')).map((a) => [a.agency_id ?? '', a.agency_name ?? '']),
	);
	const routes: RouteData[] = (await records(dir, 'routes.txt')).map((r) => ({
		gtfsId: r.route_id!,
		short: r.route_short_name || r.route_long_name || r.route_id!,
		long: r.route_long_name ?? '',
		desc: r.route_desc ?? '',
		agency: agencies.get(r.agency_id ?? '') ?? [...agencies.values()][0] ?? '',
		mode: MODES[r.route_type ?? ''] ?? 'other',
		color: `#${r.route_color || '888888'}`,
		textColor: `#${r.route_text_color || '000000'}`,
		url: r.route_url ?? '',
	}));
	const stops: StopData[] = (await records(dir, 'stops.txt'))
		.filter((s) => !s.location_type || s.location_type === '0')
		.map((s) => ({
			gtfsId: s.stop_id!,
			code: s.stop_code ?? '',
			name: s.stop_name ?? '',
			lat: Number(s.stop_lat),
			lng: Number(s.stop_lon),
			wheelchair: s.wheelchair_boarding === '1',
		}));
	const stopIds = new Set(stops.map((s) => s.gtfsId));

	type RawTrip = {
		id: string;
		route: string;
		direction: number;
		headsign: string;
		shape: string;
		block: string;
		days: Day[];
		calls: Array<[seq: number, stop: string, time: number]>;
	};
	const trips = new Map<string, RawTrip>();
	for (const t of await records(dir, 'trips.txt')) {
		const days = runs.get(t.service_id!);
		if (!days) continue;
		trips.set(t.trip_id!, {
			id: t.trip_id!,
			route: t.route_id!,
			direction: Number(t.direction_id || 0),
			headsign: t.trip_headsign ?? '',
			shape: t.shape_id ?? '',
			block: t.block_id ?? '',
			days: [...days].sort(),
			calls: [],
		});
	}
	log(`  ${trips.size} trips run on ${Object.values(dates).join(', ')}`);

	let rows = 0;
	for await (const st of csvRecords(textOf(join(dir, 'stop_times.txt')))) {
		const trip = trips.get(st.trip_id!);
		if (!trip || !stopIds.has(st.stop_id!)) continue;
		const time = st.departure_time || st.arrival_time;
		if (!time) continue;
		trip.calls.push([Number(st.stop_sequence), st.stop_id!, parseTime(time)]);
		rows++;
	}
	log(`  ${rows} stop times`);

	// Only shapes some kept trip uses.
	const wanted = new Set([...trips.values()].map((t) => t.shape));
	const shapePts = new Map<string, Array<[number, number, number]>>();
	for await (const p of csvRecords(textOf(join(dir, 'shapes.txt')))) {
		if (!wanted.has(p.shape_id!)) continue;
		if (!shapePts.has(p.shape_id!)) shapePts.set(p.shape_id!, []);
		shapePts
			.get(p.shape_id!)!
			.push([Number(p.shape_pt_sequence), Number(p.shape_pt_lon), Number(p.shape_pt_lat)]);
	}

	// Patterns: one per (route, direction, stop sequence), numbered by how many trips use them.
	const byPattern = new Map<string, RawTrip[]>();
	for (const t of trips.values()) {
		if (t.calls.length < 2) continue;
		t.calls.sort((a, b) => a[0] - b[0]);
		const sig = `${t.route}|${t.direction}|${t.calls.map((c) => c[1]).join(',')}`;
		if (!byPattern.has(sig)) byPattern.set(sig, []);
		byPattern.get(sig)!.push(t);
	}
	const stopById = new Map(stops.map((s) => [s.gtfsId, s]));
	const counters = new Map<string, number>();
	const patterns: PatternData[] = [];
	const outTrips: TripData[] = [];
	const hopTimes = new Map<string, { seconds: number[]; trips: number }>();
	const sorted = [...byPattern.values()].sort((a, b) => b.length - a.length);
	for (const group of sorted) {
		const t0 = group[0]!;
		const ck = `${t0.route}:${t0.direction}`;
		const n = (counters.get(ck) ?? 0) + 1;
		counters.set(ck, n);
		const key = `${ck}:${n}`;
		const stopSeq = t0.calls.map((c) => c[1]);
		const rel = group.map((t) => t.calls.map((c) => c[2] - t.calls[0]![2]));
		const offsets = stopSeq.map((_, i) => median(rel.map((r) => r[i]!)));
		// The shape most of the pattern's trips use; straight lines between stops when there is none.
		const shapeCount = new Map<string, number>();
		for (const t of group) shapeCount.set(t.shape, (shapeCount.get(t.shape) ?? 0) + 1);
		const shapeId = [...shapeCount.entries()].sort((a, b) => b[1] - a[1])[0]![0];
		const pts = shapePts.get(shapeId)?.sort((a, b) => a[0] - b[0]);
		const line: [number, number][] = pts?.length
			? pts.map((p) => [p[1], p[2]])
			: stopSeq.map((s) => [stopById.get(s)!.lng, stopById.get(s)!.lat]);
		let lengthM = 0;
		for (let i = 1; i < line.length; i++) lengthM += haversine(line[i - 1]!, line[i]!);
		const headsigns = new Map<string, number>();
		for (const t of group) headsigns.set(t.headsign, (headsigns.get(t.headsign) ?? 0) + 1);
		patterns.push({
			key,
			route: t0.route,
			direction: t0.direction,
			headsign: [...headsigns.entries()].sort((a, b) => b[1] - a[1])[0]![0],
			stops: stopSeq,
			offsets,
			lengthM: Math.round(lengthM),
			coords: simplify(line, 10).map(([x, y]) => [round6(x), round6(y)]),
		});
		group.forEach((t, k) => {
			outTrips.push({
				gtfsId: t.id,
				route: t.route,
				pattern: key,
				direction: t.direction,
				headsign: t.headsign,
				days: t.days,
				start: t.calls[0]![2],
				times: rel[k]!,
				block: t.block,
			});
			for (let i = 1; i < stopSeq.length; i++) {
				const hk = `${t.route}|${stopSeq[i - 1]}|${stopSeq[i]}`;
				if (!hopTimes.has(hk)) hopTimes.set(hk, { seconds: [], trips: 0 });
				const h = hopTimes.get(hk)!;
				h.seconds.push(rel[k]![i]! - rel[k]![i - 1]!);
				if (t.days.includes('weekday')) h.trips++;
			}
		});
	}
	const hops = [...hopTimes.entries()].map(([k, h]) => {
		const [route, from, to] = k.split('|') as [string, string, string];
		return { route, from, to, seconds: Math.max(1, median(h.seconds)), trips: h.trips };
	});

	// Drop routes and stops nothing runs on.
	const usedRoutes = new Set(patterns.map((p) => p.route));
	const usedStops = new Set(patterns.flatMap((p) => p.stops));
	return {
		feed: {
			publisher: info.feed_publisher_name ?? '',
			version: info.feed_version ?? '',
			start,
			end: info.feed_end_date ?? '',
		},
		dates,
		routes: routes.filter((r) => usedRoutes.has(r.gtfsId)),
		stops: stops.filter((s) => usedStops.has(s.gtfsId)),
		patterns,
		trips: outTrips,
		hops,
	};
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
