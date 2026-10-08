import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCityServer } from '../server.ts';
import { DAY } from '../src/day.ts';
import { buildCity, dropLocal } from '../src/load.ts';
import { prepareAll, writePrepared } from '../src/prepare.ts';

/**
 * The whole pipeline on the Seaport fixture — prepare, load, model the day, analyse — then the
 * server in-process (no port): the map payloads, time-aware routing through graphx's generated
 * route, and a scenario fork end to end.
 */
const dir = mkdtempSync(join(tmpdir(), 'city-graph-'));
const namespace = `city_test_${process.pid}`;
let city: Awaited<ReturnType<typeof createCityServer>>;
let meta: {
	tenant: string;
	project: string;
	user: string;
	amPeak: number;
	windows: Array<{ t: number }>;
};

const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
	const res = await city.app.fetch(new Request(`http://local${path}`, init));
	if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
};
const graphx = <T>(path: string, body?: unknown) =>
	call<T>(`/t/${meta.tenant}/p/${meta.project}${path}`, {
		method: body ? 'POST' : 'GET',
		headers: { 'x-user': meta.user, 'x-tenant': meta.tenant, 'content-type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});

beforeAll(async () => {
	const prepared = join(dir, 'prepared');
	await writePrepared(
		prepared,
		await prepareAll(join(import.meta.dir, '../fixtures/seaport/raw'), () => {}),
	);
	// `getDb` caches one client per namespace; the server reuses this one, so it stays open.
	await buildCity({ preparedDir: prepared, namespace, cityDir: join(dir, 'city') });
	city = await createCityServer({
		namespace,
		preparedDir: prepared,
		cityDir: join(dir, 'city'),
		live: false,
	});
	meta = await call('/city/meta');
}, 120_000);

afterAll(() => {
	city?.close();
	dropLocal(namespace);
	rmSync(dir, { recursive: true, force: true });
});

test('road weights are versions: the morning peak is slower than 3am, and every segment has one', async () => {
	const night = await call<{ seconds: (number | null)[] }>(`/city/weights?t=${DAY + 3 * 3600_000}`);
	const peak = await call<{ seconds: (number | null)[] }>(`/city/weights?t=${meta.amPeak}`);
	expect(night.seconds.every((s) => s !== null)).toBe(true);
	const total = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
	expect(total(peak.seconds)).toBeGreaterThan(total(night.seconds));
});

test('routing asOf: graphx shortest-path prices a trip with the road versions valid at that instant', async () => {
	const top = await graphx<Array<{ id: string }>>(
		'/algorithms/top?by=score:volume_am&type=intersection&limit=30',
	);
	expect(top.length).toBe(30);
	const route = (src: string, dst: string, asOf: number) =>
		graphx<{ path: string[]; cost: number } | null>('/algorithms/shortest-path', {
			src,
			dst,
			rels: ['road'],
			types: ['intersection'],
			asOf,
		});
	// A route's cost is the sum of the road weights valid at its instant — read back per window.
	const net = await call<{ segments: Array<{ from: string; to: string }> }>('/city/network');
	const priced = async (t: number) => {
		const w = await call<{ seconds: (number | null)[] }>(`/city/weights?t=${t}`);
		const best = new Map<string, number>();
		net.segments.forEach((s, i) => {
			const k = `${s.from}>${s.to}`;
			best.set(
				k,
				Math.min(best.get(k) ?? Number.POSITIVE_INFINITY, w.seconds[i] ?? Number.POSITIVE_INFINITY),
			);
		});
		return best;
	};
	const night = DAY + 3 * 3600_000;
	const [atNight, atPeak] = await Promise.all([priced(night), priced(meta.amPeak)]);
	for (let i = 0; i < 6; i++) {
		for (const [t, prices] of [
			[night, atNight],
			[meta.amPeak, atPeak],
		] as const) {
			const r = await route(top[i]!.id, top[29 - i]!.id, t);
			expect(r).not.toBeNull();
			let sum = 0;
			for (let k = 1; k < r!.path.length; k++)
				sum += prices.get(`${r!.path[k - 1]}>${r!.path[k]}`)!;
			expect(r!.cost).toBeCloseTo(sum, 1);
		}
		const [n, p] = await Promise.all([
			route(top[i]!.id, top[29 - i]!.id, night),
			route(top[i]!.id, top[29 - i]!.id, meta.amPeak),
		]);
		expect(p!.cost).toBeGreaterThanOrEqual(n!.cost - 1e-6);
	}
});

test('an intersection answers who drives through it, and a zone where its commuters go', async () => {
	const top = await graphx<Array<{ id: string }>>(
		'/algorithms/top?by=score:betweenness_am&type=intersection&limit=40',
	);
	let found = false;
	for (const { id } of top) {
		const d = await call<{
			signal: unknown;
			passing: { drivers: number; neighborhoods: unknown[] };
			byWindow: unknown[];
		}>(`/city/intersection/${id}`);
		expect(d.byWindow.length).toBe(48);
		if (d.signal && d.passing.drivers > 0) {
			expect(d.passing.neighborhoods.length).toBeGreaterThan(0);
			found = true;
			break;
		}
	}
	expect(found).toBe(true);
	const scenarios = await call<unknown[]>('/city/scenarios');
	expect(scenarios).toEqual([]);
});

test('a scenario forks the city, replays the day with a road closed, and leaves the baseline alone', async () => {
	const net = await call<{ segments: Array<{ id: string; key: string; highway: string }> }>(
		'/city/network',
	);
	const before = await call<{ seconds: (number | null)[] }>(`/city/weights?t=${meta.amPeak}`);
	// Close the busiest primary segment at the peak.
	let pick = -1;
	const vol = (await call<{ volume: (number | null)[] }>(`/city/weights?t=${meta.amPeak}`)).volume;
	net.segments.forEach((s, i) => {
		if (/primary|secondary/.test(s.highway) && (pick < 0 || (vol[i] ?? 0) > (vol[pick] ?? 0)))
			pick = i;
	});
	const { id } = await call<{ id: string }>('/city/scenarios', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			title: 'close the busiest block',
			edits: { closed: [net.segments[pick]!.key] },
		}),
	});
	let s: { id: string; status: string; project: string } | undefined;
	for (let i = 0; i < 240; i++) {
		s = (
			await call<Array<{ id: string; status: string; project: string }>>('/city/scenarios')
		).find((x) => x.id === id);
		if (s?.status !== 'running') break;
		await Bun.sleep(250);
	}
	expect(s?.status).toBe('done');

	const cmp = await call<{
		closed: number[];
		delta: (number | null)[];
		totals: { vehicleHoursScenario: number };
	}>(`/city/compare?project=${s!.project}&t=${meta.amPeak}`);
	expect(cmp.closed).toEqual([pick]);
	expect(cmp.delta.filter((d) => d !== null && d !== 0).length).toBeGreaterThan(0);
	expect(cmp.totals.vehicleHoursScenario).toBeGreaterThan(0);

	// The branch is its own graphx project: generated routes answer for it, with its own scores.
	const branchTop = await call<unknown[]>(
		`/t/${meta.tenant}/p/${s!.project}/algorithms/top?by=score:volume_am&type=intersection&limit=5`,
		{
			headers: { 'x-user': meta.user, 'x-tenant': meta.tenant },
		},
	);
	expect(branchTop.length).toBe(5);
	// …and the baseline did not move.
	const after = await call<{ seconds: (number | null)[] }>(`/city/weights?t=${meta.amPeak}`);
	expect(after.seconds).toEqual(before.seconds);
	dropLocal(
		s!.project
			? (await call<Array<{ id: string; namespace: string }>>('/city/scenarios')).find(
					(x) => x.id === id,
				)!.namespace
			: '',
	);
}, 120_000);
