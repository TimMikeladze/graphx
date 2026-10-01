/**
 * Example — the Seaport traffic what-if (`examples/seaport-traffic.ts`) on bql.sh.
 *
 * Same block, same question: if the Drydock Ave & Tide St light gives Drydock a longer green at
 * rush hour, how much time does Amplified Industries' 5pm shift get back — and who pays for it?
 * What changes is where the two kinds of time live:
 *
 *   - graphx versions every node and edge, so 8am is still readable after rush hour lands
 *   - bql.sh can branch a whole database on its server, recording the branch's parent
 *
 * Universe B is `fork(today, retimed, { asOf: 8am })`. Both are databases on one bql.sh server,
 * so graphx does not copy a row: bql.sh branches the database file, and graphx trims the branch in
 * place to the city as it stood at 8am. The engineer then retimes the light there.
 *
 * Geometry is approximate and illustrative, not survey data. The delay model is the textbook
 * uniform-delay term for a fixed-time signal: mean red wait = (cycle − green)² / (2 · cycle).
 *
 * From this directory: `bun run sqlite:build` once per machine (builds the libsqlite3 bql.sh
 * loads; needs a C compiler), then `bun run start`. Data lives in a temp dir, removed after.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bql } from 'bql.sh';
import { type DbClient, defineGraphSchema, diff, fork, Graph, init, shortestPath } from 'graphx';
import { createBqlRemoteClient } from 'graphx/bql';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: {
		intersection: z.object({
			name: z.string(),
			lat: z.number(),
			lng: z.number(),
			cycleSec: z.number(), // 0 = no signal
			green: z.record(z.string(), z.number()), // street → seconds of green per cycle
		}),
		place: z.object({ name: z.string() }),
	},
	edges: {
		road: {
			from: 'intersection',
			to: 'intersection',
			data: z.object({ street: z.string(), lengthM: z.number(), demand: z.number() }),
		},
		locatedAt: { from: 'place', to: 'intersection', single: true },
	},
});

type Intersection = z.infer<typeof schema.nodes.intersection>;

const INTERSECTIONS = {
	designCenter: {
		name: 'Drydock Ave & Design Center Pl',
		lat: 42.3446,
		lng: -71.0285,
		cycleSec: 0,
		green: {},
	},
	tide: {
		name: 'Drydock Ave & Tide St',
		lat: 42.3449,
		lng: -71.0318,
		cycleSec: 90,
		green: { 'Drydock Ave': 30, 'Tide St': 60 },
	},
	harbor: { name: 'Northern Ave & Harbor St', lat: 42.3478, lng: -71.029, cycleSec: 0, green: {} },
	northernTide: {
		name: 'Northern Ave & Tide St',
		lat: 42.3482,
		lng: -71.0322,
		cycleSec: 90,
		green: { 'Northern Ave': 45, 'Tide St': 45 },
	},
	summer: {
		name: 'Summer St & Drydock Ave',
		lat: 42.3437,
		lng: -71.0352,
		cycleSec: 120,
		green: { 'Drydock Ave': 50, 'Tide St': 50 },
	},
} satisfies Record<string, Intersection>;
type Key = keyof typeof INTERSECTIONS;

const ROADS: Array<{ from: Key; to: Key; street: string; lengthM: number }> = [
	{ from: 'designCenter', to: 'tide', street: 'Drydock Ave', lengthM: 300 },
	{ from: 'tide', to: 'summer', street: 'Drydock Ave', lengthM: 450 },
	{ from: 'designCenter', to: 'harbor', street: 'Harbor St', lengthM: 350 },
	{ from: 'harbor', to: 'northernTide', street: 'Northern Ave', lengthM: 400 },
	{ from: 'northernTide', to: 'tide', street: 'Tide St', lengthM: 380 },
];

const CRUISE_MPS = 11; // ~25 mph
const SHIFT_CARS = 400;

/** Seconds to drive a segment and wait at the light at its far end. `demand` 1 = free flow. */
function segmentSeconds(lengthM: number, street: string, at: Intersection, demand: number): number {
	const drive = lengthM / CRUISE_MPS;
	const green = at.green[street];
	const wait =
		at.cycleSec && green !== undefined ? (at.cycleSec - green) ** 2 / (2 * at.cycleSec) : 0;
	return Math.round((drive + wait) * demand);
}

