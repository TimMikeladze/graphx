import { type LngLat, type Polygon, GridIndex, centroid, inPolygon, polygonsOf } from '../geo.ts';
import { parseBostonLocal } from '../time.ts';
import type { Intersection, Network } from './network.ts';

/**
 * Everything that is not the road network, snapped onto it: census zones, signals, crashes and
 * 311 reports. Each is a pure function from parsed source rows to prepared records.
 */

interface Feature {
	properties: Record<string, unknown>;
	geometry: { type: string; coordinates: unknown };
}
export interface FeatureCollection {
	features: Feature[];
}

const MA_COUNTIES: Record<string, string> = {
	'001': 'Barnstable',
	'003': 'Berkshire',
	'005': 'Bristol',
	'007': 'Dukes',
	'009': 'Essex',
	'011': 'Franklin',
	'013': 'Hampden',
	'015': 'Hampshire',
	'017': 'Middlesex',
	'019': 'Nantucket',
	'021': 'Norfolk',
	'023': 'Plymouth',
	'025': 'Suffolk',
	'027': 'Worcester',
};

export interface Zone {
	key: string;
	geoid: string;
	kind: 'boston' | 'external';
	name: string;
	neighborhood: string;
	lat: number;
	lng: number;
	/** The intersections trips to and from this zone start and end at (nearest first). */
	connectors: string[];
	/** Simplified outline for the choropleth (Boston block groups only). */
	outline: Polygon[] | null;
}

/** Trips from outside the city enter by highway — I-93, I-90, US-1, Route 1, the parkways. */
const ARTERIAL = new Set(['motorway', 'trunk']);
/** A zone's trips are spread over this many nearby intersections, so no one node takes them all. */
const CONNECTORS = 3;
/** Local trips start on local streets, not on a highway ramp. */
const LOCAL = new Set([
	'residential',
	'tertiary',
	'secondary',
	'unclassified',
	'living_street',
	'primary',
]);

function intersectionIndex(net: Network, accept?: (key: string) => boolean) {
	return new GridIndex<Intersection>(
		net.intersections
			.filter((i) => !accept || accept(i.key))
			.map((i) => ({ p: [i.lng, i.lat] as LngLat, v: i })),
		250,
	);
}

export function boundaryOf(neighborhoods: FeatureCollection): Polygon[] {
	return neighborhoods.features.flatMap((f) => polygonsOf(f.geometry));
}

/**
 * Boston block groups (centroid inside a neighbourhood) become zones; every other Massachusetts
 * tract becomes an external zone that enters the city at the nearest arterial intersection.
 */
export function buildZones(
	net: Network,
	neighborhoods: FeatureCollection,
	blockGroups: FeatureCollection,
	tracts: FeatureCollection,
): Zone[] {
	const hoods = neighborhoods.features.map((f) => ({
		name: String(f.properties.blockgr2020_ctr_neighb_name ?? f.properties.name ?? 'Boston'),
		polys: polygonsOf(f.geometry),
	}));
	const hoodOf = (p: LngLat) => hoods.find((h) => h.polys.some((poly) => inPolygon(p, poly)))?.name;

	const nodesOn = (classes: Set<string>) => {
		const out = new Set<string>();
		for (const s of net.segments) {
			if (classes.has(s.highway)) {
				out.add(s.from);
				out.add(s.to);
			}
		}
		return out;
	};
	const localNodes = nodesOn(LOCAL);
	const arterialNodes = nodesOn(ARTERIAL);
	const local = intersectionIndex(net, (k) => localNodes.has(k));
	const entry = intersectionIndex(net, (k) => arterialNodes.has(k));

	const zones: Zone[] = [];
	const bostonTracts = new Set<string>();
	for (const f of blockGroups.features) {
		const polys = polygonsOf(f.geometry);
		const c = centroid(polys);
		const hood = hoodOf(c);
		if (!hood) continue;
		const geoid = String(f.properties.GEOID);
		bostonTracts.add(geoid.slice(0, 11));
		const near = local.nearestK(c, CONNECTORS);
		if (near.length === 0) continue;
		const tract = String(f.properties.TRACT);
		zones.push({
			key: `bg:${geoid}`,
			geoid,
			kind: 'boston',
			name: `${hood} · tract ${Number(tract.slice(0, 4))}${tract.slice(4) === '00' ? '' : `.${tract.slice(4)}`} bg ${f.properties.BLKGRP}`,
			neighborhood: hood,
			lat: round(c[1]),
			lng: round(c[0]),
			connectors: near.map((n) => n.v.key),
			outline: polys.map((poly) =>
				poly.map((ring) => ring.map(([x, y]) => [round(x), round(y)] as LngLat)),
			),
		});
	}
	for (const f of tracts.features) {
		const geoid = String(f.properties.GEOID);
		if (bostonTracts.has(geoid)) continue;
		const c = centroid(polygonsOf(f.geometry));
		const near = entry.nearestK(c, CONNECTORS);
		if (near.length === 0) continue;
		const county = MA_COUNTIES[geoid.slice(2, 5)] ?? 'Massachusetts';
		zones.push({
			key: `tract:${geoid}`,
			geoid,
			kind: 'external',
			name: `${county} County · tract ${Number(geoid.slice(5, 9))}`,
			neighborhood: `${county} County`,
			lat: round(c[1]),
			lng: round(c[0]),
			connectors: near.map((n) => n.v.key),
			outline: null,
		});
	}
	return zones.sort((a, b) => (a.key < b.key ? -1 : 1));
}

