/**
 * metro-graph server: Bun + libSQL. Mounts graphx's generated HTTP surface (`/t/...`,
 * `/openapi.json`, `/docs`) and a `/metro` router with the payloads the map wants. Every `/metro`
 * read takes `?project=` to read a scenario branch instead of the baseline.
 *
 *   bun server.ts            # after `bun run download && bun run load`
 *
 * Storage is bql.sh (see `src/bql.ts`): embedded on `data/bql`, or the server in GRAPHX_BQL_URL.
 * Picks the first free port from $PORT (default 8898) upward; never stops what holds a port.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, createProject, diff, Graph, getDb, init } from 'graphx';
import { HTTPException } from 'hono/http-exception';
import { ulid } from 'ulidx';
import { DAYS, type Day, embedder, type Schema, schema } from './schema.ts';
import { useBql } from './src/bql.ts';
import { DATA } from './src/download.ts';
import { applyEdit, Edit } from './src/edits.ts';
import { counts, hops, neighbourhood, search } from './src/explore.ts';
import { fetchVehicles, type Vehicle } from './src/rt.ts';
import {
	allNodes,
	duration,
	networkPayload,
	readView,
	stopsLost,
	summary,
	type View,
} from './src/view.ts';

export interface MetroServerOptions {
	namespace?: string;
	feedPath?: string;
	/** Poll the GTFS-rt feed for live buses (off in tests). */
	live?: boolean;
}

type Feed = {
	feed: { publisher: string; version: string; start: string; end: string };
	dates: Record<Day, string>;
};

