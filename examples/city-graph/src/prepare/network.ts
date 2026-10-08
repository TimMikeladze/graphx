import { type LngLat, type Polygon, haversine, inPolygon, lineLength } from '../geo.ts';

/**
 * OpenStreetMap ways → a routable directed road network.
 *
 *  1. Split every way at junctions (a node shared by two ways, or a way's end).
 *  2. Expand two-way roads into two directed segments; `oneway`, motorways and roundabouts
 *     are one direction only.
 *  3. Clip to the city: keep a segment when its midpoint is inside the boundary.
 *  4. Merge pass-through nodes (a road continuing with nothing joining it) so an
 *     intersection is a real intersection.
 *  5. Keep the largest strongly connected component, so every origin can reach every
 *     destination — what traffic assignment needs.
 */

export interface OsmNode {
	type: 'node';
	id: number;
	lat: number;
	lon: number;
}
export interface OsmWay {
	type: 'way';
	id: number;
	nodes: number[];
	tags?: Record<string, string>;
}
export interface OsmDoc {
	elements: Array<OsmNode | OsmWay>;
}

export interface Intersection {
	key: string;
	lat: number;
	lng: number;
}

export interface Segment {
	key: string;
	from: string;
	to: string;
	street: string;
	highway: string;
	lengthM: number;
	/** Lanes in this direction. */
	lanes: number;
	/** Seconds to drive it at free flow. */
	freeFlowSec: number;
	/** Vehicles per hour it carries before it starts to queue. */
	capacity: number;
	coords: LngLat[];
}

export interface Network {
	intersections: Intersection[];
	segments: Segment[];
}

const MPH = 0.44704;

/** What to call a road OSM gives no name or ref. */
function unnamed(highway: string | undefined): string {
	if (highway?.endsWith('_link')) return 'ramp';
	return highway === 'service' ? 'service road' : 'unnamed road';
}

/** Default posted speed (mph) by road class when OSM has no `maxspeed`. */
const DEFAULT_MPH: Record<string, number> = {
	motorway: 55,
	trunk: 40,
	primary: 30,
	secondary: 25,
	tertiary: 25,
	unclassified: 25,
	residential: 25,
	living_street: 10,
	motorway_link: 35,
	trunk_link: 30,
	primary_link: 25,
	secondary_link: 25,
	tertiary_link: 25,
};

/** Saturation-ish capacity per lane per hour by class (urban, before signal delay). */
const LANE_CAPACITY: Record<string, number> = {
	motorway: 1900,
	trunk: 1600,
	primary: 850,
	secondary: 750,
	tertiary: 650,
	unclassified: 550,
	residential: 450,
	living_street: 200,
	motorway_link: 1300,
	trunk_link: 1100,
	primary_link: 800,
	secondary_link: 700,
	tertiary_link: 650,
};

/** Typical urban free-flow speed is under the posted limit. */
const FREE_FLOW_FACTOR = 0.85;

function postedMph(tags: Record<string, string>): number {
	const m = /^(\d+)\s*mph$/.exec(tags.maxspeed ?? '');
	return m ? Number(m[1]) : (DEFAULT_MPH[tags.highway ?? ''] ?? 25);
}

/** Lanes in one direction. OSM `lanes` counts both directions on a two-way road. */
function directionalLanes(tags: Record<string, string>, oneway: boolean, forward: boolean): number {
	const dir = forward ? tags['lanes:forward'] : tags['lanes:backward'];
	if (dir && Number(dir) > 0) return Number(dir);
	const total = Number(tags.lanes);
	if (total > 0) return oneway ? total : Math.max(1, Math.floor(total / 2));
	const hw = tags.highway ?? '';
	if (hw === 'motorway' || hw === 'trunk') return 2;
	return 1;
}

/** Which directions a way may be driven: +1 forward, -1 reverse. */
function directions(tags: Record<string, string>): Array<1 | -1> {
	const ow = tags.oneway;
	if (ow === 'yes' || ow === '1' || ow === 'true') return [1];
	if (ow === '-1') return [-1];
	if (ow === 'reversible') return [];
	if (ow === 'no') return [1, -1];
	if (tags.highway === 'motorway' || tags.junction === 'roundabout') return [1];
	return [1, -1];
}