export interface Flow {
	home: string;
	work: string;
	workers: number;
}

/**
 * LODES origin–destination rows (one per home block × work block) → zone-to-zone flows. A block
 * maps to its Boston block group, else its tract; flows with neither end in Boston are dropped.
 */
export function aggregateFlows(
	rows: Iterable<{ w: string; h: string; jobs: number }>,
	zones: Zone[],
): Flow[] {
	const bg = new Set(zones.filter((z) => z.kind === 'boston').map((z) => z.geoid));
	const tract = new Set(zones.filter((z) => z.kind === 'external').map((z) => z.geoid));
	const zoneOf = (block: string): { key: string; boston: boolean } | null => {
		const g = block.slice(0, 12);
		if (bg.has(g)) return { key: `bg:${g}`, boston: true };
		const t = block.slice(0, 11);
		if (tract.has(t)) return { key: `tract:${t}`, boston: false };
		return null;
	};
	const acc = new Map<string, number>();
	for (const r of rows) {
		const h = zoneOf(r.h);
		const w = zoneOf(r.w);
		if (!h || !w || (!h.boston && !w.boston) || h.key === w.key) continue;
		const k = `${h.key}|${w.key}`;
		acc.set(k, (acc.get(k) ?? 0) + r.jobs);
	}
	return [...acc]
		.map(([k, workers]) => {
			const [home, work] = k.split('|') as [string, string];
			return { home, work, workers };
		})
		.sort((a, b) => b.workers - a.workers || (a.home + a.work < b.home + b.work ? -1 : 1));
}

export interface SignalPlan {
	cityId: number;
	name: string;
	cycleSec: number;
	/** Street → seconds of green per cycle, for every street approaching the intersection. */
	green: Record<string, number>;
	synthetic: true;
}

/**
 * Boston's signal inventory gives where the ~850 signals are, not how they are timed, so each
 * plan is synthesised: a longer cycle where an arterial meets, green split by approach capacity,
 * 4 s lost per phase, never under 10 s of green.
 */
export function buildSignals(
	net: Network,
	signals: FeatureCollection,
	maxM = 45,
): Map<string, SignalPlan> {
	const idx = intersectionIndex(net);
	const approaches = new Map<string, Map<string, { capacity: number; highway: string }>>();
	for (const s of net.segments) {
		let m = approaches.get(s.to);
		if (!m) approaches.set(s.to, (m = new Map()));
		const prev = m.get(s.street);
		m.set(s.street, {
			capacity: (prev?.capacity ?? 0) + s.capacity,
			highway: prev && rank(prev.highway) > rank(s.highway) ? prev.highway : s.highway,
		});
	}
	const plans = new Map<string, SignalPlan>();
	for (const f of signals.features) {
		const [lng, lat] = f.geometry.coordinates as LngLat;
		const near = idx.nearest([lng, lat], maxM);
		if (!near || plans.has(near.v.key)) continue;
		const app = approaches.get(near.v.key);
		if (!app || app.size < 1) continue;
		const streets = [...app];
		const major = Math.max(...streets.map(([, a]) => rank(a.highway)));
		const cycleSec = major >= 4 ? 110 : major >= 3 ? 90 : 70;
		const phases = Math.max(2, Math.min(streets.length, 3));
		const usable = cycleSec - 4 * phases;
		const total = streets.reduce((t, [, a]) => t + a.capacity, 0) || 1;
		const green: Record<string, number> = {};
		for (const [street, a] of streets) {
			green[street] = Math.max(10, Math.round((usable * a.capacity) / total));
		}
		if (streets.length === 1) green[streets[0]![0]] = Math.round(usable / 2);
		plans.set(near.v.key, {
			cityId: Number(f.properties.Int_Number ?? f.properties.OBJECTID ?? 0),
			name: String(f.properties.Location ?? near.v.key),
			cycleSec,
			green,
			synthetic: true,
		});
	}
	return plans;
}

