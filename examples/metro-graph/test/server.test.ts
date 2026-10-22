import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMetroServer } from '../server.ts';
import { type BqlHandle, dropDatabase, useBql } from '../src/bql.ts';
import { buildMetro } from '../src/load.ts';

/**
 * Load the fixture feed into an embedded bql.sh server in a temp dir, run the API in-process,
 * fork a scenario and edit it.
 */
const dir = mkdtempSync(join(tmpdir(), 'metro-graph-'));
const namespace = `metro_test_${process.pid}`;
let bql: BqlHandle;
let metro: Awaited<ReturnType<typeof createMetroServer>>;
let scenario: { id: string; project: string; namespace: string };

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
	const res = await metro.app.fetch(new Request(`http://local${path}`, init));
	if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
};
const post = <T>(path: string, body: unknown) =>
	call<T>(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

type Route = {
	route: { gtfsId: string };
	trips: Array<{ direction: number; days: string[]; start: number }>;
};

beforeAll(async () => {
	bql = await useBql(join(dir, 'bql'));
	await buildMetro({
		gtfsDir: join(import.meta.dir, '../fixtures/gtfs'),
		namespace,
		feedPath: join(dir, 'feed.json'),
		log: () => {},
	});
	metro = await createMetroServer({ namespace, feedPath: join(dir, 'feed.json'), live: false });
	const s = await post<{ id: string; namespace: string }>('/metro/scenarios', { title: 'test' });
	await metro.forked(s.id);
	const list =
		await call<Array<{ id: string; project: string; status: string }>>('/metro/scenarios');
	const ready = list.find((x) => x.id === s.id)!;
	expect(ready.status).toBe('ready');
	scenario = { id: s.id, project: ready.project, namespace: s.namespace };
}, 120_000);

afterAll(async () => {
	metro?.close();
	await dropDatabase(namespace);
	if (scenario) await dropDatabase(scenario.namespace);
	await bql?.close();
	rmSync(dir, { recursive: true, force: true });
});

test('network payload has every pattern with geometry and trips', async () => {
	const meta = await call<{ counts: { routes: number; trips: number } }>('/metro/meta');
	expect(meta.counts.routes).toBe(3);
	const net = await call<{
		patterns: Array<{ coords: unknown[]; stopDist: number[]; offsets: number[]; trips: unknown[] }>;
	}>('/metro/network');
	const trips = net.patterns.reduce((s, p) => s + p.trips.length, 0);
	expect(trips).toBe(meta.counts.trips);
	for (const p of net.patterns) {
		expect(p.stopDist.length).toBe(p.offsets.length);
		expect(p.stopDist).toEqual([...p.stopDist].sort((a, b) => a - b));
	}
});

test('stop departures are sorted and inside the two-hour window', async () => {
	const r = await call<{ patterns: Array<{ stops: Array<{ gtfsId: string }> }> }>(
		'/metro/route/100001',
	);
	const stop = r.patterns[0]!.stops[0]!.gtfsId;
	const s = await call<{ routes: unknown[]; departures: Array<{ time: number }> }>(
		`/metro/stop/${stop}?day=weekday&t=${8 * 3600}`,
	);
	expect(s.routes.length).toBeGreaterThan(0);
	expect(s.departures.length).toBeGreaterThan(0);
	for (const d of s.departures) expect(d.time >= 8 * 3600 && d.time < 10 * 3600).toBe(true);
});

test('headway edit replaces the window in the branch and leaves the baseline alone', async () => {
	const before = await call<Route>('/metro/route/100001');
	const inWindow = (r: Route) =>
		r.trips.filter(
			(t) =>
				t.direction === 0 &&
				t.days.includes('weekday') &&
				t.start >= 7 * 3600 &&
				t.start < 9 * 3600,
		);
	await post(`/metro/scenarios/${scenario.id}/edits`, {
		op: 'headway',
		route: '100001',
		direction: 0,
		day: 'weekday',
		from: 7 * 3600,
		to: 9 * 3600,
		minutes: 5,
	});
	const after = await call<Route>(`/metro/route/100001?project=${scenario.project}`);
	expect(inWindow(after).map((t) => t.start)).toEqual(
		Array.from({ length: 24 }, (_, i) => 7 * 3600 + i * 300),
	);
	expect(inWindow(await call<Route>('/metro/route/100001'))).toEqual(inWindow(before));
});

test('shift moves every trip of that day and direction', async () => {
	const starts = async (project?: string) =>
		(
			await call<Route>(project ? `/metro/route/100028?project=${project}` : '/metro/route/100028')
		).trips
			.filter((t) => t.direction === 1 && t.days.includes('saturday'))
			.map((t) => t.start)
			.sort((a, b) => a - b);
	const before = await starts();
	await post(`/metro/scenarios/${scenario.id}/edits`, {
		op: 'shift',
		route: '100028',
		direction: 1,
		day: 'saturday',
		minutes: 10,
	});
	expect(await starts(scenario.project)).toEqual(before.map((s) => s + 600));
});

test('remove and add routes, then compare against the baseline', async () => {
	await post(`/metro/scenarios/${scenario.id}/edits`, { op: 'removeRoute', route: '100028' });
	const net = await call<{ stops: Array<{ gtfsId: string }> }>('/metro/network');
	const stops = net.stops.slice(0, 4).map((s) => s.gtfsId);
	const added = await post<{ result: string }>(`/metro/scenarios/${scenario.id}/edits`, {
		op: 'addRoute',
		short: 'X1',
		stops,
		spans: [{ day: 'weekday', from: 6 * 3600, to: 10 * 3600, minutes: 15 }],
	});
	expect(added.result).toContain('16 trips');
	const cmp = await call<{
		days: Record<string, { before: { trips: number }; after: { trips: number } }>;
		routes: Array<{ route: string; short: string; day: string; before: number; after: number }>;
		versions: { nodes: number };
	}>(`/metro/compare?project=${scenario.project}`);
	expect(cmp.routes.find((r) => r.short === 'X1' && r.day === 'weekday')).toMatchObject({
		before: 0,
		after: 16,
	});
	expect(cmp.routes.some((r) => r.route === '100028' && r.after === 0)).toBe(true);
	expect(cmp.versions.nodes).toBeGreaterThan(0);
	const net2 = await call<{ routes: Array<{ gtfsId: string }> }>(
		`/metro/network?project=${scenario.project}`,
	);
	expect(net2.routes.map((r) => r.gtfsId)).not.toContain('100028');
	expect(net2.routes.map((r) => r.gtfsId)).toContain('scn:X1');
	const bad = await metro.app.fetch(
		new Request(`http://local/metro/scenarios/${scenario.id}/edits`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'removeRoute', route: 'nope' }),
		}),
	);
	expect(bad.status).toBe(400);
});

