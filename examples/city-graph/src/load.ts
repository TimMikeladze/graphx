/**
 * Stage 3 of 3: prepared JSON → the graph. Writes the city as it stood before the modelled day
 * (streets, zones, crashes, 311 cases, the bus network), then models the day and writes it.
 *
 * `bun src/load.ts [preparedDir] [namespace]` — namespace defaults to `city`, a libSQL file in
 * the example directory. Set `GRAPHX_DB_DRIVER=postgres` + `GRAPHX_PG_URL` for Postgres.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
	type BulkEdgeRow,
	type BulkRow,
	bulkEdges,
	bulkLoad,
	FOREVER,
	Graph,
	getDb,
	init,
} from 'graphx';
import { ulid } from 'ulidx';
import { embedder, type Schema, schema } from '../schema.ts';
import { analyze } from './analyze.ts';
import { type DayIds, type DayStats, EPOCH, writeDay } from './day.ts';
import { type Prepared, readPrepared } from './prepare.ts';

export const DATA = join(import.meta.dir, '../data');

/** Name an intersection after the two busiest streets that meet there. */
function intersectionNames(p: Prepared): Map<string, string> {
	const streets = new Map<string, Map<string, number>>();
	for (const s of p.network.segments) {
		for (const node of [s.from, s.to]) {
			let m = streets.get(node);
			if (!m) streets.set(node, (m = new Map()));
			m.set(s.street, (m.get(s.street) ?? 0) + s.capacity);
		}
	}
	const names = new Map<string, string>();
	for (const [node, m] of streets) {
		const top = [...m]
			.sort((a, b) => b[1] - a[1])
			.map(([s]) => s)
			.filter((s) => s !== 'ramp' && s !== 'unnamed road');
		names.set(
			node,
			top.length > 1 ? `${top[0]} & ${top[1]}` : top[0] ? `${top[0]} (ramp)` : 'Unnamed junction',
		);
	}
	return names;
}

/**
 * Everything that is true before the modelled day. Every node goes in through ONE `bulkLoad`
 * call — libSQL rebuilds its vector index once per call, so batching by type would rebuild it
 * once per type. Returns the id maps the day writer needs.
 */
