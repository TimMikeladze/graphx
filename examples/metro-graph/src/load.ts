/**
 * Parse the GTFS feed and write it into a graph.
 *
 *   bun src/load.ts                  # data/gtfs → the `metro` database on bql.sh
 *   bun src/load.ts fixtures/gtfs    # any unzipped GTFS dir
 *
 * Starts bql.sh embedded on `data/bql` unless GRAPHX_BQL_URL names a running server.
 */
import { join } from 'node:path';
import { type BulkEdgeRow, bulkEdges, bulkLoad, Graph, getDb, init } from 'graphx';
import { embedder, type Schema, schema } from '../schema.ts';
import { dropDatabase, useBql } from './bql.ts';
import { DATA } from './download.ts';
import { type Prepared, prepareGtfs } from './gtfs.ts';

/** Feed start date at local midnight, as epoch ms: the valid-from of everything in the feed. */
export function feedEpoch(p: Prepared): number {
	const s = p.feed.start;
	return Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00-07:00`);
}

export async function writeNetwork(
	graph: Graph<Schema>,
	p: Prepared,
	log: (s: string) => void = console.log,
): Promise<void> {
	const validFrom = feedEpoch(p);
	const t = performance.now();
	// bql.sh caps a request body at 8 MB by default, so each group is written in slices small
	// enough to fit: stops and routes carry 256-wide vectors, patterns their geometry.
	const write = async <T>(rows: T[], size: number) => {
		const ids: string[] = [];
		for (let i = 0; i < rows.length; i += size)
			ids.push(
				...(
					await bulkLoad(graph.raw, schema, rows.slice(i, i + size) as never, {
						embedder,
						chunkSize: 200,
						validFrom,
					})
				).ids,
			);
		return ids;
	};
	const routeIds = await write(
		p.routes.map((data) => ({ type: 'route' as const, data, validFrom })),
		300,
	);
	const stopIds = await write(
		p.stops.map((data) => ({ type: 'stop' as const, data, body: data.name, validFrom })),
		300,
	);
	const patternIds = await write(
		p.patterns.map((data) => ({ type: 'pattern' as const, data, validFrom })),
		100,
	);
	const tripIds = await write(
		p.trips.map((data) => ({ type: 'trip' as const, data, validFrom })),
		3000,
	);
	const route = new Map(p.routes.map((r, i) => [r.gtfsId, routeIds[i]!]));
	const stop = new Map(p.stops.map((s, i) => [s.gtfsId, stopIds[i]!]));
	const pattern = new Map(p.patterns.map((x, i) => [x.key, patternIds[i]!]));

	const served = new Set<string>();
	const edges: BulkEdgeRow<Schema>[] = [];
	for (const x of p.patterns) {
		edges.push({ rel: 'has', src: route.get(x.route)!, dst: pattern.get(x.key)!, validFrom });
		x.stops.forEach((s, seq) => {
			edges.push({
				rel: 'calls',
				src: pattern.get(x.key)!,
				dst: stop.get(s)!,
				data: { seq },
				validFrom,
			});
			const k = `${x.route}|${s}`;
			if (served.has(k)) return;
			served.add(k);
			edges.push({ rel: 'serves', src: route.get(x.route)!, dst: stop.get(s)!, validFrom });
		});
	}
	p.trips.forEach((x, i) =>
		edges.push({ rel: 'runs', src: tripIds[i]!, dst: pattern.get(x.pattern)!, validFrom }),
	);
	for (const h of p.hops)
		edges.push({
			rel: 'hop',
			src: stop.get(h.from)!,
			dst: stop.get(h.to)!,
			weight: h.seconds,
			data: { route: h.route, trips: h.trips },
			validFrom,
		});
	for (let i = 0; i < edges.length; i += 10_000)
		await bulkEdges(graph.raw, schema, edges.slice(i, i + 10_000), { chunkSize: 500, validFrom });
	log(
		`  ${p.routes.length} routes, ${p.stops.length} stops, ${p.patterns.length} patterns, ${p.trips.length} trips, ${edges.length} edges in ${((performance.now() - t) / 1000).toFixed(1)}s`,
	);
}

export async function buildMetro(opts: {
	gtfsDir: string;
	namespace: string;
	/** Where to write `{ feed, dates }` for the server. */
	feedPath?: string;
	log?: (s: string) => void;
}): Promise<{ graph: Graph<Schema>; prepared: Prepared }> {
	const log = opts.log ?? console.log;
	log(`parsing ${opts.gtfsDir}`);
	const prepared = await prepareGtfs(opts.gtfsDir, log);
	if (opts.feedPath)
		await Bun.write(opts.feedPath, JSON.stringify({ feed: prepared.feed, dates: prepared.dates }));
	await dropDatabase(opts.namespace);
	const db = getDb(opts.namespace);
	await init(db, embedder);
	const graph = new Graph(db, schema, { embedder });
	log(`writing '${opts.namespace}'`);
	await writeNetwork(graph, prepared, log);
	return { graph, prepared };
}

if (import.meta.main) {
	const gtfsDir = process.argv[2] ?? join(DATA, 'gtfs');
	const bql = await useBql();
	await buildMetro({
		gtfsDir,
		namespace: process.env.METRO_DB ?? 'metro',
		feedPath: join(DATA, 'feed.json'),
	});
	await bql.close();
	process.exit(0);
}
