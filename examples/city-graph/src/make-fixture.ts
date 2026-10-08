/**
 * Cut the checked-in test fixture out of the real downloads: South Boston and the Seaport —
 * the neighbourhood of the original `seaport-traffic.ts` demo — with every source clipped to it.
 * Tests and CI run the whole pipeline on this, no network needed.
 *
 *   bun src/make-fixture.ts     # after `bun run download`
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { csvRecords, textOf } from './csv.ts';
import { centroid, inBBox, type BBox, polygonsOf } from './geo.ts';
import type { OsmDoc } from './prepare/network.ts';
import type { FeatureCollection } from './prepare/places.ts';

const RAW = join(import.meta.dir, '../data/raw');
export const FIXTURE = join(import.meta.dir, '../fixtures/seaport');
const BOX: BBox = [-71.06, 42.327, -71.015, 42.356];
const HOODS = new Set(['South Boston', 'South Boston Waterfront']);

const csvLine = (cols: string[], r: Record<string, string>) =>
	cols
		.map((c) => {
			const v = r[c] ?? '';
			return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
		})
		.join(',');

async function writeCsv(path: string, rows: Array<Record<string, string>>, cols: string[]) {
	await Bun.write(path, `${cols.join(',')}\n${rows.map((r) => csvLine(cols, r)).join('\n')}\n`);
}

async function main() {
	const out = join(FIXTURE, 'raw');
	mkdirSync(join(out, 'gtfs'), { recursive: true });

	const hoods = (await Bun.file(join(RAW, 'neighborhoods_bg.geojson')).json()) as FeatureCollection;
	hoods.features = hoods.features.filter((f) =>
		HOODS.has(String(f.properties.blockgr2020_ctr_neighb_name)),
	);
	for (const f of hoods.features)
		f.properties = { blockgr2020_ctr_neighb_name: f.properties.blockgr2020_ctr_neighb_name };
	await Bun.write(join(out, 'neighborhoods_bg.geojson'), JSON.stringify(hoods));

	const osm = (await Bun.file(join(RAW, 'osm.json')).json()) as OsmDoc;
	const coord = new Map<number, [number, number]>();
	for (const e of osm.elements) if (e.type === 'node') coord.set(e.id, [e.lon, e.lat]);
	const ways = osm.elements.filter(
		(e): e is Extract<OsmDoc['elements'][number], { type: 'way' }> =>
			e.type === 'way' && e.nodes.some((n) => coord.has(n) && inBBox(coord.get(n)!, BOX)),
	);
	const keep = new Set(ways.flatMap((w) => w.nodes));
	const KEEP_TAGS = [
		'highway',
		'name',
		'ref',
		'lanes',
		'lanes:forward',
		'lanes:backward',
		'maxspeed',
		'oneway',
		'junction',
	];
	await Bun.write(
		join(out, 'osm.json'),
		JSON.stringify({
			elements: [
				...ways.map((w) => ({
					type: 'way',
					id: w.id,
					nodes: w.nodes,
					tags: Object.fromEntries(
						Object.entries(w.tags ?? {}).filter(([k]) => KEEP_TAGS.includes(k)),
					),
				})),
				...[...keep].flatMap((id) => {
					const c = coord.get(id);
					return c ? [{ type: 'node', id, lat: c[1], lon: c[0] }] : [];
				}),
			],
		}),
	);

	const bg = (await Bun.file(join(RAW, 'bg.geojson')).json()) as FeatureCollection;
	bg.features = bg.features.filter((f) => inBBox(centroid(polygonsOf(f.geometry)), BOX));
	await Bun.write(join(out, 'bg.geojson'), JSON.stringify(bg));
	const bgs = new Set(bg.features.map((f) => String(f.properties.GEOID)));

	// Outside zones: a handful of real Massachusetts tracts, so inbound commuting is exercised.
	const tracts = (await Bun.file(join(RAW, 'tracts_ma.geojson')).json()) as FeatureCollection;
	const OUTSIDE = ['25021', '25017', '25023', '25025'];
	const picked = new Map<string, number>();
	tracts.features = tracts.features.filter((f) => {
		const g = String(f.properties.GEOID);
		const county = g.slice(0, 5);
		const n = picked.get(county) ?? 0;
		if (!OUTSIDE.includes(county) || n >= 6 || [...bgs].some((b) => b.startsWith(g))) return false;
		picked.set(county, n + 1);
		return true;
	});
	await Bun.write(join(out, 'tracts_ma.geojson'), JSON.stringify(tracts));
	const tractIds = new Set(tracts.features.map((f) => String(f.properties.GEOID)));

	const inZone = (block: string) => bgs.has(block.slice(0, 12)) || tractIds.has(block.slice(0, 11));
	const lodes: string[] = ['w_geocode,h_geocode,S000'];
	let rest = '';
	for await (const chunk of textOf(join(RAW, 'lodes_od.csv.gz'))) {
		const lines = (rest + chunk).split('\n');
		rest = lines.pop() ?? '';
		for (const line of lines) {
			const [w, h, s] = line.split(',', 3);
			if (
				w &&
				h &&
				w !== 'w_geocode' &&
				inZone(w) &&
				inZone(h) &&
				(bgs.has(w.slice(0, 12)) || bgs.has(h.slice(0, 12)))
			)
				lodes.push(`${w},${h},${s}`);
		}
	}
	await Bun.write(
		join(out, 'lodes_od.csv.gz'),
		Bun.gzipSync(new TextEncoder().encode(`${lodes.join('\n')}\n`)),
	);

	const signals = (await Bun.file(join(RAW, 'signals.geojson')).json()) as FeatureCollection;
	signals.features = signals.features.filter((f) =>
		inBBox(f.geometry.coordinates as [number, number], BOX),
	);
	await Bun.write(join(out, 'signals.geojson'), JSON.stringify(signals));

	const crashes: Array<Record<string, string>> = [];
	for await (const r of csvRecords(textOf(join(RAW, 'crashes.csv')))) {
		if (inBBox([Number(r.long), Number(r.lat)], BOX) && (r.dispatch_ts ?? '') >= '2023')
			crashes.push(r);
	}
	await writeCsv(join(out, 'crashes.csv'), crashes, [
		'dispatch_ts',
		'mode_type',
		'location_type',
		'street',
		'xstreet1',
		'xstreet2',
		'lat',
		'long',
	]);

	const reports: Array<Record<string, string>> = [];
	for await (const r of csvRecords(textOf(join(RAW, '311.csv')))) {
		if (
			inBBox([Number(r.longitude), Number(r.latitude)], BOX) &&
			/signal|pothole|sign repair/i.test(r.type ?? '')
		)
			reports.push(r);
	}
	await writeCsv(join(out, '311.csv'), reports.slice(0, 300), [
		'case_enquiry_id',
		'open_dt',
		'closed_dt',
		'case_status',
		'closure_reason',
		'case_title',
		'reason',
		'type',
		'neighborhood',
		'location',
		'location_street_name',
		'latitude',
		'longitude',
	]);

	// GTFS: the bus routes that stop in the box, their typical patterns, and those trips' stop times.
	const g = join(RAW, 'gtfs');
	const read = async (f: string) => {
		const rows: Array<Record<string, string>> = [];
		for await (const r of csvRecords(textOf(join(g, f)))) rows.push(r);
		return rows;
	};
	const stops = await read('stops.txt');
	const boxStops = new Set(
		stops
			.filter((s) => inBBox([Number(s.stop_lon), Number(s.stop_lat)], BOX))
			.map((s) => s.stop_id),
	);
	const patterns = (await read('route_patterns.txt')).filter(
		(p) => p.route_pattern_typicality === '1',
	);
	const trips = new Set(patterns.map((p) => p.representative_trip_id));
	const stopTimes: Array<Record<string, string>> = [];
	for await (const r of csvRecords(textOf(join(g, 'stop_times.txt'))))
		if (trips.has(r.trip_id ?? '')) stopTimes.push(r);
	const servingTrips = new Set(
		stopTimes.filter((st) => boxStops.has(st.stop_id ?? '')).map((st) => st.trip_id),
	);
	const keptTimes = stopTimes.filter((st) => servingTrips.has(st.trip_id));
	const keptPatterns = patterns.filter((p) => servingTrips.has(p.representative_trip_id ?? ''));
	const routeIds = new Set(keptPatterns.map((p) => p.route_id));
	const usedStops = new Set(keptTimes.map((st) => st.stop_id));
	await writeCsv(
		join(out, 'gtfs/routes.txt'),
		(await read('routes.txt')).filter((r) => routeIds.has(r.route_id)),
		['route_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color'],
	);
	await writeCsv(join(out, 'gtfs/route_patterns.txt'), keptPatterns, [
		'route_pattern_id',
		'route_id',
		'route_pattern_typicality',
		'representative_trip_id',
	]);
	await writeCsv(
		join(out, 'gtfs/stops.txt'),
		stops.filter((s) => usedStops.has(s.stop_id)),
		['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
	);
	await writeCsv(join(out, 'gtfs/stop_times.txt'), keptTimes, [
		'trip_id',
		'arrival_time',
		'departure_time',
		'stop_id',
		'stop_sequence',
	]);

	console.log(
		`fixture → ${out}: ${ways.length} ways, ${bg.features.length} block groups, ${tracts.features.length} outside tracts, ${lodes.length - 1} LODES rows, ${signals.features.length} signals, ${crashes.length} crashes, ${Math.min(reports.length, 300)} 311 cases, ${routeIds.size} bus routes`,
	);
}

if (import.meta.main) await main();