export async function writeCity(
	g: Graph<Schema>,
	p: Prepared,
	log: (s: string) => void,
): Promise<DayIds> {
	const t = performance.now();
	const names = intersectionNames(p);
	const ids: DayIds = { intersection: new Map(), zone: new Map(), road: new Map() };

	const residents = new Map<string, number>();
	const jobs = new Map<string, number>();
	for (const f of p.flows) {
		residents.set(f.home, (residents.get(f.home) ?? 0) + f.workers);
		jobs.set(f.work, (jobs.get(f.work) ?? 0) + f.workers);
	}
	const zones = p.zones.filter((z) => residents.has(z.key) || jobs.has(z.key));

	const groups: Array<[label: string, rows: BulkRow<Schema>[]]> = [
		[
			'intersections',
			p.network.intersections.map((i) => ({
				type: 'intersection',
				data: {
					key: i.key,
					name: p.signals[i.key]?.name ?? names.get(i.key) ?? i.key,
					lat: i.lat,
					lng: i.lng,
					signal: p.signals[i.key] ?? null,
				},
				body: p.signals[i.key]?.name ?? names.get(i.key) ?? i.key,
				validFrom: EPOCH,
			})),
		],
		[
			'zones',
			zones.map((z) => ({
				type: 'zone',
				data: {
					key: z.key,
					geoid: z.geoid,
					kind: z.kind,
					name: z.name,
					neighborhood: z.neighborhood,
					lat: z.lat,
					lng: z.lng,
					residents: residents.get(z.key) ?? 0,
					jobs: jobs.get(z.key) ?? 0,
				},
				validFrom: EPOCH,
			})),
		],
		// Crashes are facts from the day they happened on; a few predate the city's epoch.
		[
			'crashes',
			p.crashes.map((c) => ({
				type: 'crash',
				data: {
					at: c.at,
					mode: c.mode,
					locationType: c.locationType,
					street: c.street,
					lat: c.lat,
					lng: c.lng,
				},
				validFrom: Math.max(c.at, EPOCH),
				embedding: false,
			})),
		],
		// A 311 case is valid while it is open: from `openedAt` until it was closed.
		[
			'311 cases',
			p.reports.map((r) => ({
				type: 'report',
				data: {
					caseId: r.caseId,
					type: r.type,
					status: r.status,
					openedAt: r.openedAt,
					closedAt: r.closedAt,
					street: r.street,
					neighborhood: r.neighborhood,
					lat: r.lat,
					lng: r.lng,
				},
				body: r.body,
				validFrom: r.openedAt,
				validTo: r.closedAt ?? FOREVER,
			})),
		],
		[
			'stops',
			p.transit.stops.map((s) => ({
				type: 'stop',
				data: { gtfsId: s.gtfsId, name: s.name, lat: s.lat, lng: s.lng },
				validFrom: EPOCH,
			})),
		],
		[
			'routes',
			p.transit.routes.map((r) => ({
				type: 'route',
				data: { gtfsId: r.gtfsId, name: r.name, longName: r.longName, color: r.color },
				validFrom: EPOCH,
			})),
		],
	];
	const all = groups.flatMap(([, rows]) => rows);
	const minted = (await bulkLoad(g.raw, schema, all, { embedder, chunkSize: 200 })).ids;
	const idsOf: Record<string, string[]> = {};
	let offset = 0;
	for (const [label, rows] of groups) {
		idsOf[label] = minted.slice(offset, offset + rows.length);
		offset += rows.length;
		log(`  ${label.padEnd(14)} ${String(rows.length).padStart(7)}`);
	}
	log(`  nodes written in ${((performance.now() - t) / 1000).toFixed(1)}s`);
	p.network.intersections.forEach((i, k) => ids.intersection.set(i.key, idsOf.intersections![k]!));
	zones.forEach((z, k) => ids.zone.set(z.key, idsOf.zones![k]!));
	const stopIds = new Map(p.transit.stops.map((s, k) => [s.key, idsOf.stops![k]!]));
	const routeIds = new Map(p.transit.routes.map((r, k) => [r.key, idsOf.routes![k]!]));
	const cIds = idsOf.crashes!;
	const rIds = idsOf['311 cases']!;

	const served = new Set<string>();
	const edges: Array<[string, BulkEdgeRow<Schema>[]]> = [
		[
			'connects',
			zones.flatMap((z) =>
				z.connectors.map((c) => ({
					rel: 'connects' as const,
					src: ids.zone.get(z.key)!,
					dst: ids.intersection.get(c)!,
					validFrom: EPOCH,
				})),
			),
		],
		[
			'at',
			p.crashes.flatMap((c, k) =>
				c.intersection
					? [
							{
								rel: 'at' as const,
								src: cIds[k]!,
								dst: ids.intersection.get(c.intersection)!,
								validFrom: Math.max(c.at, EPOCH),
							},
						]
					: [],
			),
		],
		[
			'near',
			p.reports.flatMap((r, k) =>
				r.intersection
					? [
							{
								rel: 'near' as const,
								src: rIds[k]!,
								dst: ids.intersection.get(r.intersection)!,
								validFrom: r.openedAt,
								validTo: r.closedAt ?? FOREVER,
							},
						]
					: [],
			),
		],
		[
			'transitLinks',
			p.transit.links.map((l) => ({
				rel: 'transitLink' as const,
				src: stopIds.get(l.from)!,
				dst: stopIds.get(l.to)!,
				weight: l.scheduledSec,
				data: {
					route: l.route.slice('route:'.length),
					scheduledSec: l.scheduledSec,
					observedSec: null,
				},
				validFrom: EPOCH,
			})),
		],
		[
			'serves',
			p.transit.links.flatMap((l) =>
				[l.from, l.to].flatMap((stop) => {
					const k = `${l.route}|${stop}`;
					if (served.has(k)) return [];
					served.add(k);
					return [
						{
							rel: 'serves' as const,
							src: routeIds.get(l.route)!,
							dst: stopIds.get(stop)!,
							validFrom: EPOCH,
						},
					];
				}),
			),
		],
	];
	await bulkEdges(
		g.raw,
		schema,
		edges.flatMap(([, rows]) => rows),
		{ chunkSize: 200 },
	);
	for (const [label, rows] of edges)
		log(`  ${label.padEnd(14)} ${String(rows.length).padStart(7)}`);

	// Road identities are minted here, once; the day writer and every branch reuse them.
	for (const s of p.network.segments) ids.road.set(s.key, ulid());
	log(`  city written in ${((performance.now() - t) / 1000).toFixed(1)}s`);
	return ids;
}

