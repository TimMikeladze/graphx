import { availableParallelism } from 'node:os';
import type { ModelInputs } from '../prepare.ts';
import type { SignalPlan } from '../prepare/places.ts';
import { type Assignment, type Net, assign, makeNet, shortestTree, type Tree } from './assign.ts';
import {
	DRIVE_SHARE,
	iterationsFor,
	type OD,
	WINDOWS,
	type Window,
	windowDemand,
} from './demand.ts';
import type { WorkerResult } from './worker.ts';

/**
 * The city as the traffic model sees it: node and link indices over the prepared network, with
 * the edits a scenario makes applied. Shared by the baseline load and every scenario replay.
 */

/** What a scenario can change. Keys are prepared keys (`osm:…` intersections and segments). */
export interface Edits {
	/** Intersection → its new signal plan. */
	signals?: Record<string, { cycleSec: number; green: Record<string, number> }>;
	/** Segments closed to traffic. */
	closed?: string[];
	/** Segment → lanes in this direction (a road diet, or a widening). */
	lanes?: Record<string, number>;
	/** Zone → extra jobs there (a new office). Spread over home zones like the zone's existing workers. */
	jobs?: Record<string, number>;
}

export interface CityModel {
	net: Net;
	nodeKeys: string[];
	nodeIndex: Map<string, number>;
	linkKeys: string[];
	ods: OD[];
	/** Each zone-to-zone flow (home zone, work zone, workers) and the OD rows it was split into. */
	flowOf: Array<{ home: string; work: string; workers: number; drivers: number; ods: number[] }>;
	signals: Record<string, SignalPlan>;
}

export function buildModel(p: ModelInputs, edits: Edits = {}): CityModel {
	const nodeKeys = p.network.intersections.map((i) => i.key);
	const nodeIndex = new Map(nodeKeys.map((k, i) => [k, i]));
	const signals: Record<string, SignalPlan> = { ...p.signals };
	for (const [k, plan] of Object.entries(edits.signals ?? {})) {
		const base = signals[k];
		signals[k] = { cityId: base?.cityId ?? 0, name: base?.name ?? k, synthetic: true, ...plan };
	}
	const closed = new Set(edits.closed ?? []);
	const links = p.network.segments.map((s) => {
		const plan = signals[s.to];
		const lanes = edits.lanes?.[s.key];
		const capacity = lanes !== undefined ? (s.capacity / s.lanes) * Math.max(lanes, 0) : s.capacity;
		return {
			from: nodeIndex.get(s.from)!,
			to: nodeIndex.get(s.to)!,
			t0: s.freeFlowSec,
			cap: capacity,
			signal: plan
				? { cycleSec: plan.cycleSec, greenSec: plan.green[s.street] ?? plan.cycleSec / 2 }
				: null,
			closed: closed.has(s.key) || lanes === 0,
		};
	});
	const net = makeNet(nodeKeys.length, links);

	const connectors = new Map(
		p.zones.map((z) => [z.key, z.connectors.map((c) => nodeIndex.get(c)!)]),
	);
	const kind = new Map(p.zones.map((z) => [z.key, z.kind]));
	const flows = [...p.flows];
	// New jobs: copy the zone's existing home distribution, scaled to the added count.
	for (const [zone, extra] of Object.entries(edits.jobs ?? {})) {
		const into = flows.filter((f) => f.work === zone);
		const total = into.reduce((s, f) => s + f.workers, 0);
		if (total === 0) continue;
		for (const f of into)
			flows.push({ home: f.home, work: zone, workers: (f.workers * extra) / total });
	}
	const ods: OD[] = [];
	const flowOf: CityModel['flowOf'] = [];
	for (const [i, f] of flows.entries()) {
		const os = connectors.get(f.home);
		const ds = connectors.get(f.work);
		if (!os?.length || !ds?.length) continue;
		const share = kind.get(f.home) === 'boston' ? DRIVE_SHARE.resident : DRIVE_SHARE.inbound;
		const drivers = f.workers * share;
		// Split the flow across connector pairs; pair i-th with i-th (offset by the flow index so
		// every connector of a zone gets used) rather than all k² combinations.
		const k = Math.max(os.length, ds.length);
		const parts: number[] = [];
		for (let j = 0; j < k; j++) {
			const o = os[(i + j) % os.length]!;
			const d = ds[j % ds.length]!;
			if (o === d) continue;
			parts.push(ods.length);
			ods.push({ o, d, drivers: drivers / k });
		}
		if (parts.length === 0) continue;
		flowOf.push({ ...f, drivers, ods: parts });
	}
	return {
		net,
		nodeKeys,
		nodeIndex,
		linkKeys: p.network.segments.map((s) => s.key),
		ods,
		flowOf,
		signals,
	};
}

