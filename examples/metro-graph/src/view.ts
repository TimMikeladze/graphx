import type { EdgeRecord, Graph } from 'graphx';
import {
	DAYS,
	type Day,
	type PatternData,
	type RouteData,
	type Schema,
	type StopData,
	type TripData,
} from '../schema.ts';
import { haversine } from './geo.ts';

/** Read page size: under bql.sh's default 10k-row result cap. */
const PAGE = 5000;

/**
 * The whole network of one graph (baseline or a scenario branch) in memory. 31k trips and 6k
 * stops read in about a second; the server keeps one per project and drops it on every edit.
 */
export interface View {
	routes: Array<{ id: string; data: RouteData }>;
	stops: Array<{ id: string; data: StopData }>;
	patterns: Array<{ id: string; data: PatternData }>;
	trips: Array<{ id: string; data: TripData }>;
	route: Map<string, { id: string; data: RouteData }>; // by gtfsId
	stop: Map<string, { id: string; data: StopData }>; // by gtfsId
	pattern: Map<string, { id: string; data: PatternData }>; // by key
	tripsOf: Map<string, Array<{ id: string; data: TripData }>>; // by route gtfsId
}

export async function allNodes<T extends keyof Schema['nodes']>(
	g: Graph<Schema>,
	type: T,
): Promise<Array<{ id: string; data: Schema['nodes'][T]['_output'] }>> {
	const out: Array<{ id: string; data: Schema['nodes'][T]['_output'] }> = [];
	let cursor: string | undefined;
	do {
		const page = await g.listNodes({ type, limit: PAGE, cursor });
		for (const n of page.nodes) out.push({ id: n.id, data: n.data as never });
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return out;
}

export async function allEdges(
	g: Graph<Schema>,
	opts: { rel?: string; src?: string; dst?: string },
): Promise<EdgeRecord[]> {
	const out: EdgeRecord[] = [];
	let cursor: string | undefined;
	do {
		const page = await g.listEdges({ ...opts, limit: PAGE, cursor });
		out.push(...page.edges);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return out;
}

export async function readView(g: Graph<Schema>): Promise<View> {
	const [routes, stops, patterns, trips] = await Promise.all([
		allNodes(g, 'route'),
		allNodes(g, 'stop'),
		allNodes(g, 'pattern'),
		allNodes(g, 'trip'),
	]);
	const tripsOf = new Map<string, Array<{ id: string; data: TripData }>>();
	for (const t of trips) {
		if (!tripsOf.has(t.data.route)) tripsOf.set(t.data.route, []);
		tripsOf.get(t.data.route)!.push(t);
	}
	for (const list of tripsOf.values()) list.sort((a, b) => a.data.start - b.data.start);
	return {
		routes,
		stops,
		patterns,
		trips,
		route: new Map(routes.map((r) => [r.data.gtfsId, r])),
		stop: new Map(stops.map((s) => [s.data.gtfsId, s])),
		pattern: new Map(patterns.map((p) => [p.data.key, p])),
		tripsOf,
	};
}

export const duration = (t: TripData) => t.times[t.times.length - 1] ?? 0;

/**
 * The map payload: every pattern with its line, where each stop falls along it, and its trips as
 * `[start, duration, dayMask]`. The page animates scheduled buses from this without another call.
 */
export function networkPayload(v: View) {
	const byPattern = new Map<string, Array<[number, number, number]>>();
	for (const t of v.trips) {
		const mask = t.data.days.reduce((m, d) => m | (1 << DAYS.indexOf(d)), 0);
		if (!byPattern.has(t.data.pattern)) byPattern.set(t.data.pattern, []);
		byPattern.get(t.data.pattern)!.push([t.data.start, duration(t.data), mask]);
	}
	return {
		routes: v.routes.map((r) => ({ id: r.id, ...r.data })),
		stops: v.stops.map((s) => ({ id: s.id, ...s.data })),
		patterns: v.patterns.map((p) => {
			const cum = cumulative(p.data.coords);
			return {
				id: p.id,
				key: p.data.key,
				route: p.data.route,
				direction: p.data.direction,
				headsign: p.data.headsign,
				coords: p.data.coords,
				cum,
				stopDist: stopDistances(p.data, v, cum),
				offsets: p.data.offsets,
				trips: (byPattern.get(p.data.key) ?? []).sort((a, b) => a[0] - b[0]),
			};
		}),
	};
}

export function cumulative(coords: [number, number][]): number[] {
	const cum = [0];
	for (let i = 1; i < coords.length; i++)
		cum.push(cum[i - 1]! + haversine(coords[i - 1]!, coords[i]!));
	return cum.map(Math.round);
}

/** Distance along the line of each stop: the nearest vertex at or after the previous stop's. */
function stopDistances(p: PatternData, v: View, cum: number[]): number[] {
	let from = 0;
	return p.stops.map((gtfsId) => {
		const s = v.stop.get(gtfsId)?.data;
		if (!s) return cum[from]!;
		let best = from;
		let bestD = Infinity;
		for (let i = from; i < p.coords.length; i++) {
			const d = haversine(p.coords[i]!, [s.lng, s.lat]);
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		from = best;
		return cum[best]!;
	});
}

/** Service totals per day: trips, revenue hours, stops with any service, per-route trips. */
export function summary(v: View) {
	const out = {} as Record<
		Day,
		{ trips: number; revenueHours: number; stopsServed: number; routes: Record<string, number> }
	>;
	for (const day of DAYS) {
		const stops = new Set<string>();
		const routes: Record<string, number> = {};
		let trips = 0;
		let seconds = 0;
		for (const t of v.trips) {
			if (!t.data.days.includes(day)) continue;
			trips++;
			seconds += duration(t.data);
			routes[t.data.route] = (routes[t.data.route] ?? 0) + 1;
			for (const s of v.pattern.get(t.data.pattern)?.data.stops ?? []) stops.add(s);
		}
		out[day] = {
			trips,
			revenueHours: Math.round(seconds / 360) / 10,
			stopsServed: stops.size,
			routes,
		};
	}
	return out;
}

/** Stops served on `day` in `a` and not in `b`. */
export function stopsLost(a: View, b: View, day: Day): string[] {
	const served = (v: View) => {
		const s = new Set<string>();
		for (const t of v.trips)
			if (t.data.days.includes(day))
				for (const id of v.pattern.get(t.data.pattern)?.data.stops ?? []) s.add(id);
		return s;
	};
	const sb = served(b);
	return [...served(a)].filter((s) => !sb.has(s));
}