/** Static map geometry, keyed by graph id: segment polylines and zone outlines. */
export async function writeGeometry(
	p: Prepared,
	ids: DayIds,
	dir = join(DATA, 'city'),
): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const segments = p.network.segments.map((s) => ({
		id: ids.road.get(s.key)!,
		key: s.key,
		from: ids.intersection.get(s.from)!,
		to: ids.intersection.get(s.to)!,
		street: s.street,
		highway: s.highway,
		freeFlowSec: s.freeFlowSec,
		coords: s.coords,
	}));
	const zones = p.zones
		.filter((z) => z.outline && ids.zone.has(z.key))
		.map((z) => ({
			id: ids.zone.get(z.key)!,
			key: z.key,
			name: z.name,
			neighborhood: z.neighborhood,
			outline: z.outline,
		}));
	await Bun.write(join(dir, 'geometry.json'), JSON.stringify({ segments, zones }));
}

/** Drop a namespace's libSQL file so a reload starts clean. */
export function dropLocal(namespace: string, dir = process.cwd()): void {
	for (const ext of ['.db', '.db-wal', '.db-shm'])
		rmSync(join(dir, `${namespace}${ext}`), { force: true });
}

/**
 * The whole load: the city before the day, its geometry, the modelled day, the peak analytics.
 * `cityDir` receives `geometry.json` and `baseline.json` (what the server reads beside the graph).
 */
export async function buildCity(opts: {
	preparedDir: string;
	namespace: string;
	cityDir?: string;
	log?: (s: string) => void;
	progress?: (done: number, total: number, label: string) => void;
}): Promise<{ graph: Graph<Schema>; ids: DayIds; stats: DayStats }> {
	const log = opts.log ?? (() => {});
	const cityDir = opts.cityDir ?? join(DATA, 'city');
	const p = await readPrepared(opts.preparedDir);
	if (!process.env.GRAPHX_DB_DRIVER || process.env.GRAPHX_DB_DRIVER === 'libsql')
		dropLocal(opts.namespace);
	const db = getDb(opts.namespace);
	await init(db, embedder);
	const graph = new Graph(db, schema, { embedder });
	log(`loading Boston into '${opts.namespace}'`);
	const ids = await writeCity(graph, p, log);
	await writeGeometry(p, ids, cityDir);
	log('modelling Tuesday 29 September 2026');
	const stats = await writeDay(graph, p, ids, {
		preparedDir: opts.preparedDir,
		onProgress: opts.progress,
	});
	log(
		`  ${stats.windows} windows, ${stats.roadVersions} road versions, ${stats.commutes} commutes, ${stats.passes} signal passes, ${stats.vehicleHours} vehicle-hours in ${(stats.ms / 1000).toFixed(1)}s`,
	);
	await Bun.write(join(cityDir, 'baseline.json'), JSON.stringify(stats));
	log('analysing the morning peak');
	await analyze(graph, log);
	return { graph, ids, stats };
}

if (import.meta.main) {
	const { graph } = await buildCity({
		preparedDir: process.argv[2] ?? join(DATA, 'prepared'),
		namespace: process.argv[3] ?? 'city',
		log: console.log,
		progress: (done, total, label) => process.stdout.write(`\r  ${done}/${total} ${label}      `),
	});
	await graph.raw.close();
}
