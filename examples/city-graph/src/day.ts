import { type BulkEdgeRow, bulkEdges, bulkLoad, FOREVER, type Graph } from 'graphx';
import { embedder, type Schema, schema } from '../schema.ts';
import type { Prepared } from './prepare.ts';
import {
	buildModel,
	type CityModel,
	commuteRoutes,
	type Edits,
	modelDay,
	modelDaySync,
	type WindowResult,
} from './model/city.ts';
import { WINDOWS, type Window } from './model/demand.ts';
import { boston } from './time.ts';

/**
 * City time. The modelled weekday is Tuesday 29 September 2026; everything that exists before it
 * (streets, zones, stops) is valid from {@link EPOCH}, and crashes and 311 cases from when they
 * happened. A scenario forks the city at {@link BEFORE_DAY} and replays the day with its edits.
 */
export const EPOCH = boston(2015, 1, 1);
export const DAY = boston(2026, 9, 29);
export const BEFORE_DAY = DAY - 1;
export const windowStart = (w: Window) => DAY + w.start * 60_000;

/** The windows the commute times are read at. */
export const AM_PEAK = WINDOWS.findIndex((w) => w.start === 8 * 60);
export const PM_PEAK = WINDOWS.findIndex((w) => w.start === 17 * 60 + 15);

/** Commutes with fewer daily drivers than this stay in the traffic but get no node of their own. */
export const MIN_COMMUTE_DRIVERS = 2;

/** A road gets a new version only when its time moves by 3% or its volume by 10% (min 25 veh/h). */
function changed(prev: { sec: number; vol: number }, sec: number, vol: number): boolean {
	if (!Number.isFinite(sec) !== !Number.isFinite(prev.sec)) return true;
	return (
		Math.abs(sec - prev.sec) > 0.03 * prev.sec ||
		Math.abs(vol - prev.vol) > Math.max(25, 0.1 * prev.vol)
	);
}

export interface DayIds {
	/** Prepared intersection key → node id. */
	intersection: Map<string, string>;
	/** Prepared segment key → road edge id (the same identity in the baseline and every branch). */
	road: Map<string, string>;
	/** Zone key → node id. */
	zone: Map<string, string>;
}

export interface DayStats {
	windows: number;
	roadVersions: number;
	commutes: number;
	passes: number;
	/** Vehicle-hours driven over the day. */
	vehicleHours: number;
	ms: number;
}

/** Road edge versions for the day: one row per segment per window where it changed. */
export function roadRows(
	p: Prepared,
	ids: DayIds,
	results: WindowResult[],
	model: CityModel,
): BulkEdgeRow<Schema>[] {
	const rows: BulkEdgeRow<Schema>[] = [];
	p.network.segments.forEach((s, i) => {
		const id = ids.road.get(s.key);
		if (!id || model.net.closed[i]) return; // a closed road has no version that day
		const base = {
			id,
			rel: 'road' as const,
			src: ids.intersection.get(s.from)!,
			dst: ids.intersection.get(s.to)!,
		};
		let open: BulkEdgeRow<Schema> | null = null;
		let prev = { sec: Number.NaN, vol: Number.NaN };
		for (const r of results) {
			const sec = r.assignment.seconds[i]!;
			const vol = r.assignment.volume[i]!;
			if (open && !changed(prev, sec, vol)) continue;
			const from = windowStart(r.window);
			if (open) open.validTo = from;
			open = {
				...base,
				weight: Math.round(sec * 10) / 10,
				data: {
					key: s.key,
					street: s.street,
					highway: s.highway,
					lengthM: s.lengthM,
					lanes: model.net.cap[i]! > 0 ? Math.round((model.net.cap[i]! / s.capacity) * s.lanes) : 0,
					freeFlowSec: s.freeFlowSec,
					capacity: Math.round(model.net.cap[i]!),
					volume: Math.round(vol),
				},
				validFrom: from,
				validTo: FOREVER,
			};
			rows.push(open);
			prev = { sec, vol };
		}
	});
	return rows;
}

/**
 * Model the day for this graph's city (baseline or a branch with `edits`) and write it: road
 * versions per window, one commute node per zone pair with its peak driving times, and the
 * signalised intersections each commute passes through.
 */
