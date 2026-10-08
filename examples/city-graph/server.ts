/**
 * city-graph server — Bun + libSQL. Mounts graphx's generated HTTP surface (typed routes,
 * `/openapi.json`, `/docs`, the React hooks' endpoints) for the baseline city and for every
 * scenario branch, plus a thin `/city` router for the payloads a map wants in one request.
 *
 *   bun server.ts            # after `bun run download && bun run prepare-data && bun run load`
 *
 * Picks the first free port from $PORT (default 8899) upward; never stops what holds a port.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, diff, type Graph, getDb, history, type TopNode, topNodes } from 'graphx';
import { askGraph } from 'graphx/jev';
import { HTTPException } from 'hono/http-exception';
import { embedder, type Schema, schema } from './schema.ts';
import { SCORES } from './src/analyze.ts';
import { AM_PEAK, DAY, type DayIds, PM_PEAK, readIds, windowStart } from './src/day.ts';
import { fetchVehicles, HopTracker, recordHops, type Vehicle } from './src/live.ts';
import { DATA } from './src/load.ts';
import type { Edits } from './src/model/city.ts';
import { WINDOWS } from './src/model/demand.ts';
import { readPrepared } from './src/prepare.ts';
import { type Hosting, startScenario } from './src/scenario.ts';

export interface CityServerOptions {
	namespace?: string;
	preparedDir?: string;
	cityDir?: string;
	/** Poll the MBTA for live buses (off in tests). */
	live?: boolean;
}

type Geometry = {
	segments: Array<{
		id: string;
		key: string;
		from: string;
		to: string;
		street: string;
		highway: string;
		freeFlowSec: number;
		coords: [number, number][];
	}>;
	zones: Array<{ id: string; key: string; name: string; neighborhood: string; outline: unknown }>;
};

