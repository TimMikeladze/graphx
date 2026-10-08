import { betweenness, type Graph, pagerank, persistScores } from 'graphx';
import type { Schema } from '../schema.ts';
import { AM_PEAK, DAY, windowStart } from './day.ts';
import { WINDOWS } from './model/demand.ts';

/**
 * The rankings the "critical intersections" and "safety" panels read with `topNodes`. Each is a
 * graphx algorithm run over the road network as it stood at the morning peak (`asOf`, scoped to
 * intersections and roads), persisted under its own score name — an `asOf` run never overwrites
 * the live analytics.
 */
export const SCORES = {
	betweenness: 'betweenness_am', // share of shortest paths through it at 08:00
	pagerank: 'pagerank_am', // where traffic-weighted routes converge
	volume: 'volume_am', // vehicles per hour entering it at 08:00
	risk: 'crash_risk', // weighted crashes over the three years before the modelled day
} as const;

export async function analyze(
	g: Graph<Schema>,
	log: (s: string) => void = () => {},
): Promise<void> {
	const at = windowStart(WINDOWS[AM_PEAK]!);
	const scope = { rels: ['road'], types: ['intersection'], asOf: at };

	let t = performance.now();
	const bc = await betweenness(g.raw, { ...scope, samples: 3000, seed: 1 });
	await persistScores(g.raw, SCORES.betweenness, [...bc]);
	log(`  betweenness   ${bc.size} intersections, 3000 sampled sources  ${secs(t)}`);

	t = performance.now();
	const pr = await pagerank(g.raw, scope);
	const maxPr = Math.max(...pr.values());
	await persistScores(
		g.raw,
		SCORES.pagerank,
		[...pr].map(([id, v]) => [id, v / maxPr]),
	);
	log(`  pagerank      ${pr.size}  ${secs(t)}`);

	// Volume entering each intersection at the peak, read straight off the road versions.
	t = performance.now();
	const volume = new Map<string, number>();
	let cursor: string | undefined;
	do {
		const page = await g.listEdges({ rel: 'road', asOf: at, limit: 5000, cursor });
		for (const e of page.edges)
			volume.set(e.dst, (volume.get(e.dst) ?? 0) + Number(e.data.volume ?? 0));
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	await persistScores(g.raw, SCORES.volume, [...volume]);
	log(`  volume        ${volume.size}  ${secs(t)}`);

	// Crash risk: the three years before the day, a pedestrian or cyclist crash weighing more.
	t = performance.now();
	const since = DAY - 3 * 365 * 86_400_000;
	const weight = { ped: 3, bike: 2, mv: 1 } as const;
	const crashes = new Map<string, Schema['nodes']['crash']['_output']>();
	let page: string | undefined;
	do {
		const r = await g.listNodes({ type: 'crash', asOf: DAY, limit: 5000, cursor: page });
		for (const n of r.nodes) if (n.type === 'crash') crashes.set(n.id, n.data);
		page = r.nextCursor ?? undefined;
	} while (page);
	const risk = new Map<string, number>();
	cursor = undefined;
	do {
		const r = await g.listEdges({ rel: 'at', asOf: DAY, limit: 5000, cursor });
		for (const e of r.edges) {
			const c = crashes.get(e.src);
			if (!c || c.at < since) continue;
			risk.set(e.dst, (risk.get(e.dst) ?? 0) + weight[c.mode]);
		}
		cursor = r.nextCursor ?? undefined;
	} while (cursor);
	const maxRisk = Math.max(1, ...risk.values());
	await persistScores(
		g.raw,
		SCORES.risk,
		[...risk].map(([id, v]) => [id, v / maxRisk]),
	);
	log(
		`  crash risk    ${risk.size} intersections with a crash since ${new Date(since).getFullYear()}  ${secs(t)}`,
	);
}

const secs = (t: number) => `${((performance.now() - t) / 1000).toFixed(1)}s`;

if (import.meta.main) {
	const { Graph, getDb } = await import('graphx');
	const { embedder, schema } = await import('../schema.ts');
	const db = getDb(process.argv[2] ?? 'city');
	await analyze(new Graph(db, schema, { embedder }), console.log);
	await db.close();
}
