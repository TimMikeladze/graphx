import { type Polygon, inPolygon } from '../geo.ts';

/**
 * MBTA GTFS → bus stops and the scheduled links between consecutive stops. One representative
 * trip per typical route pattern gives the stop order and the scheduled seconds per link.
 */

export interface Stop {
	key: string;
	gtfsId: string;
	name: string;
	lat: number;
	lng: number;
}

export interface Route {
	key: string;
	gtfsId: string;
	name: string;
	longName: string;
	color: string;
}

export interface TransitLink {
	key: string;
	from: string;
	to: string;
	route: string;
	scheduledSec: number;
}

export interface Transit {
	routes: Route[];
	stops: Stop[];
	links: TransitLink[];
}

/** `HH:MM:SS` (GTFS allows hours past 24) → seconds. */
const secs = (t: string) => {
	const [h, m, s] = t.split(':').map(Number);
	return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
};

export interface GtfsTables {
	routes: Array<Record<string, string>>;
	patterns: Array<Record<string, string>>;
	stops: Array<Record<string, string>>;
	/** stop_times rows, already filtered to the representative trips. */
	stopTimes: Array<Record<string, string>>;
}

/** The trip ids `stop_times` has to be scanned for (so the 150 MB file is read once, filtered). */
export function representativeTrips(
	routes: GtfsTables['routes'],
	patterns: GtfsTables['patterns'],
): Set<string> {
	const bus = new Set(routes.filter((r) => r.route_type === '3').map((r) => r.route_id));
	return new Set(
		patterns
			.filter((p) => bus.has(p.route_id ?? '') && p.route_pattern_typicality === '1')
			.map((p) => p.representative_trip_id ?? ''),
	);
}

export function buildTransit(t: GtfsTables, boundary: Polygon[]): Transit {
	const inside = (lng: number, lat: number) => boundary.some((p) => inPolygon([lng, lat], p));
	const busRoutes = t.routes.filter((r) => r.route_type === '3');
	const routeOfTrip = new Map(
		t.patterns
			.filter((p) => p.route_pattern_typicality === '1')
			.map((p) => [p.representative_trip_id ?? '', p.route_id ?? '']),
	);
	const stopById = new Map(t.stops.map((s) => [s.stop_id ?? '', s]));

	const byTrip = new Map<string, Array<{ seq: number; stop: string; arr: number; dep: number }>>();
	for (const st of t.stopTimes) {
		const trip = st.trip_id ?? '';
		let list = byTrip.get(trip);
		if (!list) byTrip.set(trip, (list = []));
		list.push({
			seq: Number(st.stop_sequence),
			stop: st.stop_id ?? '',
			arr: secs(st.arrival_time ?? '0:0:0'),
			dep: secs(st.departure_time ?? '0:0:0'),
		});
	}

	const usedStops = new Set<string>();
	const links = new Map<string, TransitLink>();
	for (const [trip, list] of byTrip) {
		const route = routeOfTrip.get(trip);
		if (!route) continue;
		list.sort((a, b) => a.seq - b.seq);
		for (let i = 1; i < list.length; i++) {
			const a = list[i - 1]!;
			const b = list[i]!;
			const sa = stopById.get(a.stop);
			const sb = stopById.get(b.stop);
			if (!sa || !sb) continue;
			if (!inside(+sa.stop_lon!, +sa.stop_lat!) || !inside(+sb.stop_lon!, +sb.stop_lat!)) continue;
			const key = `link:${route}:${a.stop}>${b.stop}`;
			if (links.has(key)) continue;
			usedStops.add(a.stop);
			usedStops.add(b.stop);
			links.set(key, {
				key,
				from: `stop:${a.stop}`,
				to: `stop:${b.stop}`,
				route: `route:${route}`,
				scheduledSec: Math.max(10, b.arr - a.dep),
			});
		}
	}

	const servedRoutes = new Set([...links.values()].map((l) => l.route));
	return {
		routes: busRoutes
			.map((r) => ({
				key: `route:${r.route_id}`,
				gtfsId: r.route_id ?? '',
				name: r.route_short_name || r.route_id || '',
				longName: r.route_long_name ?? '',
				color: `#${r.route_color || '7C878E'}`,
			}))
			.filter((r) => servedRoutes.has(r.key)),
		stops: [...usedStops].sort().map((id) => {
			const s = stopById.get(id)!;
			return {
				key: `stop:${id}`,
				gtfsId: id,
				name: s.stop_name ?? id,
				lat: Number(s.stop_lat),
				lng: Number(s.stop_lon),
			};
		}),
		links: [...links.values()],
	};
}