export function buildNetwork(osm: OsmDoc, boundary: Polygon[]): Network {
	const coord = new Map<number, LngLat>();
	const ways: OsmWay[] = [];
	for (const e of osm.elements) {
		if (e.type === 'node') coord.set(e.id, [e.lon, e.lat]);
		else if (e.type === 'way' && e.nodes.length >= 2) ways.push(e);
	}

	// 1. junctions
	const uses = new Map<number, number>();
	for (const w of ways) {
		for (const n of new Set(w.nodes)) uses.set(n, (uses.get(n) ?? 0) + 1);
	}
	const isJunction = (n: number, w: OsmWay, i: number) =>
		i === 0 || i === w.nodes.length - 1 || (uses.get(n) ?? 0) >= 2;

	interface Seg extends Omit<Segment, 'key'> {
		id: number;
	}
	let nextId = 0;
	const segs = new Map<number, Seg>();
	const inside = (p: LngLat) => boundary.some((poly) => inPolygon(p, poly));

	for (const w of ways) {
		const tags = w.tags ?? {};
		const dirs = directions(tags);
		if (dirs.length === 0) continue;
		const oneway = dirs.length === 1;
		let start = 0;
		for (let i = 1; i < w.nodes.length; i++) {
			if (!isJunction(w.nodes[i]!, w, i)) continue;
			const nodeIds = w.nodes.slice(start, i + 1);
			start = i;
			const coords = nodeIds.map((n) => coord.get(n)).filter((c): c is LngLat => c !== undefined);
			if (coords.length < 2 || nodeIds[0] === nodeIds[nodeIds.length - 1]) continue;
			const mid = coords[Math.floor(coords.length / 2)]!;
			if (!inside(mid)) continue;
			const lengthM = lineLength(coords);
			if (lengthM < 1) continue;
			const speed = postedMph(tags) * MPH * FREE_FLOW_FACTOR;
			for (const dir of dirs) {
				const forward = dir === 1;
				const lanes = directionalLanes(tags, oneway, forward);
				const ordered = forward ? coords : [...coords].reverse();
				const ends = forward ? nodeIds : [...nodeIds].reverse();
				const id = nextId++;
				segs.set(id, {
					id,
					from: String(ends[0]),
					to: String(ends[ends.length - 1]),
					street: tags.name ?? tags.ref ?? unnamed(tags.highway),
					highway: tags.highway ?? 'unclassified',
					lengthM,
					lanes,
					freeFlowSec: lengthM / speed,
					capacity: lanes * (LANE_CAPACITY[tags.highway ?? ''] ?? 500),
					coords: ordered,
				});
			}
		}
	}

	// 4. merge pass-through nodes
	const out = new Map<string, Set<number>>();
	const inn = new Map<string, Set<number>>();
	const link = (m: Map<string, Set<number>>, k: string, id: number) => {
		const s = m.get(k);
		if (s) s.add(id);
		else m.set(k, new Set([id]));
	};
	for (const s of segs.values()) {
		link(out, s.from, s.id);
		link(inn, s.to, s.id);
	}
	const unlink = (s: Seg) => {
		out.get(s.from)?.delete(s.id);
		inn.get(s.to)?.delete(s.id);
	};
	const add = (s: Seg) => {
		segs.set(s.id, s);
		link(out, s.from, s.id);
		link(inn, s.to, s.id);
	};
	const merge = (a: Seg, b: Seg): Seg => ({
		id: nextId++,
		from: a.from,
		to: b.to,
		street: a.lengthM >= b.lengthM ? a.street : b.street,
		highway: a.lengthM >= b.lengthM ? a.highway : b.highway,
		lengthM: a.lengthM + b.lengthM,
		lanes: Math.min(a.lanes, b.lanes),
		freeFlowSec: a.freeFlowSec + b.freeFlowSec,
		capacity: Math.min(a.capacity, b.capacity),
		coords: [...a.coords, ...b.coords.slice(1)],
	});

	const nodes = new Set<string>([...out.keys(), ...inn.keys()]);
	for (const v of nodes) {
		const ins = [...(inn.get(v) ?? [])].map((id) => segs.get(id)!);
		const outs = [...(out.get(v) ?? [])].map((id) => segs.get(id)!);
		const neighbours = new Set([...ins.map((s) => s.from), ...outs.map((s) => s.to)]);
		if (neighbours.size !== 2 || neighbours.has(v)) continue;
		let pairs: Array<[Seg, Seg]> | null = null;
		if (ins.length === 1 && outs.length === 1 && ins[0]!.from !== outs[0]!.to) {
			pairs = [[ins[0]!, outs[0]!]]; // one-way pass-through
		} else if (ins.length === 2 && outs.length === 2) {
			const [i1, i2] = ins as [Seg, Seg];
			const o1 = outs.find((o) => o.to !== i1.from);
			const o2 = outs.find((o) => o.to !== i2.from);
			if (o1 && o2 && o1 !== o2)
				pairs = [
					[i1, o1],
					[i2, o2],
				];
		}
		if (!pairs) continue;
		for (const [a, b] of pairs) {
			unlink(a);
			unlink(b);
			segs.delete(a.id);
			segs.delete(b.id);
			add(merge(a, b));
		}
	}

	// 5. largest strongly connected component (iterative Kosaraju)
	const ids = [...new Set([...segs.values()].flatMap((s) => [s.from, s.to]))];
	const index = new Map(ids.map((k, i) => [k, i]));
	const fwd: number[][] = ids.map(() => []);
	const rev: number[][] = ids.map(() => []);
	for (const s of segs.values()) {
		fwd[index.get(s.from)!]!.push(index.get(s.to)!);
		rev[index.get(s.to)!]!.push(index.get(s.from)!);
	}
	const seen = new Uint8Array(ids.length);
	const finish: number[] = [];
	for (let r = 0; r < ids.length; r++) {
		if (seen[r]) continue;
		const stack: Array<[number, number]> = [[r, 0]];
		seen[r] = 1;
		while (stack.length) {
			const top = stack[stack.length - 1]!;
			const [u, i] = top;
			const next = fwd[u]![i];
			if (next === undefined) {
				finish.push(u);
				stack.pop();
				continue;
			}
			top[1]++;
			if (!seen[next]) {
				seen[next] = 1;
				stack.push([next, 0]);
			}
		}
	}
	const comp = new Int32Array(ids.length).fill(-1);
	const size: number[] = [];
	for (let k = finish.length - 1; k >= 0; k--) {
		const r = finish[k]!;
		if (comp[r] !== -1) continue;
		const c = size.length;
		size.push(0);
		const stack = [r];
		comp[r] = c;
		while (stack.length) {
			const u = stack.pop()!;
			size[c]!++;
			for (const v of rev[u]!) {
				if (comp[v] === -1) {
					comp[v] = c;
					stack.push(v);
				}
			}
		}
	}
	const biggest = size.indexOf(Math.max(...size));
	const keep = (k: string) => comp[index.get(k)!] === biggest;

	const intersections: Intersection[] = ids
		.filter(keep)
		.map((k) => {
			const [lng, lat] = coord.get(Number(k))!;
			return { key: `osm:${k}`, lat: round(lat), lng: round(lng) };
		})
		.sort((a, b) => (a.key < b.key ? -1 : 1));
	const seenKeys = new Map<string, number>();
	const segments: Segment[] = [...segs.values()]
		.filter((s) => keep(s.from) && keep(s.to))
		.sort(
			(a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.lengthM - b.lengthM,
		)
		.map((s) => {
			const base = `osm:${s.from}>${s.to}`;
			const n = seenKeys.get(base) ?? 0;
			seenKeys.set(base, n + 1);
			return {
				key: n === 0 ? base : `${base}#${n}`,
				from: `osm:${s.from}`,
				to: `osm:${s.to}`,
				street: s.street,
				highway: s.highway,
				lengthM: Math.round(s.lengthM * 10) / 10,
				lanes: s.lanes,
				freeFlowSec: Math.round(s.freeFlowSec * 10) / 10,
				capacity: s.capacity,
				coords: s.coords.map(([x, y]) => [round(x), round(y)] as LngLat),
			};
		});
	return { intersections, segments };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** Straight-line distance between two intersections, for A* and sanity checks. */
export function crowFlies(a: Intersection, b: Intersection): number {
	return haversine([a.lng, a.lat], [b.lng, b.lat]);
}