function rank(highway: string): number {
	const base = highway.replace('_link', '');
	return (
		({ motorway: 5, trunk: 4, primary: 4, secondary: 3, tertiary: 2 } as Record<string, number>)[
			base
		] ?? 1
	);
}

export interface Crash {
	key: string;
	at: number;
	mode: 'ped' | 'bike' | 'mv';
	locationType: string;
	street: string;
	lat: number;
	lng: number;
	intersection: string | null;
}

/** Vision Zero crash records → crashes snapped to the nearest intersection within 60 m. */
export function buildCrashes(net: Network, rows: Array<Record<string, string>>): Crash[] {
	const idx = intersectionIndex(net);
	const out: Crash[] = [];
	for (const [i, r] of rows.entries()) {
		const lat = Number(r.lat);
		const lng = Number(r.long);
		const at = Date.parse((r.dispatch_ts ?? '').replace(' ', 'T').replace(/\+00$/, 'Z'));
		if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(at) || lat === 0)
			continue;
		const mode = r.mode_type === 'ped' || r.mode_type === 'bike' ? r.mode_type : 'mv';
		const near = idx.nearest([lng, lat], 60);
		const cross = [r.xstreet1, r.xstreet2].filter(Boolean).join(' / ');
		out.push({
			key: `crash:${at}:${i}`,
			at,
			mode,
			locationType: r.location_type ?? '',
			street: titleCase([r.street, cross].filter(Boolean).join(' & ')),
			lat: round(lat),
			lng: round(lng),
			intersection: near?.v.key ?? null,
		});
	}
	return out;
}

/** 311 case types that are about the street itself — signals, signs, markings, pavement. */
export const STREET_TYPES =
	/signal|pothole|sign repair|crosswalk|pavement|roadway|street light|bike|speed|traffic|sidewalk repair/i;

export interface Report {
	key: string;
	caseId: string;
	type: string;
	title: string;
	status: string;
	openedAt: number;
	closedAt: number | null;
	street: string;
	neighborhood: string;
	lat: number;
	lng: number;
	intersection: string | null;
	body: string;
}

// 311 timestamps are Boston wall-clock time without an offset.
const parseLocal = parseBostonLocal;

/** 311 cases about the street → reports, open from `open_dt` until `closed_dt`. */
export function buildReports(net: Network, rows: Iterable<Record<string, string>>): Report[] {
	const idx = intersectionIndex(net);
	const out: Report[] = [];
	for (const r of rows) {
		const type = r.type ?? '';
		if (!STREET_TYPES.test(type) || /parking/i.test(type)) continue;
		const lat = Number(r.latitude);
		const lng = Number(r.longitude);
		const openedAt = parseLocal(r.open_dt);
		if (!Number.isFinite(lat) || !Number.isFinite(lng) || openedAt === null) continue;
		// The city geocodes a case with no address to City Hall; those are not about a street.
		if (Math.abs(lat - 42.3594) < 1e-4 && Math.abs(lng + 71.0587) < 1e-4) continue;
		const closedAt = parseLocal(r.closed_dt);
		const near = idx.nearest([lng, lat], 100);
		const title = decode(r.case_title || type);
		const street = decode(r.location_street_name || r.location || '');
		out.push({
			key: `311:${r.case_enquiry_id}`,
			caseId: String(r.case_enquiry_id),
			type,
			title,
			status: r.case_status ?? '',
			openedAt,
			closedAt: closedAt !== null && closedAt > openedAt ? closedAt : null,
			street,
			neighborhood: r.neighborhood ?? '',
			lat: round(lat),
			lng: round(lng),
			intersection: near?.v.key ?? null,
			body: [title, type, r.reason, decode(r.closure_reason ?? ''), street, r.neighborhood]
				.filter((s) => s && s.trim())
				.join('. '),
		});
	}
	return out;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
/** 311 exports carry HTML entities (`Cedar Ave &amp; Bowdoin St`). */
const decode = (s: string) =>
	s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>');
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