type Hood = {
	focus: { id: string; type: string };
	history: Array<{ current: boolean }>;
	neighbours: Array<{ rel: string; dir: string; count: number }>;
	nodes: Array<{
		id: string;
		type: string;
		hop: number;
		pos: [number, number] | null;
		group?: { key: string; count: number; expandable: boolean };
	}>;
	edges: Array<{ src: string; dst: string; rel: string }>;
};

test('graph schema counts every type and rel', async () => {
	const s = await call<{
		nodes: Array<{ type: string; count: number }>;
		edges: Array<{ rel: string; count: number }>;
	}>('/metro/graph/schema');
	const meta = await call<{ counts: { routes: number; patterns: number; trips: number } }>(
		'/metro/meta',
	);
	const n = Object.fromEntries(s.nodes.map((x) => [x.type, x.count]));
	const e = Object.fromEntries(s.edges.map((x) => [x.rel, x.count]));
	expect(n.route).toBe(meta.counts.routes);
	expect(n.trip).toBe(meta.counts.trips);
	expect(e.has).toBe(meta.counts.patterns);
	expect(e.runs).toBe(meta.counts.trips);
	expect(e.hop).toBeGreaterThan(0);
});

test('a route neighbourhood collapses its stops into one group until expanded', async () => {
	const { route } = await call<{ route: { id: string } }>('/metro/route/100001');
	const hood = await call<Hood>(`/metro/graph/node/${route.id}`);
	expect(hood.focus.type).toBe('route');
	expect(hood.history.some((h) => h.current)).toBe(true);
	const serves = hood.neighbours.find((g) => g.rel === 'serves' && g.dir === 'out')!;
	const group = hood.nodes.find((x) => x.group?.key === `${route.id}:serves:out`)!;
	expect(group.group).toMatchObject({ count: serves.count, expandable: true });
	expect(hood.nodes.filter((x) => x.type === 'stop' && !x.group)).toHaveLength(0);
	expect(hood.nodes.filter((x) => x.type === 'pattern').length).toBe(
		hood.neighbours.find((g) => g.rel === 'has')!.count,
	);

	const open = await call<Hood>(
		`/metro/graph/node/${route.id}?expand=${encodeURIComponent(group.group!.key)}`,
	);
	const stops = open.nodes.filter((x) => x.type === 'stop' && !x.group);
	expect(stops.length).toBe(Math.min(serves.count, 80));
	expect(stops.every((x) => x.pos !== null)).toBe(true);
});

test('depth 2 stays under the node cap and reads the scenario branch', async () => {
	const { route } = await call<{ route: { id: string } }>('/metro/route/100001');
	const hood = await call<Hood>(
		`/metro/graph/node/${route.id}?depth=2&project=${scenario.project}`,
	);
	expect(hood.nodes.length).toBeLessThanOrEqual(160);
	expect(hood.nodes.some((x) => x.hop === 2)).toBe(true);
	const ids = new Set(hood.nodes.map((x) => x.id));
	for (const e of hood.edges) expect(ids.has(e.src) && ids.has(e.dst)).toBe(true);
	// Every pattern's trips collapse into one group at hop 2.
	expect(hood.nodes.some((x) => x.type === 'trip' && x.group && x.hop === 2)).toBe(true);
});
