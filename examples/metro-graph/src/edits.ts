import type { Graph } from 'graphx';
import { z } from 'zod';
import { DAYS, type Day, type Schema, type TripData } from '../schema.ts';
import { haversine } from './geo.ts';
import { allEdges, duration, type View } from './view.ts';

const day = z.enum(DAYS);
const secs = z
	.number()
	.int()
	.min(0)
	.max(30 * 3600);

/** One change to a scenario branch. Applied as graph writes the moment it is posted. */
export const Edit = z.discriminatedUnion('op', [
	z.object({
		op: z.literal('headway'),
		route: z.string(), // route gtfsId
		direction: z.number().int(),
		day,
		from: secs,
		to: secs,
		minutes: z.number().min(1).max(240),
	}),
	z.object({
		op: z.literal('shift'),
		route: z.string(),
		direction: z.number().int().optional(),
		day,
		minutes: z.number().min(-180).max(180),
	}),
	z.object({ op: z.literal('removeRoute'), route: z.string() }),
	z.object({
		op: z.literal('addRoute'),
		short: z.string().min(1),
		long: z.string().default(''),
		color: z.string().default('#e4572e'),
		stops: z.array(z.string()).min(2), // stop gtfsIds in order
		spans: z
			.array(z.object({ day, from: secs, to: secs, minutes: z.number().min(1).max(240) }))
			.min(1),
	}),
]);
export type Edit = z.infer<typeof Edit>;

/** Average bus speed and dwell for a hop no existing route runs. */
const NEW_HOP_MPS = 18 / 3.6;
const DWELL_SEC = 20;

/** Evenly spaced departures in `[from, to)`. */
export const departures = (from: number, to: number, minutes: number) => {
	const out: number[] = [];
	for (let t = from; t < to; t += Math.round(minutes * 60)) out.push(t);
	return out;
};

/** Running times for a trip leaving at `start`: copied from the nearest trip on that pattern. */
export function timesFor(start: number, existing: TripData[], fallback: number[]): number[] {
	let best: TripData | undefined;
	for (const t of existing)
		if (!best || Math.abs(t.start - start) < Math.abs(best.start - start)) best = t;
	return best ? [...best.times] : [...fallback];
}

/** Drop `day` from a trip; delete it when it runs on no other day. */
async function dropDay(g: Graph<Schema>, trip: { id: string; data: TripData }, d: Day) {
	const days = trip.data.days.filter((x) => x !== d);
	if (days.length) return g.updateNode(trip.id, { data: { days } });
	for (const e of await allEdges(g, { rel: 'runs', src: trip.id })) await g.deleteEdge(e.id);
	await g.deleteNode(trip.id);
}

async function addTrip(g: Graph<Schema>, patternId: string, data: TripData) {
	const n = await g.addNode({ type: 'trip', data });
	await g.addEdge({ rel: 'runs', src: n.id, dst: patternId });
}

