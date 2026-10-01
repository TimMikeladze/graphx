/**
 * Example — a traffic-engineering question on a geospatial, bitemporal graph, in one file.
 *
 * The block: a few intersections around Drydock Ave in Boston's Seaport. A company on the block
 * (Amplified Industries) lets its shift out at 5pm and everyone drives to Summer St for I-90.
 * The question: if the Drydock Ave & Tide St light gives Drydock a longer green at rush hour, how
 * much time does that save — and who pays for it?
 *
 *   - intersections are nodes with a lat/lng and their signal timing
 *   - road segments are edges whose weight is "seconds to drive it and wait at the next light"
 *   - rush hour is a new version of those edges (time travel: 8am is still readable)
 *   - the retiming is a second universe: `fork` the city as it stood at 8am into its own
 *     namespace, change one light, and replay the evening there
 *
 * Geometry is approximate and illustrative, not survey data. The delay model is the textbook
 * uniform-delay term for a fixed-time signal: mean red wait = (cycle − green)² / (2 · cycle).
 *
 * Run: `bun run examples/seaport-traffic.ts` (RAM only — nothing is written to disk).
 */
import { type DbClient, defineGraphSchema, diff, Graph, init, shortestPath } from 'graphx';
import { openMemoryDb } from 'graphx/local';
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
	/** A new universe: this one as it stood at `asOf`, in a private RAM namespace of its own.
	 *  Node ids survive a fork, so `ids` still names the same intersections there. */
	async function branch(asOf: number) {
		const into = await openMemoryDb();
		return universe(into, await g.fork(into, { asOf }), ids);
	}
	return { db, g, ids, pave, route, branch };
}

/** The block, seeded into a private RAM namespace. */
async function seed() {
	const db = await openMemoryDb();
	await init(db);
	const g = new Graph(db, schema);
	const ids = {} as Record<Key, string>;
	for (const [key, data] of Object.entries(INTERSECTIONS)) {
		ids[key as Key] = (await g.addNode({ type: 'intersection', data })).id;
	}
	const amplified = await g.addNode({ type: 'place', data: { name: 'Amplified Industries' } });
	await g.addEdge({ rel: 'locatedAt', src: amplified.id, dst: ids.designCenter });
	return universe(db, g, ids);
}

const rush = (street: string) => (street === 'Drydock Ave' ? 3 : 1.5); // the shift is on Drydock
const tick = () => new Promise((r) => setTimeout(r, 50));

// --- Universe A: today --------------------------------------------------------------------
const today = await seed();
await today.pave(() => 1);
await tick();
const t8am = Date.now();
const morning = await today.route('designCenter', 'summer');
await tick();

await today.pave(rush); // 5pm: the shift lets out
await tick();
const t5pm = Date.now();
const evening = await today.route('designCenter', 'summer');
const changed = (await diff(today.db, t8am, t5pm)).edges.filter(
	(e) => e.rel === 'road' && Number(e.valid_from) > t8am,
);

console.log('8am   ', morning);
console.log('5pm   ', evening);
console.log('diff  ', changed.length, 'road segments got slower between 8am and 5pm');

// --- Universe B: fork the city at 8am, retime the Drydock & Tide St light -----------------
const retimed = await today.branch(t8am);
await retimed.g.updateNode(retimed.ids.tide, {
	data: { green: { 'Drydock Ave': 50, 'Tide St': 40 } },
});
await retimed.pave(rush);
const proposal = await retimed.route('designCenter', 'summer');

const before = (await today.g.getNode(today.ids.tide))!.data as Intersection;
const after = (await retimed.g.getNode(retimed.ids.tide))!.data as Intersection;
console.log('light ', before.green, '→', after.green);
console.log('5pm*  ', proposal);

// --- Who wins, who pays ---------------------------------------------------------------------
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

await today.db.close();
await retimed.db.close();
