/**
 * Stage 1 of 3: download every source into `data/raw/`. Re-running skips what is already there
 * (`--force` re-fetches). Requests carry a plain User-Agent and nothing identifying, are
 * sequential, and retry with backoff; Overpass falls back across public mirrors.
 *
 *   bun src/download.ts [--force]
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RAW = join(import.meta.dir, '../data/raw');

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Boston's bounding box; the network is clipped to the city boundary in `prepare`. */
const BBOX = '42.227,-71.191,42.397,-70.986';
const HIGHWAYS =
	'motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street';

const TIGER =
	'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';
const BOSTON = 'https://data.boston.gov/dataset';

/** Every source, pinned. See the README's "Data" table for what each one becomes. */
export const SOURCES: Array<{ file: string; url: string; body?: string; overpass?: boolean }> = [
	{
		file: 'osm.json',
		overpass: true,
		url: 'https://overpass-api.de/api/interpreter',
		body: `[out:json][timeout:300][bbox:${BBOX}];way["highway"~"^(${HIGHWAYS})$"];out body;>;out skel qt;`,
	},
	{
		file: 'neighborhoods_bg.geojson',
		url: `${BOSTON}/e11a621a-6561-4da6-a715-6edd2fa217a4/resource/c9663e7a-84c2-435c-91c0-91cdce1ee5ac/download/boston_neighborhood_boundaries_approximated_by_2020_census_block_groups.geojson`,
	},
	{
		file: 'bg.geojson',
		url: `${TIGER}/10/query?where=STATE%3D%2725%27+AND+COUNTY%3D%27025%27&outFields=GEOID,TRACT,BLKGRP,AREALAND&outSR=4326&f=geojson`,
	},
	{
		file: 'tracts_ma.geojson',
		url: `${TIGER}/8/query?where=STATE%3D%2725%27&outFields=GEOID&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.002&f=geojson`,
	},
	{
		file: 'lodes_od.csv.gz',
		url: 'https://lehd.ces.census.gov/data/lodes/LODES8/ma/od/ma_od_main_JT00_2023.csv.gz',
	},
	{
		file: 'signals.geojson',
		url: `${BOSTON}/dcf6ae82-f1f7-4e4e-873e-249574b9a668/resource/f2d82dcd-4479-45cc-a83f-8575eb8a923e/download/traffic_signals.geojson`,
	},
	{
		file: 'crashes.csv',
		url: `${BOSTON}/7b29c1b2-7ec2-4023-8292-c24f5d8f0905/resource/e4bfe397-6bfc-49c5-9367-c879fac7401d/download/tmpelb75iks.csv`,
	},
	{
		file: '311.csv',
		url: `${BOSTON}/8048697b-ad64-4bfc-b090-ee00169f2323/resource/1a0b420d-99f1-4887-9851-990b2a5a6e17/download/tmpp820kg_4.csv`,
	},
	{ file: 'MBTA_GTFS.zip', url: 'https://cdn.mbta.com/MBTA_GTFS.zip' },
];

const OVERPASS_MIRRORS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
	'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function fetchOnce(url: string, body?: string): Promise<Response> {
	return fetch(url, {
		method: body ? 'POST' : 'GET',
		// Overpass rejects browser user agents with a 406; it gets a neutral tool name instead.
		headers: {
			'user-agent': body ? 'osm-fetch/1.0' : UA,
			...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
		},
		body: body ? `data=${encodeURIComponent(body)}` : undefined,
		redirect: 'follow',
	});
}

async function download(src: (typeof SOURCES)[number], force: boolean): Promise<void> {
	const out = join(RAW, src.file);
	if (!force && existsSync(out) && statSync(out).size > 1000) {
		console.log(`  ✓ ${src.file} (cached)`);
		return;
	}
	const urls = src.overpass ? OVERPASS_MIRRORS : [src.url];
	for (let attempt = 0; attempt < 4; attempt++) {
		for (const url of urls) {
			try {
				const res = await fetchOnce(url, src.body);
				const bytes = new Uint8Array(await res.arrayBuffer());
				// A JSON source must parse to something with features/elements, not an error page.
				const ok = res.ok && (!src.file.endsWith('json') || bytes[0] === 0x7b);
				if (ok) {
					await Bun.write(out, bytes);
					console.log(`  ↓ ${src.file} ${(bytes.length / 1e6).toFixed(1)} MB`);
					return;
				}
				console.warn(`  ! ${src.file}: ${res.status} from ${new URL(url).host}`);
			} catch (e) {
				console.warn(`  ! ${src.file}: ${(e as Error).message}`);
			}
		}
		await Bun.sleep(5000 * 2 ** attempt);
	}
	throw new Error(`could not download ${src.file}`);
}

export async function downloadAll(force = false): Promise<void> {
	mkdirSync(RAW, { recursive: true });
	for (const s of SOURCES) await download(s, force);
	// GTFS: unpack only the four tables `prepare` reads.
	const gtfs = join(RAW, 'gtfs');
	mkdirSync(gtfs, { recursive: true });
	const unzip = Bun.spawnSync([
		'unzip',
		'-o',
		'-q',
		join(RAW, 'MBTA_GTFS.zip'),
		'routes.txt',
		'route_patterns.txt',
		'stops.txt',
		'stop_times.txt',
		'-d',
		gtfs,
	]);
	if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr.toString()}`);
	console.log('  ✓ gtfs/ unpacked');
}

if (import.meta.main) {
	console.log(`downloading Boston sources → ${RAW}`);
	await downloadAll(process.argv.includes('--force'));
}