export async function createCityServer(opts: CityServerOptions = {}) {
	const namespace = opts.namespace ?? 'city';
	const preparedDir = opts.preparedDir ?? join(DATA, 'prepared');
	const cityDir = opts.cityDir ?? join(DATA, 'city');
	if (!existsSync(join(cityDir, 'geometry.json'))) {
		throw new Error(
			`no city at ${cityDir} — run \`bun run download && bun run prepare-data && bun run load\` first`,
		);
	}

	const { app, control, tenant, project, user, graph } = await createApp({
		schema,
		embedder,
		db: namespace,
		cors: true,
		limits: { maxRows: 20_000 },
		openapi: { title: 'city-graph — Boston as a bitemporal graph' },
	});
	const baseline = graph;
	const prepared = await readPrepared(preparedDir);
	const geometry = (await Bun.file(join(cityDir, 'geometry.json')).json()) as Geometry;
	const baselineStats = (await Bun.file(join(cityDir, 'baseline.json')).json()) as {
		vehicleHours: number;
	};
	const ids: DayIds = await readIds(baseline);
	const segIndex = new Map(geometry.segments.map((s, i) => [s.id, i]));
	const hosting: Hosting = { control, tenant, baseline, prepared, preparedDir, ids };

	// --- which graph a request reads: the baseline, or a scenario branch by its project id ---
	const branches = new Map<string, Graph<Schema>>();
	const { Graph: GraphCtor } = await import('graphx');
	async function graphFor(projectId: string | undefined): Promise<Graph<Schema>> {
		if (!projectId || projectId === project) return baseline;
		const hit = branches.get(projectId);
		if (hit) return hit;
		const scenarios = await listScenarios();
		const s = scenarios.find((x) => x.data.project === projectId);
		if (!s) throw new HTTPException(404, { message: `unknown scenario project ${projectId}` });
		const g = new GraphCtor(getDb(s.data.namespace), schema, { embedder }) as Graph<Schema>;
		branches.set(projectId, g);
		return g;
	}

	async function listScenarios() {
		const r = await baseline.listNodes({ type: 'scenario', limit: 500 });
		return r.nodes.filter(
			(n): n is Extract<typeof n, { type: 'scenario' }> => n.type === 'scenario',
		);
	}

	async function allEdges(g: Graph<Schema>, rel: string, asOf?: number) {
		const out: Awaited<ReturnType<Graph<Schema>['listEdges']>>['edges'] = [];
		let cursor: string | undefined;
		do {
			const page = await g.listEdges({ rel, asOf, limit: 20_000, cursor });
			out.push(...page.edges);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return out;
	}

	async function allNodes<T extends keyof Schema['nodes']>(
		g: Graph<Schema>,
		type: T,
		asOf?: number,
	) {
		const out: Array<{ id: string; data: Schema['nodes'][T]['_output'] }> = [];
		let cursor: string | undefined;
		do {
			const page = await g.listNodes({ type, asOf, limit: 20_000, cursor });
			for (const n of page.nodes) out.push({ id: n.id, data: n.data as never });
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return out;
	}

	// Road state at an instant: seconds and volume per segment, in geometry order.
	const weightCache = new Map<string, { seconds: (number | null)[]; volume: (number | null)[] }>();
	async function weightsAt(projectId: string | undefined, t: number) {
		const key = `${projectId ?? project}|${t}`;
		const hit = weightCache.get(key);
		if (hit) return hit;
		const g = await graphFor(projectId);
		const seconds: (number | null)[] = Array.from({ length: geometry.segments.length }, () => null);
		const volume: (number | null)[] = Array.from({ length: geometry.segments.length }, () => null);
		for (const e of await allEdges(g, 'road', t)) {
			const i = segIndex.get(e.id);
			if (i === undefined) continue;
			seconds[i] = e.weight;
			volume[i] = Number(e.data.volume ?? 0);
		}
		const out = { seconds, volume };
		if (weightCache.size > 400) weightCache.delete(weightCache.keys().next().value!);
		weightCache.set(key, out);
		return out;
	}

	const zoneByKey = new Map(prepared.zones.map((z) => [z.key, z]));
	const commuteCache = new Map<string, Map<string, Schema['nodes']['commute']['_output']>>();
	async function commutesOf(projectId: string | undefined) {
		const key = projectId ?? project;
		const hit = commuteCache.get(key);
		if (hit) return hit;
		const g = await graphFor(projectId);
		const m = new Map<string, Schema['nodes']['commute']['_output']>();
		for (const c of await allNodes(g, 'commute', DAY))
			m.set(`${c.data.home}|${c.data.work}`, c.data);
		commuteCache.set(key, m);
		return m;
	}

	const rankCache = new Map<string, Map<string, { rank: number; score: number }>>();
	async function ranks(g: Graph<Schema>, metric: string) {
		const key = `${g.raw === baseline.raw ? project : 'b'}|${metric}`;
		const hit = rankCache.get(key);
		if (hit) return hit;
		const rows: TopNode[] = await topNodes(g.raw, {
			by: `score:${metric}`,
			type: 'intersection',
			limit: 20_000,
		});
		const m = new Map(rows.map((r, i) => [r.id, { rank: i + 1, score: r.score ?? 0 }]));
		rankCache.set(key, m);
		return m;
	}

	const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

	// ------------------------------------------------------------------------------------------
	app.get('/city/meta', async (c) =>
		c.json({
			tenant,
			project,
			user,
			day: DAY,
			windows: WINDOWS.map((w) => ({ ...w, t: windowStart(w) })),
			amPeak: windowStart(WINDOWS[AM_PEAK]!),
			pmPeak: windowStart(WINDOWS[PM_PEAK]!),
			baseline: baselineStats,
			scores: SCORES,
			counts: {
				intersections: prepared.network.intersections.length,
				segments: prepared.network.segments.length,
				signals: Object.keys(prepared.signals).length,
				zones: prepared.zones.filter((z) => z.kind === 'boston').length,
				commuters: prepared.flows.reduce((s, f) => s + f.workers, 0),
				crashes: prepared.crashes.length,
				reports: prepared.reports.length,
				busRoutes: prepared.transit.routes.length,
			},
		}),
	);

	app.get(
		'/city/network',
		() =>
			new Response(Bun.file(join(cityDir, 'geometry.json')), {
				headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
			}),
	);

	app.get('/city/weights', async (c) => {
		const t = num(c.req.query('t'), windowStart(WINDOWS[AM_PEAK]!));
		return c.json(await weightsAt(c.req.query('project'), t));
	});

	// The day at a glance: per window, vehicles on the network and how much slower than free flow
	// the average vehicle-second is. One `listEdges` per window, cached per project.
	const dayCache = new Map<string, unknown>();
	app.get('/city/day', async (c) => {
		const projectId = c.req.query('project') ?? project;
		const hit = dayCache.get(projectId);
		if (hit) return c.json(hit);
		const rows = [];
		for (const w of WINDOWS) {
			const t = windowStart(w);
			const { seconds, volume } = await weightsAt(projectId, t);
			let tt = 0;
			let t0 = 0;
			seconds.forEach((s, i) => {
				const v = volume[i] ?? null;
				if (s === null || v === null) return;
				tt += v * s;
				t0 += v * geometry.segments[i]!.freeFlowSec;
			});
			// Little's law: vehicles on the road at once = Σ flow × time on the link.
			rows.push({
				t,
				start: w.start,
				minutes: w.minutes,
				vehicles: Math.round(tt / 3600),
				slowdown: t0 > 0 ? Math.round((tt / t0) * 100) / 100 : 1,
			});
		}
		dayCache.set(projectId, rows);
		return c.json(rows);
	});

	// Intersections: node + signal + its history + approaches over the day + who drives through.
	app.get('/city/intersection/:id', async (c) => {
		const id = c.req.param('id');
		const projectId = c.req.query('project');
		const t = num(c.req.query('t'), windowStart(WINDOWS[AM_PEAK]!));
		const g = await graphFor(projectId);
		const node = await g.getNode(id, { asOf: t });
		if (!node || node.type !== 'intersection') return c.json({ error: 'not an intersection' }, 404);

		const versions = (await history(g.raw, id)).map((v) => ({
			validFrom: Number(v.valid_from),
			signal: (JSON.parse(String(v.data)) as { signal: unknown }).signal,
		}));

		// Delay at this intersection across the day, from the versions of the roads entering it.
		const byWindow = await Promise.all(
			WINDOWS.map(async (w) => {
				const { edges } = await g.listEdges({
					rel: 'road',
					dst: id,
					asOf: windowStart(w),
					limit: 50,
				});
				let vol = 0;
				let delay = 0;
				for (const e of edges) {
					const v = Number(e.data.volume ?? 0);
					vol += v;
					delay += v * Math.max(0, e.weight - Number(e.data.freeFlowSec ?? 0));
				}
				return {
					t: windowStart(w),
					start: w.start,
					volume: Math.round(vol),
					delaySec: vol > 0 ? Math.round((delay / vol) * 10) / 10 : 0,
				};
			}),
		);
		const approaches = (await g.listEdges({ rel: 'road', dst: id, asOf: t, limit: 50 })).edges.map(
			(e) => ({
				id: e.id,
				street: String(e.data.street),
				volume: Number(e.data.volume),
				seconds: e.weight,
				freeFlowSec: Number(e.data.freeFlowSec),
			}),
		);

		// Who drives through: the commutes whose morning route passes this light, by neighbourhood.
		const passing = await g.neighbors(id, {
			rels: ['passes'],
			direction: 'reverse',
			asOf: DAY,
			limits: { maxRows: 20_000 },
		});
		const byHood = new Map<string, { drivers: number; commutes: number }>();
		const byZone = new Map<string, number>();
		let drivers = 0;
		for (const n of passing) {
			if (n.type !== 'commute') continue;
			const home = zoneByKey.get(n.data.home);
			const hood = home?.neighborhood ?? 'Elsewhere';
			const agg = byHood.get(hood) ?? { drivers: 0, commutes: 0 };
			agg.drivers += n.data.drivers;
			agg.commutes++;
			byHood.set(hood, agg);
			byZone.set(n.data.home, (byZone.get(n.data.home) ?? 0) + n.data.drivers);
			drivers += n.data.drivers;
		}

		const crashes = (
			await g.neighbors(id, { rels: ['at'], direction: 'reverse', asOf: t })
		).flatMap((n) => (n.type === 'crash' ? [{ id: n.id, ...n.data }] : []));
		const reports = (
			await g.neighbors(id, { rels: ['near'], direction: 'reverse', asOf: t })
		).flatMap((n) => (n.type === 'report' ? [{ id: n.id, ...n.data }] : []));

		const rankOf = async (metric: string) => (await ranks(baseline, metric)).get(id) ?? null;
		return c.json({
			id,
			...node.data,
			versions,
			byWindow,
			approaches,
			passing: {
				drivers: Math.round(drivers),
				commutes: passing.length,
				neighborhoods: [...byHood]
					.map(([name, v]) => ({ name, drivers: Math.round(v.drivers), commutes: v.commutes }))
					.sort((a, b) => b.drivers - a.drivers),
				zones: [...byZone].map(([key, d]) => ({ key, drivers: Math.round(d * 10) / 10 })),
			},
			crashes: crashes.sort((a, b) => b.at - a.at),
			reports,
			ranks: {
				betweenness: await rankOf(SCORES.betweenness),
				volume: await rankOf(SCORES.volume),
				risk: await rankOf(SCORES.risk),
				pagerank: await rankOf(SCORES.pagerank),
			},
		});
	});

	// Zones: who lives and works here, where they go, how long it takes.
	app.get('/city/zone/:key', async (c) => {
		const key = c.req.param('key');
		const zone = zoneByKey.get(key);
		if (!zone) return c.json({ error: 'unknown zone' }, 404);
		const commutes = await commutesOf(c.req.query('project'));
		const out: Schema['nodes']['commute']['_output'][] = [];
		const into: Schema['nodes']['commute']['_output'][] = [];
		for (const cm of commutes.values()) {
			if (cm.home === key) out.push(cm);
			if (cm.work === key) into.push(cm);
		}
		const place = (k: string) => {
			const z = zoneByKey.get(k);
			return z
				? { key: k, name: z.name, neighborhood: z.neighborhood, lat: z.lat, lng: z.lng }
				: null;
		};
		const shape = (list: typeof out, end: 'home' | 'work') =>
			list
				.sort((a, b) => b.drivers - a.drivers)
				.slice(0, 60)
				.map((cm) => ({ ...cm, other: place(cm[end]) }));
		return c.json({
			...zone,
			outline: undefined,
			outbound: shape(out, 'work'),
			inbound: shape(into, 'home'),
		});
	});

	// Every crash, compact: [lat, lng, mode(0 mv,1 bike,2 ped), at]. Facts don't change, so cached.
	let crashCache: unknown = null;
	app.get('/city/crashes', (c) => {
		crashCache ??= prepared.crashes.map((x) => [
			x.lat,
			x.lng,
			x.mode === 'ped' ? 2 : x.mode === 'bike' ? 1 : 0,
			x.at,
		]);
		return c.json(crashCache);
	});

	// 311 cases open at an instant (a case is valid while it is open), with their locations.
	app.get('/city/reports', async (c) => {
		const t = num(c.req.query('t'), DAY);
		const rows = await allNodes(baseline, 'report', t);
		return c.json(rows.map((r) => ({ id: r.id, ...r.data })));
	});

	app.get('/city/transit', async () => {
		const stops = await allNodes(baseline, 'stop');
		const routes = await allNodes(baseline, 'route');
		const links = await allEdges(baseline, 'transitLink');
		return Response.json({
			routes: routes.map((r) => ({ id: r.id, ...r.data })),
			stops: stops.map((s) => ({ id: s.id, ...s.data })),
			links: links.map((l) => ({ id: l.id, src: l.src, dst: l.dst, seconds: l.weight, ...l.data })),
		});
	});

	// Scenarios -------------------------------------------------------------------------------
	app.get('/city/scenarios', async (c) =>
		c.json((await listScenarios()).map((s) => ({ id: s.id, ...s.data }))),
	);

	app.post('/city/scenarios', async (c) => {
		const body = (await c.req.json()) as { title?: string; edits?: Edits };
		if (!body.title || !body.edits) return c.json({ error: 'title and edits are required' }, 400);
		const run = await startScenario(hosting, { title: body.title, edits: body.edits });
		return c.json({ id: run.id, namespace: run.namespace }, 202);
	});

	// Compare a scenario with the baseline: Δ seconds per segment at `t`, Δ commute minutes per
	// home zone (who wins, who pays), and the totals.
	app.get('/city/compare', async (c) => {
		const projectId = c.req.query('project');
		if (!projectId) return c.json({ error: 'project is required' }, 400);
		const scenario = (await listScenarios()).find((s) => s.data.project === projectId);
		if (!scenario || scenario.data.status !== 'done')
			return c.json({ error: 'scenario not ready' }, 409);
		const t = num(c.req.query('t'), windowStart(WINDOWS[AM_PEAK]!));
		const [base, scen] = await Promise.all([weightsAt(undefined, t), weightsAt(projectId, t)]);
		const closed: number[] = [];
		const delta = base.seconds.map((b, i) => {
			const s = scen.seconds[i];
			if (s === null || s === undefined) {
				if (b !== null) closed.push(i); // the road has no version that day in the scenario
				return null;
			}
			return Math.round((s - (b ?? s)) * 10) / 10;
		});
		const [bc, sc] = await Promise.all([commutesOf(undefined), commutesOf(projectId)]);
		const zones = new Map<string, { drivers: number; base: number; scen: number }>();
		let minutesDelta = 0;
		for (const [k, b] of bc) {
			const s = sc.get(k);
			if (!s) continue;
			const d = (s.amMinutes - b.amMinutes + (s.pmMinutes - b.pmMinutes)) * b.drivers;
			minutesDelta += d;
			const z = zones.get(b.home) ?? { drivers: 0, base: 0, scen: 0 };
			z.drivers += b.drivers;
			z.base += (b.amMinutes + b.pmMinutes) * b.drivers;
			z.scen += (s.amMinutes + s.pmMinutes) * b.drivers;
			zones.set(b.home, z);
		}
		const zoneRows = [...zones]
			.map(([key, z]) => {
				const meta = zoneByKey.get(key);
				return {
					key,
					name: meta?.name ?? key,
					neighborhood: meta?.neighborhood ?? '',
					lat: meta?.lat ?? 0,
					lng: meta?.lng ?? 0,
					drivers: Math.round(z.drivers),
					// minutes per driver per day, both trips
					baseMinutes: Math.round((z.base / z.drivers) * 10) / 10,
					deltaMinutes: Math.round(((z.scen - z.base) / z.drivers) * 100) / 100,
				};
			})
			.filter((z) => z.drivers >= 25 && Math.abs(z.deltaMinutes) >= 0.05)
			.sort((a, b) => a.deltaMinutes - b.deltaMinutes);
		const branch = await graphFor(projectId);
		const changedSignals = (await diff(branch.raw, DAY - 1, Date.now())).nodes.filter(
			(n) => n.type === 'intersection' && Number(n.valid_from) > DAY,
		).length;
		return c.json({
			t,
			delta,
			closed,
			zones: zoneRows,
			totals: {
				vehicleHoursBase: baselineStats.vehicleHours,
				vehicleHoursScenario: Number(
					(scenario.data.summary as { vehicleHours?: number } | null)?.vehicleHours ?? 0,
				),
				commuteHoursDelta: Math.round(minutesDelta / 60),
				changedSignals,
			},
		});
	});

	// Ask in plain words: Jev plans the call (search, list or rank by one of our scores) when a
	// TypeSafe key is set; otherwise hybrid retrieval answers it directly.
	app.get('/city/ask', async (c) => {
		const q = (c.req.query('q') ?? '').trim();
		if (!q) return c.json({ plan: null, rows: [] });
		const metrics = {
			[SCORES.betweenness]:
				'How many shortest routes across the city run through an intersection at rush hour.',
			[SCORES.volume]:
				'Vehicles per hour entering an intersection at the morning peak — the busiest.',
			[SCORES.risk]:
				'Crash risk: weighted pedestrian, cyclist and vehicle crashes at an intersection — the most dangerous.',
			[SCORES.pagerank]: 'Where routes through the road network converge.',
		};
		const place = (n: { id: string; type: string; data: Record<string, unknown> }) => ({
			id: n.id,
			type: n.type,
			label: String(n.data.name ?? n.data.title ?? n.data.type ?? n.data.street ?? n.type),
			lat: (n.data.lat as number | undefined) ?? null,
			lng: (n.data.lng as number | undefined) ?? null,
			data: n.data,
		});
		if (process.env.TYPESAFE_API_KEY) {
			try {
				const { plan, rows } = await askGraph(baseline, q, { metrics, limit: 12 });
				if (rows) return c.json({ plan, rows: rows.map(place) });
			} catch (e) {
				console.warn('askGraph failed, falling back to hybrid search:', (e as Error).message);
			}
		}
		const hits = await baseline.hybridRetrieve({ query: q, k: 12, maxDepth: 0 });
		return c.json({
			plan: { op: 'search', type: null, metric: null, confidence: null },
			rows: hits.map((h) => place(h as never)),
		});
	});

	// What changed between two instants — `diff`, summarised by type and rel.
	app.get('/city/changes', async (c) => {
		const t1 = num(c.req.query('t1'), DAY);
		const t2 = num(c.req.query('t2'), DAY + 86_400_000);
		const g = await graphFor(c.req.query('project'));
		const d = await diff(g.raw, t1, t2);
		const count = (rows: Array<Record<string, unknown>>, key: string) => {
			const m: Record<string, { opened: number; closed: number }> = {};
			for (const r of rows) {
				const k = String(r[key]);
				m[k] ??= { opened: 0, closed: 0 };
				if (Number(r.valid_from) > t1 && Number(r.valid_from) <= t2) m[k].opened++;
				if (Number(r.valid_to) > t1 && Number(r.valid_to) <= t2) m[k].closed++;
			}
			return m;
		};
		const reports = d.nodes
			.filter((n) => n.type === 'report' && Number(n.valid_from) > t1 && Number(n.valid_from) <= t2)
			.slice(0, 200)
			.map((n) => ({ id: n.id, ...(JSON.parse(String(n.data)) as object) }));
		const crashes = d.nodes
			.filter((n) => n.type === 'crash' && Number(n.valid_from) > t1 && Number(n.valid_from) <= t2)
			.map((n) => ({ id: n.id, ...(JSON.parse(String(n.data)) as object) }));
		return c.json({
			t1,
			t2,
			nodes: count(d.nodes, 'type'),
			edges: count(d.edges, 'rel'),
			reports,
			crashes,
		});
	});

	// Live buses -------------------------------------------------------------------------------
	let vehicles: Vehicle[] = [];
	let liveError: string | null = null;
	let hopsWritten = 0;
	const listeners = new Set<(v: Vehicle[]) => void>();
	let timer: ReturnType<typeof setInterval> | null = null;
	if (opts.live !== false) {
		const routes = prepared.transit.routes.map((r) => r.gtfsId);
		const stopIds = new Map((await allNodes(baseline, 'stop')).map((s) => [s.data.gtfsId, s.id]));
		const tracker = new HopTracker();
		const poll = async () => {
			try {
				const all: Vehicle[] = [];
				// The API takes a comma list; keep URLs short.
				for (let i = 0; i < routes.length; i += 40)
					all.push(...(await fetchVehicles(routes.slice(i, i + 40))));
				vehicles = all;
				liveError = null;
				hopsWritten += await recordHops(baseline, tracker.observe(all), stopIds);
				for (const l of listeners) l(vehicles);
			} catch (e) {
				liveError = (e as Error).message;
			}
		};
		void poll();
		timer = setInterval(poll, 15_000);
	}
	app.get('/city/live', (c) => {
		if (c.req.header('accept')?.includes('text/event-stream')) {
			let send: ((v: Vehicle[]) => void) | null = null;
			const stream = new ReadableStream({
				start(ctrl) {
					const enc = new TextEncoder();
					send = (v) =>
						ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ vehicles: v, hopsWritten })}\n\n`));
					send(vehicles);
					listeners.add(send);
				},
				cancel() {
					if (send) listeners.delete(send);
				},
			});
			return new Response(stream, {
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
			});
		}
		return c.json({ vehicles, error: liveError, hopsWritten });
	});

	return {
		app,
		baseline,
		tenant,
		project,
		user,
		hosting,
		close: () => {
			if (timer) clearInterval(timer);
		},
	};
}

/** First port from `start` that nothing is listening on. */
export async function freePort(start: number): Promise<number> {
	for (let port = start; port < start + 100; port++) {
		try {
			const s = Bun.listen({ hostname: '0.0.0.0', port, socket: { data() {} } });
			s.stop(true);
			return port;
		} catch {}
	}
	throw new Error(`no free port in ${start}–${start + 99}`);
}

if (import.meta.main) {
	const city = await createCityServer();
	const port = await freePort(Number(process.env.PORT ?? 8899));
	Bun.serve({ port, fetch: city.app.fetch, idleTimeout: 120 });
	console.log(`city-graph API  http://localhost:${port}   (OpenAPI reference at /docs)`);
	if (process.env.CITY_PORT_FILE) await Bun.write(process.env.CITY_PORT_FILE, String(port));
}
