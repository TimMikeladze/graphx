import type { Graph } from 'graphx';
import type { Schema } from '../schema.ts';

/**
 * Live MBTA buses. Positions are streamed to the map and never stored — a ping every few
 * seconds per bus would be millions of versions a day saying nothing new. What is stored is the
 * measurement: when a bus moves from one stop to the next, the seconds it took become a new
 * version of that `transitLink` (observed time beside the scheduled one), so `history` on a link
 * is a record of how long that hop really takes.
 *
 * The V3 API needs no key for this volume (one request per poll). No identifying headers are sent.
 */

export interface Vehicle {
	id: string;
	route: string;
	lat: number;
	lng: number;
	bearing: number;
	stopSequence: number;
	stop: string | null;
	status: string;
	updatedAt: number;
}

const API = 'https://api-v3.mbta.com/vehicles';

export async function fetchVehicles(
	routes: string[],
	fetcher: typeof fetch = fetch,
): Promise<Vehicle[]> {
	const url = `${API}?filter%5Broute%5D=${encodeURIComponent(routes.join(','))}&fields%5Bvehicle%5D=latitude,longitude,bearing,current_status,current_stop_sequence,updated_at&include=stop`;
	const res = await fetcher(url, { headers: { accept: 'application/vnd.api+json' } });
	if (!res.ok) throw new Error(`MBTA ${res.status}`);
	const body = (await res.json()) as {
		data: Array<{
			id: string;
			attributes: Record<string, unknown>;
			relationships: { route?: { data?: { id: string } }; stop?: { data?: { id: string } | null } };
		}>;
	};
	return body.data.map((v) => ({
		id: v.id,
		route: v.relationships.route?.data?.id ?? '',
		lat: Number(v.attributes.latitude),
		lng: Number(v.attributes.longitude),
		bearing: Number(v.attributes.bearing ?? 0),
		stopSequence: Number(v.attributes.current_stop_sequence ?? 0),
		stop: v.relationships.stop?.data?.id ?? null,
		status: String(v.attributes.current_status ?? ''),
		updatedAt: Date.parse(String(v.attributes.updated_at)),
	}));
}

/**
 * Track buses between polls; when one arrives at a new stop, record the hop. Returns the hops
 * observed this poll as `[fromStop, toStop, route, seconds]`.
 */
export class HopTracker {
	private last = new Map<string, { stop: string; route: string; leftAt: number }>();

	/**
	 * A hop is timed from the last poll that still saw the bus at stop A (so dwell at A is not
	 * counted) to the first poll that sees it at the next stop B. Polling granularity still adds
	 * up to one interval, so short hops read a little slow.
	 */
	observe(
		vehicles: Vehicle[],
	): Array<{ from: string; to: string; route: string; seconds: number }> {
		const hops: Array<{ from: string; to: string; route: string; seconds: number }> = [];
		for (const v of vehicles) {
			if (!v.stop || v.status !== 'STOPPED_AT') continue;
			const prev = this.last.get(v.id);
			if (prev && prev.stop === v.stop) {
				prev.leftAt = v.updatedAt; // still dwelling at A
				continue;
			}
			if (prev && prev.route === v.route) {
				const seconds = Math.round((v.updatedAt - prev.leftAt) / 1000);
				if (seconds > 5 && seconds < 1800)
					hops.push({ from: prev.stop, to: v.stop, route: v.route, seconds });
			}
			this.last.set(v.id, { stop: v.stop, route: v.route, leftAt: v.updatedAt });
		}
		return hops;
	}
}

/**
 * Write observed hops onto the graph: the link's live version is closed and a new one opened
 * carrying `observedSec` (and weighing that many seconds), so routing over buses sees reality.
 */
export async function recordHops(
	g: Graph<Schema>,
	hops: Array<{ from: string; to: string; route: string; seconds: number }>,
	stopIds: Map<string, string>,
): Promise<number> {
	let written = 0;
	for (const h of hops) {
		const src = stopIds.get(h.from);
		const dst = stopIds.get(h.to);
		if (!src || !dst) continue;
		const { edges } = await g.listEdges({ rel: 'transitLink', src, dst, limit: 10 });
		const link = edges.find((e) => e.data.route === h.route) ?? edges[0];
		if (!link) continue;
		await g.deleteEdge(link.id);
		await g.addEdge({
			rel: 'transitLink',
			src,
			dst,
			weight: h.seconds,
			data: {
				route: String(link.data.route),
				scheduledSec: Number(link.data.scheduledSec),
				observedSec: h.seconds,
			},
		});
		written++;
	}
	return written;
}