/** One universe: a graph of the block, and the moves a traffic engineer makes on it. */
function universe(db: DbClient, g: Graph<typeof schema>, ids: Record<Key, string>) {
	/** (Re)pave every segment from the current signal timing — each repave is a new edge version. */
	async function pave(demand: (street: string) => number) {
		for (const old of (await g.listEdges({ rel: 'road' })).edges) await g.deleteEdge(old.id);
		for (const r of ROADS) {
			const at = (await g.getNode(ids[r.to]))!.data as Intersection;
			const d = demand(r.street);
			await g.addEdge({
				rel: 'road',
				src: ids[r.from],
				dst: ids[r.to],
				weight: segmentSeconds(r.lengthM, r.street, at, d),
				data: { street: r.street, lengthM: r.lengthM, demand: d },
			});
		}
	}
	async function route(from: Key, to: Key) {
		const p = await shortestPath(db, ids[from], ids[to], { rels: ['road'] });
		const names = await Promise.all(
			p!.path.map(async (id) => ((await g.getNode(id))!.data as Intersection).name),
		);
		return { seconds: p!.cost, via: names.join(' → ') };
	}
	return { db, g, ids, pave, route };
}

// --- bql.sh, embedded: the whole server in this process, listening on a free local port -----
const dir = await mkdtemp(join(tmpdir(), 'seaport-bql-'));
// graphx turns foreign keys on for each database it creates, and a fork inherits its parent's.
const bql = await Bql.open({ dir });
const server = await bql.serve({ host: '127.0.0.1', port: 0 });
const token = server.adminKey ?? undefined;
/** A graphx client on one bql.sh database, created on first use unless it already exists. */
const connect = (database: string, ensureDatabase = true) =>
	createBqlRemoteClient({ url: server.url, database, authToken: token, ensureDatabase });

const rush = (street: string) => (street === 'Drydock Ave' ? 3 : 1.5); // the shift is on Drydock
const tick = () => new Promise((r) => setTimeout(r, 50));

try {
	// --- Universe A: today ----------------------------------------------------------------
	const todayDb = connect('today');
	await init(todayDb);
	const g = new Graph(todayDb, schema);
	const ids = {} as Record<Key, string>;
	for (const [key, data] of Object.entries(INTERSECTIONS)) {
		ids[key as Key] = (await g.addNode({ type: 'intersection', data })).id;
	}
	const amplified = await g.addNode({ type: 'place', data: { name: 'Amplified Industries' } });
	await g.addEdge({ rel: 'locatedAt', src: amplified.id, dst: ids.designCenter });
	const today = universe(todayDb, g, ids);

	await today.pave(() => 1);
	await tick();
	const t8am = Date.now();
	const morning = await today.route('designCenter', 'summer');
	await tick();

	await today.pave(rush); // 5pm: the shift lets out
	await tick();
	const t5pm = Date.now();
	const evening = await today.route('designCenter', 'summer');
	const changed = (await diff(todayDb, t8am, t5pm)).edges.filter(
		(e) => e.rel === 'road' && Number(e.valid_from) > t8am,
	);

	console.log('8am   ', morning);
	console.log('5pm   ', evening);
	console.log('diff  ', changed.length, 'road segments got slower between 8am and 5pm');

	// --- Universe B: the city forked at 8am — bql.sh branches the database, graphx trims it ------
	const retimedDb = connect('retimed');
	const branch = await fork(todayDb, retimedDb, { asOf: t8am });
	const lineage = bql.stat('retimed');
	console.log(
		'fork  ',
		`${branch.method}: retimed ← ${lineage.parent}, trimmed to 8am, foreign keys ${lineage.foreignKeys ? 'on' : 'off'}`,
	);

	const retimed = universe(retimedDb, new Graph(retimedDb, schema), ids); // ids survive the fork
	console.log(
		'8am*  ',
		`${(await retimed.route('designCenter', 'summer')).seconds}s — the fork is the city at 8am`,
	);
	await retimed.g.updateNode(ids.tide, { data: { green: { 'Drydock Ave': 50, 'Tide St': 40 } } });
	await retimed.pave(rush);
	const proposal = await retimed.route('designCenter', 'summer');

	const before = (await today.g.getNode(ids.tide))!.data as Intersection;
	const after = (await retimed.g.getNode(ids.tide))!.data as Intersection;
	console.log('light ', before.green, '→', after.green);
	console.log('5pm*  ', proposal);

	// --- Who wins, who pays -------------------------------------------------------------------
	const saved = evening.seconds - proposal.seconds;
	const tideToday = await today.route('northernTide', 'tide');
	const tideRetimed = await retimed.route('northernTide', 'tide');
	console.log(
		'shift ',
		`${saved}s faster per car × ${SHIFT_CARS} cars = ${((saved * SHIFT_CARS) / 3600).toFixed(1)} hours back every evening`,
	);
	console.log(
		'cost  ',
		`Tide St drivers wait ${tideRetimed.seconds - tideToday.seconds}s longer at the light`,
	);
	todayDb.close();
	retimedDb.close();
} finally {
	await bql.close();
	await rm(dir, { recursive: true, force: true });
}
