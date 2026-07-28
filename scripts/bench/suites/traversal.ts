/**
 * Neighborhood reads and the whole-graph algorithms.
 *
 * `buildCSR` is measured on its own because every algorithm below it begins by calling it —
 * `pagerank`, `community` and `centrality` all pay for a full edge scan and an in-memory mirror
 * before their first iteration. Without the isolated number, a slow `pagerank` is unattributable:
 * it could be the power iteration or it could be the load.
 *
 * The whole-graph cases run few iterations by design. At 100k nodes each one is seconds, and
 * repeating a deterministic full scan twenty times measures the page cache, not the algorithm.
 */
import {
	buildCSR,
	centrality,
	community,
	pagerank,
	shortestPath,
} from '../../../packages/core/src/index.ts';
import type { Corpus } from '../corpus.ts';
import { defineCase, pick, type Suite } from '../types.ts';

/** Few, long iterations: a full-graph scan whose cost is dominated by IO and allocation. */
const WHOLE_GRAPH = { warmup: 1, minIters: 3, maxIters: 5 };

interface Pair {
	a: string;
	b: string;
}

/**
 * Node pairs known to be two hops apart. Random pairs would mostly be unreachable, and an
 * unreachable `shortestPath` measures an exhaustive search rather than a search — a real number,
 * but not the one a caller experiences.
 */
async function twoHopPairs(ctx: Corpus): Promise<Pair[]> {
	const r = await ctx.client.execute({
		sql: `SELECT e1.src AS a, e2.dst AS b
			FROM edges e1 JOIN edges e2 ON e2.src = e1.dst
			WHERE e1.src <> e2.dst
			LIMIT 200`,
		args: [],
	});
	return r.rows.map((row) => ({ a: String(row.a), b: String(row.b) }));
}

export const traversalSuite: Suite = {
	name: 'traversal',
	cases: [
		defineCase<void>({
			name: 'neighbors (both)',
			async run(ctx, i) {
				await ctx.graph.neighbors(pick(ctx.nodeIds, i));
			},
		}),

		defineCase<void>({
			name: 'neighbors (forward, rel-filtered)',
			async run(ctx, i) {
				await ctx.graph.neighbors(pick(ctx.nodeIds, i), {
					direction: 'forward',
					rels: ['mentions'],
				});
			},
		}),

		defineCase<void>({
			name: 'neighborsPage limit=50',
			async run(ctx, i) {
				await ctx.graph.neighborsPage(pick(ctx.nodeIds, i), { limit: 50 });
			},
		}),

		defineCase<void>({
			name: 'listNodes limit=100',
			async run(ctx, i) {
				await ctx.graph.listNodes({ limit: 100, type: pick(['person', 'document'], i) });
			},
		}),

		defineCase<void>({
			name: 'graphSlice (default caps)',
			measure: WHOLE_GRAPH,
			async run(ctx) {
				await ctx.graph.graphSlice({});
			},
		}),

		defineCase<Pair[]>({
			name: 'shortestPath (memory, weighted)',
			setup: twoHopPairs,
			async run(ctx, i, pairs) {
				const { a, b } = pick(pairs, i);
				await shortestPath(ctx.client, a, b);
			},
		}),

		defineCase<Pair[]>({
			name: 'shortestPath (sql mode, maxDepth=4)',
			setup: twoHopPairs,
			async run(ctx, i, pairs) {
				const { a, b } = pick(pairs, i);
				// The depth bound is not tuning, it is required. Unbounded sql-mode on this corpus does
				// not finish in minutes even at 1k nodes and 2.5k edges: the recursive CTE enumerates
				// paths rather than visiting nodes, so a cyclic graph with hubs explodes. Bounded, it
				// is comparable against the memory mode above; unbounded it is not a usable call.
				await shortestPath(ctx.client, a, b, { mode: 'sql', maxDepth: 4 });
			},
		}),

		defineCase<void>({
			name: 'buildCSR',
			measure: WHOLE_GRAPH,
			async run(ctx) {
				await buildCSR(ctx.client);
			},
		}),

		defineCase<void>({
			name: 'pagerank (maxIter=20)',
			measure: WHOLE_GRAPH,
			async run(ctx) {
				await pagerank(ctx.client, { maxIter: 20 });
			},
		}),

		defineCase<void>({
			name: 'community (label prop, maxIter=10)',
			measure: WHOLE_GRAPH,
			async run(ctx) {
				await community(ctx.client, { maxIter: 10 });
			},
		}),

		defineCase<void>({
			name: 'centrality (degree)',
			measure: WHOLE_GRAPH,
			async run(ctx) {
				await centrality(ctx.client, 'degree');
			},
		}),
	],
};
