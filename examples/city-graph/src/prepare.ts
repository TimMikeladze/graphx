/**
 * Stage 2 of 3: raw downloads → prepared JSON (`data/prepared/`). Pure parsing and snapping;
 * nothing touches the graph yet. `bun src/prepare.ts [rawDir] [outDir]`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { csvRecords, textOf } from './csv.ts';
import { buildNetwork, type Network, type OsmDoc } from './prepare/network.ts';
import {
	aggregateFlows,
	boundaryOf,
	buildCrashes,
	buildReports,
	buildSignals,
	buildZones,
	STREET_TYPES,
	type Crash,
	type FeatureCollection,
	type Flow,
	type Report,
	type SignalPlan,
	type Zone,
} from './prepare/places.ts';
import { buildTransit, representativeTrips, type Transit } from './prepare/transit.ts';

export interface Prepared {
	network: Network;
	zones: Zone[];
	flows: Flow[];
	signals: Record<string, SignalPlan>;
	crashes: Crash[];
	reports: Report[];
	transit: Transit;
}

const PREPARED_FILES = [
	'network',
	'zones',
	'flows',
	'signals',
	'crashes',
	'reports',
	'transit',
] as const;

async function json<T>(path: string): Promise<T> {
	return (await Bun.file(path).json()) as T;
}

async function records(path: string, keep?: (r: Record<string, string>) => boolean) {
	const out: Array<Record<string, string>> = [];
	for await (const r of csvRecords(textOf(path))) if (!keep || keep(r)) out.push(r);
	return out;
}

/** LODES OD rows: unquoted numeric CSV, so a plain line split is enough (and ~10× faster). */
async function lodesRows(path: string) {
	const rows: Array<{ w: string; h: string; jobs: number }> = [];
	let rest = '';
	let header = true;
	for await (const chunk of textOf(path)) {
		const lines = (rest + chunk).split('\n');
		rest = lines.pop() ?? '';
		for (const line of lines) {
			if (header) {
				header = false;
				continue;
			}
			const [w, h, s000] = line.split(',', 3);
			if (w && h) rows.push({ w, h, jobs: Number(s000) });
		}
	}
	const [w, h, s000] = rest.split(',', 3);
	if (w && h && !header) rows.push({ w, h, jobs: Number(s000) });
	return rows;
}

/** GTFS tables: the zip is unpacked by `download`; stop_times is filtered while streaming. */
async function gtfs(dir: string) {
	const routes = await records(join(dir, 'routes.txt'));
	const patterns = await records(join(dir, 'route_patterns.txt'));
	const stops = await records(join(dir, 'stops.txt'));
	const wanted = representativeTrips(routes, patterns);
	const stopTimes = await records(join(dir, 'stop_times.txt'), (r) => wanted.has(r.trip_id ?? ''));
	return { routes, patterns, stops, stopTimes };
}

export async function prepareAll(
	raw: string,
	say: (s: string) => void = console.log,
): Promise<Prepared> {
	let last = performance.now();
	const log = (s: string) => {
		const now = performance.now();
		say(`${s}  (${((now - last) / 1000).toFixed(1)}s)`);
		last = now;
	};
	const neighborhoods = await json<FeatureCollection>(join(raw, 'neighborhoods_bg.geojson'));
	const boundary = boundaryOf(neighborhoods);

	const network = buildNetwork(await json<OsmDoc>(join(raw, 'osm.json')), boundary);
	log(
		`network   ${network.intersections.length} intersections, ${network.segments.length} segments`,
	);

	const zones = buildZones(
		network,
		neighborhoods,
		await json<FeatureCollection>(join(raw, 'bg.geojson')),
		await json<FeatureCollection>(join(raw, 'tracts_ma.geojson')),
	);
	log(
		`zones     ${zones.filter((z) => z.kind === 'boston').length} Boston block groups, ${zones.filter((z) => z.kind === 'external').length} outside tracts`,
	);

	const flows = aggregateFlows(await lodesRows(join(raw, 'lodes_od.csv.gz')), zones);
	log(
		`flows     ${flows.length} zone pairs, ${flows.reduce((s, f) => s + f.workers, 0)} commuters`,
	);

	const signals = Object.fromEntries(
		buildSignals(network, await json<FeatureCollection>(join(raw, 'signals.geojson'))),
	);
	log(`signals   ${Object.keys(signals).length} snapped to intersections`);

	const crashes = buildCrashes(network, await records(join(raw, 'crashes.csv')));
	log(
		`crashes   ${crashes.length} (${crashes.filter((c) => c.intersection).length} at an intersection)`,
	);

	const reports = buildReports(
		network,
		await records(join(raw, '311.csv'), (r) => STREET_TYPES.test(r.type ?? '')),
	);
	log(`reports   ${reports.length} street-related 311 cases`);

	const transit = buildTransit(await gtfs(join(raw, 'gtfs')), boundary);
	log(
		`transit   ${transit.routes.length} bus routes, ${transit.stops.length} stops, ${transit.links.length} links`,
	);

	return { network, zones, flows, signals, crashes, reports, transit };
}

export async function writePrepared(dir: string, p: Prepared): Promise<void> {
	mkdirSync(dir, { recursive: true });
	for (const name of PREPARED_FILES)
		await Bun.write(join(dir, `${name}.json`), JSON.stringify(p[name]));
}

/** What the traffic model needs — the network, signals, zones and flows, without the rest. */
export type ModelInputs = Pick<Prepared, 'network' | 'signals' | 'zones' | 'flows'>;

export async function readModelInputs(dir: string): Promise<ModelInputs> {
	const [network, signals, zones, flows] = await Promise.all(
		(['network', 'signals', 'zones', 'flows'] as const).map((n) => json(join(dir, `${n}.json`))),
	);
	return { network, signals, zones, flows } as ModelInputs;
}

export async function readPrepared(dir: string): Promise<Prepared> {
	const entries = await Promise.all(
		PREPARED_FILES.map(async (n) => [n, await json(join(dir, `${n}.json`))]),
	);
	return Object.fromEntries(entries) as Prepared;
}

if (import.meta.main) {
	const raw = process.argv[2] ?? join(import.meta.dir, '../data/raw');
	const out = process.argv[3] ?? join(import.meta.dir, '../data/prepared');
	const t = performance.now();
	await writePrepared(out, await prepareAll(raw));
	console.log(`prepared  → ${out} in ${((performance.now() - t) / 1000).toFixed(1)}s`);
}