/** Apply one edit to `g`. `v` is the branch's view before the edit. Returns a one-line result. */
export async function applyEdit(g: Graph<Schema>, v: View, e: Edit): Promise<string> {
	if (e.op === 'headway') {
		const trips = (v.tripsOf.get(e.route) ?? []).filter(
			(t) => t.data.direction === e.direction && t.data.days.includes(e.day),
		);
		if (!v.route.has(e.route)) throw new Error(`no route ${e.route}`);
		// New trips run the pattern most of this direction's trips on this day use.
		const use = new Map<string, number>();
		for (const t of trips) use.set(t.data.pattern, (use.get(t.data.pattern) ?? 0) + 1);
		const key =
			[...use.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
			v.patterns.find((p) => p.data.route === e.route && p.data.direction === e.direction)?.data
				.key;
		const pattern = key ? v.pattern.get(key) : undefined;
		if (!pattern) throw new Error(`route ${e.route} has no pattern in direction ${e.direction}`);
		const same = trips.filter((t) => t.data.pattern === key).map((t) => t.data);
		const cut = trips.filter((t) => t.data.start >= e.from && t.data.start < e.to);
		for (const t of cut) await dropDay(g, t, e.day);
		const starts = departures(e.from, e.to, e.minutes);
		for (const [i, start] of starts.entries())
			await addTrip(g, pattern.id, {
				gtfsId: `scn:${e.route}:${e.direction}:${e.day}:${start}:${i}`,
				route: e.route,
				pattern: pattern.data.key,
				direction: e.direction,
				headsign: pattern.data.headsign,
				days: [e.day],
				start,
				times: timesFor(start, same, pattern.data.offsets),
				block: '',
			});
		return `${e.route}: ${cut.length} trips replaced by ${starts.length} every ${e.minutes} min`;
	}

	if (e.op === 'shift') {
		const trips = (v.tripsOf.get(e.route) ?? []).filter(
			(t) =>
				t.data.days.includes(e.day) &&
				(e.direction === undefined || t.data.direction === e.direction),
		);
		const by = Math.round(e.minutes * 60);
		for (const t of trips) {
			if (t.data.days.length === 1) {
				await g.updateNode(t.id, { data: { start: Math.max(0, t.data.start + by) } });
				continue;
			}
			// Runs on other days too: keep it there, add a shifted copy for this day.
			await dropDay(g, t, e.day);
			await addTrip(g, v.pattern.get(t.data.pattern)!.id, {
				...t.data,
				gtfsId: `${t.data.gtfsId}:${e.day}`,
				days: [e.day],
				start: Math.max(0, t.data.start + by),
			});
		}
		return `${e.route}: ${trips.length} trips moved ${e.minutes} min`;
	}

	if (e.op === 'removeRoute') {
		const route = v.route.get(e.route);
		if (!route) throw new Error(`no route ${e.route}`);
		const trips = v.tripsOf.get(e.route) ?? [];
		for (const t of trips) {
			for (const x of await allEdges(g, { rel: 'runs', src: t.id })) await g.deleteEdge(x.id);
			await g.deleteNode(t.id);
		}
		for (const p of v.patterns.filter((p) => p.data.route === e.route)) {
			for (const x of await allEdges(g, { rel: 'calls', src: p.id })) await g.deleteEdge(x.id);
			await g.deleteNode(p.id);
		}
		for (const rel of ['has', 'serves'])
			for (const x of await allEdges(g, { rel, src: route.id })) await g.deleteEdge(x.id);
		for (const x of await allEdges(g, { rel: 'hop' }))
			if (x.data.route === e.route) await g.deleteEdge(x.id);
		await g.deleteNode(route.id);
		return `${e.route}: removed with ${trips.length} trips`;
	}

	// addRoute
	const stops = e.stops.map((s) => {
		const hit = v.stop.get(s);
		if (!hit) throw new Error(`no stop ${s}`);
		return hit;
	});
	const gtfsId = `scn:${e.short}`;
	if (v.route.has(gtfsId)) throw new Error(`route ${e.short} already exists in this scenario`);
	// Hop times: the fastest existing route between the two stops, else distance at bus speed.
	const known = new Map<string, number>();
	for (const h of await allEdges(g, { rel: 'hop' })) {
		const k = `${h.src}|${h.dst}`;
		known.set(k, Math.min(known.get(k) ?? Infinity, h.weight));
	}
	const offsets = [0];
	const coords: [number, number][] = stops.map((s) => [s.data.lng, s.data.lat]);
	let lengthM = 0;
	for (let i = 1; i < stops.length; i++) {
		const m = haversine(coords[i - 1]!, coords[i]!);
		lengthM += m;
		const hop =
			known.get(`${stops[i - 1]!.id}|${stops[i]!.id}`) ?? Math.round(m / NEW_HOP_MPS) + DWELL_SEC;
		offsets.push(offsets[i - 1]! + hop);
	}
	const route = await g.addNode({
		type: 'route',
		data: {
			gtfsId,
			short: e.short,
			long: e.long,
			desc: e.long,
			agency: 'Scenario',
			mode: 'bus',
			color: e.color,
			textColor: '#ffffff',
			url: '',
		},
	});
	const key = `${gtfsId}:0:1`;
	const pattern = await g.addNode({
		type: 'pattern',
		data: {
			key,
			route: gtfsId,
			direction: 0,
			headsign: stops[stops.length - 1]!.data.name,
			stops: e.stops,
			offsets,
			lengthM: Math.round(lengthM),
			coords,
		},
	});
	await g.addEdge({ rel: 'has', src: route.id, dst: pattern.id });
	for (const [seq, s] of stops.entries()) {
		await g.addEdge({ rel: 'calls', src: pattern.id, dst: s.id, data: { seq } });
		await g.addEdge({ rel: 'serves', src: route.id, dst: s.id });
	}
	for (let i = 1; i < stops.length; i++)
		await g.addEdge({
			rel: 'hop',
			src: stops[i - 1]!.id,
			dst: stops[i]!.id,
			weight: offsets[i]! - offsets[i - 1]!,
			data: { route: gtfsId, trips: 0 },
		});
	let n = 0;
	for (const span of e.spans)
		for (const start of departures(span.from, span.to, span.minutes))
			await addTrip(g, pattern.id, {
				gtfsId: `${gtfsId}:${span.day}:${start}:${n++}`,
				route: gtfsId,
				pattern: key,
				direction: 0,
				headsign: stops[stops.length - 1]!.data.name,
				days: [span.day],
				start,
				times: offsets,
				block: '',
			});
	return `${e.short}: new route, ${stops.length} stops, ${n} trips, ${Math.round(duration({ times: offsets } as TripData) / 60)} min end to end`;
}