export async function createMetroServer(opts: MetroServerOptions = {}) {
	const namespace = opts.namespace ?? 'metro';
	const feedPath = opts.feedPath ?? join(DATA, 'feed.json');
	if (!existsSync(feedPath))
		throw new Error(`no feed at ${feedPath}; run \`bun run download && bun run load\` first`);
	const feed = (await Bun.file(feedPath).json()) as Feed;

	const { app, control, tenant, project, user, graph } = await createApp({
		schema,
		embedder,
		db: namespace,
		cors: true,
		limits: { maxRows: 10_000 }, // bql.sh's default result cap
		openapi: { title: 'metro-graph: King County Metro as a graph' },
	});
	const baseline = graph;

	const listScenarios = async () =>
		(await allNodes(baseline, 'scenario')).sort((a, b) => b.id.localeCompare(a.id));

	// Which graph a request reads: the baseline, or a scenario branch by its project id.
	const branches = new Map<string, Graph<Schema>>();
	async function graphFor(projectId: string | undefined): Promise<Graph<Schema>> {
		if (!projectId || projectId === project) return baseline;
		const hit = branches.get(projectId);
		if (hit) return hit;
		const s = (await listScenarios()).find((x) => x.data.project === projectId);
		if (!s || s.data.status !== 'ready')
			throw new HTTPException(404, { message: `no ready scenario for project ${projectId}` });
		const g = new Graph(getDb(s.data.namespace), schema, { embedder });
		branches.set(projectId, g);
		return g;
	}

	const views = new Map<string, Promise<View>>();
	function viewOf(projectId: string | undefined): Promise<View> {
		const key = projectId || project;
		let v = views.get(key);
		if (!v) {
			v = graphFor(projectId).then(readView);
			v.catch(() => views.delete(key));
			views.set(key, v);
		}
		return v;
	}
	const payloads = new Map<string, unknown>();

	const day = (s: string | undefined): Day => (DAYS.includes(s as Day) ? (s as Day) : 'weekday');

	app.get('/metro/meta', async (c) => {
		const v = await viewOf(undefined);
		return c.json({
			tenant,
			project,
			user,
			...feed,
			counts: {
				routes: v.routes.length,
				stops: v.stops.length,
				patterns: v.patterns.length,
				trips: v.trips.length,
			},
		});
	});

	app.get('/metro/network', async (c) => {
		const key = c.req.query('project') || project;
		if (!payloads.has(key)) payloads.set(key, networkPayload(await viewOf(c.req.query('project'))));
		return c.json(payloads.get(key));
	});

	// A route: its patterns with stop names, every trip, and departures per hour per day.
	app.get('/metro/route/:route', async (c) => {
		const v = await viewOf(c.req.query('project'));
		const r = v.route.get(c.req.param('route'));
		if (!r) return c.json({ error: 'no such route' }, 404);
		const trips = v.tripsOf.get(r.data.gtfsId) ?? [];
		const hourly: Array<{ day: Day; direction: number; hour: number; trips: number }> = [];
		for (const d of DAYS)
			for (const dir of [0, 1])
				for (let h = 0; h < 28; h++) {
					const n = trips.filter(
						(t) =>
							t.data.days.includes(d) &&
							t.data.direction === dir &&
							Math.floor(t.data.start / 3600) === h,
					).length;
					if (n) hourly.push({ day: d, direction: dir, hour: h, trips: n });
				}
		return c.json({
			route: { id: r.id, ...r.data },
			patterns: v.patterns
				.filter((p) => p.data.route === r.data.gtfsId)
				.map((p) => ({
					id: p.id,
					key: p.data.key,
					direction: p.data.direction,
					headsign: p.data.headsign,
					lengthM: p.data.lengthM,
					offsets: p.data.offsets,
					stops: p.data.stops.map((s) => ({
						gtfsId: s,
						name: v.stop.get(s)?.data.name ?? s,
					})),
				})),
			trips: trips.map((t) => ({
				id: t.id,
				gtfsId: t.data.gtfsId,
				pattern: t.data.pattern,
				direction: t.data.direction,
				headsign: t.data.headsign,
				days: t.data.days,
				start: t.data.start,
				duration: duration(t.data),
				times: t.data.times,
			})),
			hourly,
		});
	});

	// A stop: the routes that serve it and its departures over the next two hours of `day` from `t`.
	app.get('/metro/stop/:stop', async (c) => {
		const v = await viewOf(c.req.query('project'));
		const s = v.stop.get(c.req.param('stop'));
		if (!s) return c.json({ error: 'no such stop' }, 404);
		const d = day(c.req.query('day'));
		const t = Number(c.req.query('t') ?? 8 * 3600);
		const at = new Map<string, number>(); // pattern key → index of this stop
		for (const p of v.patterns) {
			const i = p.data.stops.indexOf(s.data.gtfsId);
			if (i >= 0) at.set(p.data.key, i);
		}
		const departures: Array<{ route: string; short: string; headsign: string; time: number }> = [];
		for (const trip of v.trips) {
			const i = at.get(trip.data.pattern);
			if (i === undefined || !trip.data.days.includes(d)) continue;
			const time = trip.data.start + trip.data.times[i]!;
			if (time >= t && time < t + 7200)
				departures.push({
					route: trip.data.route,
					short: v.route.get(trip.data.route)?.data.short ?? trip.data.route,
					headsign: trip.data.headsign,
					time,
				});
		}
		const routes = [...new Set([...at.keys()].map((k) => v.pattern.get(k)!.data.route))].map(
			(id) => ({
				gtfsId: id,
				short: v.route.get(id)?.data.short ?? id,
				color: v.route.get(id)?.data.color,
			}),
		);
		return c.json({
			stop: { id: s.id, ...s.data },
			routes,
			departures: departures.sort((a, b) => a.time - b.time),
		});
	});

	// Graph viewer ------------------------------------------------------------------------------
	app.get('/metro/graph/schema', async (c) =>
		c.json(await counts(await graphFor(c.req.query('project')))),
	);

	app.get('/metro/graph/search', async (c) =>
		c.json(
			search(
				await viewOf(c.req.query('project')),
				c.req.query('q') ?? '',
				c.req.query('type') || undefined,
			),
		),
	);

	// One node: data, history, hop-1 neighbours by rel, and a capped neighbourhood to `depth`.
	app.get('/metro/graph/node/:id', async (c) => {
		const projectId = c.req.query('project');
		const depth = c.req.query('depth') === '2' ? 2 : 1;
		const expand = new Set((c.req.query('expand') ?? '').split(',').filter(Boolean));
		const [g, v] = await Promise.all([graphFor(projectId), viewOf(projectId)]);
		const out = await neighbourhood(g, v, c.req.param('id'), depth, expand);
		if (!out) return c.json({ error: 'no such node' }, 404);
		return c.json(out);
	});

	app.get('/metro/graph/hops', async (c) => {
		const key = `hops:${c.req.query('project') || project}`;
		if (!payloads.has(key)) payloads.set(key, await hops(await graphFor(c.req.query('project'))));
		return c.json(payloads.get(key));
	});

	// Scenarios ---------------------------------------------------------------------------------
	app.get('/metro/scenarios', async (c) =>
		c.json((await listScenarios()).map((s) => ({ id: s.id, ...s.data }))),
	);

	const forks = new Map<string, Promise<void>>();
	app.post('/metro/scenarios', async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { title?: string };
		const title = body.title?.trim() || 'Untitled scenario';
		const ns = `${namespace}__scn_${ulid().toLowerCase()}`;
		const node = await baseline.addNode({
			type: 'scenario',
			data: { title, namespace: ns, project: '', edits: [], status: 'forking', forkedAt: null },
		});
		const done = (async () => {
			try {
				const db = getDb(ns);
				await init(db, embedder);
				// One bql.sh server holds both, so this branches the database file rather than copying rows.
				await baseline.fork(db);
				// Registered as its own project, so graphx's generated routes and hooks work on it.
				const projectId = await createProject(control, {
					tenantId: tenant,
					name: title,
					dbNamespace: ns,
				});
				await baseline.updateNode(node.id, {
					data: { project: projectId, status: 'ready', forkedAt: Date.now() },
				});
			} catch (e) {
				console.error(e);
				await baseline.updateNode(node.id, { data: { status: 'failed' } });
			}
		})();
		forks.set(node.id, done);
		return c.json({ id: node.id, namespace: ns, status: 'forking' }, 202);
	});

	app.post('/metro/scenarios/:id/edits', async (c) => {
		const s = (await listScenarios()).find((x) => x.id === c.req.param('id'));
		if (!s) return c.json({ error: 'no such scenario' }, 404);
		if (s.data.status !== 'ready') return c.json({ error: `scenario is ${s.data.status}` }, 409);
		const parsed = Edit.safeParse(await c.req.json());
		if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
		const g = await graphFor(s.data.project);
		let result: string;
		try {
			result = await applyEdit(g, await viewOf(s.data.project), parsed.data);
		} catch (e) {
			return c.json({ error: (e as Error).message }, 400);
		} finally {
			views.delete(s.data.project);
			payloads.delete(s.data.project);
			payloads.delete(`hops:${s.data.project}`);
		}
		const edits = [...s.data.edits, { ...parsed.data, result, at: Date.now() }];
		await baseline.updateNode(s.id, { data: { edits } });
		return c.json({ result, edits });
	});

	// Baseline against a scenario: totals per day, stops that lose all service, route deltas,
	// and how many versions the edits wrote into the branch (graphx `diff` since the fork).
	app.get('/metro/compare', async (c) => {
		const projectId = c.req.query('project');
		const s = (await listScenarios()).find((x) => x.data.project === projectId);
		if (!s) return c.json({ error: 'no such scenario' }, 404);
		const [a, b] = await Promise.all([viewOf(undefined), viewOf(projectId)]);
		const sa = summary(a);
		const sb = summary(b);
		const routes: Array<{ route: string; short: string; day: Day; before: number; after: number }> =
			[];
		for (const d of DAYS) {
			const ids = new Set([...Object.keys(sa[d].routes), ...Object.keys(sb[d].routes)]);
			for (const id of ids) {
				const before = sa[d].routes[id] ?? 0;
				const after = sb[d].routes[id] ?? 0;
				if (before !== after)
					routes.push({
						route: id,
						short: (b.route.get(id) ?? a.route.get(id))?.data.short ?? id,
						day: d,
						before,
						after,
					});
			}
		}
		const strip = (x: ReturnType<typeof summary>[Day]) => ({
			trips: x.trips,
			revenueHours: x.revenueHours,
			stopsServed: x.stopsServed,
		});
		const g = await graphFor(projectId);
		const changed = await diff(g.raw, s.data.forkedAt ?? 0, Date.now() + 1);
		return c.json({
			days: Object.fromEntries(DAYS.map((d) => [d, { before: strip(sa[d]), after: strip(sb[d]) }])),
			stopsLost: Object.fromEntries(
				DAYS.map((d) => [
					d,
					stopsLost(a, b, d).map((id) => ({ gtfsId: id, name: a.stop.get(id)?.data.name ?? id })),
				]),
			),
			stopsGained: Object.fromEntries(DAYS.map((d) => [d, stopsLost(b, a, d).length])),
			routes,
			versions: { nodes: changed.nodes.length, edges: changed.edges.length },
		});
	});

	// Live buses --------------------------------------------------------------------------------
	let vehicles: Vehicle[] = [];
	let liveError: string | null = null;
	let fetchedAt = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	if (opts.live !== false) {
		const poll = async () => {
			try {
				vehicles = await fetchVehicles();
				fetchedAt = Date.now();
				liveError = null;
			} catch (e) {
				liveError = (e as Error).message;
			}
		};
		void poll();
		timer = setInterval(poll, 15_000);
	}
	app.get('/metro/vehicles', (c) => c.json({ vehicles, fetchedAt, error: liveError }));

	return {
		app,
		baseline,
		tenant,
		project,
		user,
		/** Resolves when the scenario's fork has finished (tests). */
		forked: (id: string) => forks.get(id) ?? Promise.resolve(),
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
	await useBql();
	const metro = await createMetroServer();
	const port = await freePort(Number(process.env.PORT ?? 8898));
	Bun.serve({ port, fetch: metro.app.fetch, idleTimeout: 120 });
	console.log(`metro-graph API  http://localhost:${port}   (OpenAPI reference at /docs)`);
}