export interface WindowResult {
	window: Window;
	assignment: Assignment;
}

/** Assign every window of the day in this thread — what tests and tiny fixtures use. */
export function modelDaySync(model: CityModel, windows: Window[] = WINDOWS): WindowResult[] {
	return windows.map((w) => ({
		window: w,
		assignment: assign(model.net, windowDemand(model.ods, w), { iterations: iterationsFor(w) }),
	}));
}

/**
 * Assign every window of the day across worker threads. Each window is solved from scratch, so
 * the baseline and a scenario run exactly the same procedure and differ only by the edits.
 */
export async function modelDay(
	preparedDir: string,
	edits: Edits,
	onWindow?: (done: number, total: number) => void,
): Promise<WindowResult[]> {
	const n = Math.max(1, Math.min(WINDOWS.length, availableParallelism() - 2, 12));
	// Peak windows take longest; hand them out first so no worker is left with one at the end.
	const queue = WINDOWS.map((_, i) => i).sort(
		(a, b) => iterationsFor(WINDOWS[b]!) - iterationsFor(WINDOWS[a]!),
	);
	const results: WindowResult[] = Array.from({ length: WINDOWS.length });
	let done = 0;
	const workers = Array.from(
		{ length: n },
		() => new Worker(new URL('./worker.ts', import.meta.url)),
	);
	try {
		await Promise.all(
			workers.map(
				(worker) =>
					new Promise<void>((resolve, reject) => {
						worker.onerror = (e) => reject(e.error ?? new Error(e.message));
						const next = () => {
							const index = queue.shift();
							if (index === undefined) return resolve();
							worker.postMessage({ kind: 'window', index });
						};
						worker.onmessage = (e: MessageEvent<WorkerResult | { ready: true }>) => {
							if ('ready' in e.data) return next();
							const r = e.data;
							results[r.index] = {
								window: WINDOWS[r.index]!,
								assignment: { volume: r.volume, seconds: r.seconds, gap: r.gap },
							};
							onWindow?.(++done, WINDOWS.length);
							next();
						};
						worker.postMessage({ kind: 'init', prepared: preparedDir, edits });
					}),
			),
		);
	} finally {
		for (const w of workers) w.terminate();
	}
	return results;
}

export interface CommuteRoute {
	flow: number;
	/** Seconds door-connector to door-connector at the given link costs. */
	seconds: number;
	/** Node indices along the route. */
	nodes: number[];
}

/**
 * Each OD's route and time at the given link costs (one shortest-path tree per origin).
 * `reverse` routes the trip home: destination → origin.
 */
export function commuteRoutes(
	model: CityModel,
	seconds: Float64Array,
	which: number[],
	reverse = false,
): CommuteRoute[] {
	const ends = (i: number) =>
		reverse ? { o: model.ods[i]!.d, d: model.ods[i]!.o } : model.ods[i]!;
	const byOrigin = new Map<number, number[]>();
	for (const i of which) {
		const o = ends(i).o;
		const list = byOrigin.get(o);
		if (list) list.push(i);
		else byOrigin.set(o, [i]);
	}
	const out: CommuteRoute[] = [];
	let tree: Tree | undefined;
	for (const [o, list] of byOrigin) {
		tree = shortestTree(model.net, seconds, o, tree);
		for (const i of list) {
			const d = ends(i).d;
			const nodes: number[] = [d];
			let cur = d;
			while (cur !== o) {
				const link = tree.pred[cur]!;
				if (link < 0) break;
				cur = model.net.from[link]!;
				nodes.push(cur);
			}
			out.push({ flow: i, seconds: tree.dist[d]!, nodes: nodes.reverse() });
		}
	}
	return out;
}