export async function writeDay(
	g: Graph<Schema>,
	p: Prepared,
	ids: DayIds,
	opts: {
		edits?: Edits;
		/** Model in worker threads that read the prepared city from here; omit to model inline. */
		preparedDir?: string;
		onProgress?: (done: number, total: number, label: string) => void;
	} = {},
): Promise<DayStats> {
	const t0 = performance.now();
	const edits = opts.edits ?? {};
	const model = buildModel(p, edits);
	const total = WINDOWS.length + 1;
	const results = opts.preparedDir
		? await modelDay(opts.preparedDir, edits, (done) => opts.onProgress?.(done, total, 'modelling'))
		: modelDaySync(model);

	const rows = roadRows(p, ids, results, model);
	await bulkEdges(g.raw, schema, rows, { chunkSize: 200 });

	// Commutes: the zone pairs with enough drivers to be worth a node, timed at both peaks.
	const am = results[AM_PEAK]!.assignment.seconds;
	const pm = results[PM_PEAK]!.assignment.seconds;
	const flows = model.flowOf.filter((f) => f.drivers >= MIN_COMMUTE_DRIVERS);
	const amRoutes = commuteRoutes(
		model,
		am,
		flows.map((f) => f.ods[0]!),
	);
	const amByOd = new Map(amRoutes.map((r) => [r.flow, r]));
	const pmByOd = new Map(
		commuteRoutes(
			model,
			pm,
			flows.map((f) => f.ods[0]!),
			true,
		).map((r) => [r.flow, r.seconds]),
	);
	const commuteIds = (
		await bulkLoad(
			g.raw,
			schema,
			flows.map((f) => ({
				type: 'commute' as const,
				data: {
					home: f.home,
					work: f.work,
					workers: f.workers,
					drivers: Math.round(f.drivers * 10) / 10,
					amMinutes: round1(amByOd.get(f.ods[0]!)!.seconds / 60),
					pmMinutes: round1(pmByOd.get(f.ods[0]!)! / 60),
				},
				validFrom: DAY,
				embedding: false as const,
			})),
			{ chunkSize: 200 },
		)
	).ids;

	const signalled = new Set(Object.keys(model.signals).map((k) => model.nodeIndex.get(k)));
	const edges: BulkEdgeRow<Schema>[] = [];
	flows.forEach((f, i) => {
		const id = commuteIds[i]!;
		edges.push({ rel: 'home', src: id, dst: ids.zone.get(f.home)!, validFrom: DAY });
		edges.push({ rel: 'work', src: id, dst: ids.zone.get(f.work)!, validFrom: DAY });
		let order = 0;
		for (const n of amByOd.get(f.ods[0]!)!.nodes) {
			if (!signalled.has(n)) continue;
			edges.push({
				rel: 'passes',
				src: id,
				dst: ids.intersection.get(model.nodeKeys[n]!)!,
				data: { order: order++ },
				validFrom: DAY,
			});
		}
	});
	await bulkEdges(g.raw, schema, edges, { chunkSize: 200 });
	opts.onProgress?.(total, total, 'written');

	let vehicleHours = 0;
	for (const r of results) {
		const hours = r.window.minutes / 60;
		for (let i = 0; i < model.net.m; i++) {
			const s = r.assignment.seconds[i]!;
			if (Number.isFinite(s)) vehicleHours += (r.assignment.volume[i]! * hours * s) / 3600;
		}
	}
	return {
		windows: results.length,
		roadVersions: rows.length,
		commutes: flows.length,
		passes: edges.length - 2 * flows.length,
		vehicleHours: Math.round(vehicleHours),
		ms: Math.round(performance.now() - t0),
	};
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Read the id maps back out of the baseline city (as of the modelled day). A branch forked from
 * it keeps every id, so the same maps address the branch.
 */
export async function readIds(g: Graph<Schema>): Promise<DayIds> {
	const intersection = new Map<string, string>();
	const zone = new Map<string, string>();
	for (const [type, map] of [
		['intersection', intersection],
		['zone', zone],
	] as const) {
		let cursor: string | undefined;
		do {
			const page = await g.listNodes({ type, limit: 5000, cursor, asOf: DAY });
			for (const n of page.nodes) map.set((n.data as { key: string }).key, n.id);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
	}
	const road = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const page = await g.listEdges({ rel: 'road', asOf: DAY, limit: 5000, cursor });
		for (const e of page.edges) road.set((e.data as { key: string }).key, e.id);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return { intersection, zone, road };
}

export { embedder };
