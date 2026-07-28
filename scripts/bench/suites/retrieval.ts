/**
 * The GraphRAG read path — the one an application actually sits on.
 *
 * Depth is swept rather than fixed because the walk is where a graph retriever gets expensive:
 * the ratio between depth 1, 2 and 3 over a corpus with hub nodes is the number that says whether
 * the fan-out guard is doing its job. `retrieve` and `hybridRetrieve` run at the same depths so
 * the lexical leg plus fusion can be priced against the ANN leg alone.
 *
 * The vector index is a fixed 5k rows at every scale (see `corpus.ts`), so what grows across the
 * ladder here is the graph the seeds expand into, not the seed lookup.
 */
import { hybridRetrieve, retrieve, rrf } from '../../../packages/core/src/index.ts';
import { embed } from '../corpus.ts';
import { defineCase, pick, type Suite } from '../types.ts';

export const retrievalSuite: Suite = {
	name: 'retrieval',
	cases: [
		...[1, 2, 3].map((maxDepth) =>
			defineCase<void>({
				name: `retrieve k=10 depth=${maxDepth}`,
				async run(ctx, i) {
					await retrieve(ctx.client, embed, { query: pick(ctx.queries, i), k: 10, maxDepth });
				},
			}),
		),

		...[1, 2].map((maxDepth) =>
			defineCase<void>({
				name: `hybridRetrieve k=10 depth=${maxDepth}`,
				async run(ctx, i) {
					await hybridRetrieve(ctx.client, embed, {
						query: pick(ctx.queries, i),
						k: 10,
						maxDepth,
					});
				},
			}),
		),

		defineCase<string[][]>({
			name: 'rrf fusion (2 lists x 40)',
			// Pure CPU, no database — isolates fusion from the two seed queries that feed it, so a
			// slow `hybridRetrieve` can be attributed to a leg rather than to the merge.
			setup: async (ctx) => {
				const a = ctx.nodeIds.slice(0, 40);
				const b = [...ctx.nodeIds.slice(20, 60)].reverse();
				return [a, b];
			},
			async run(_ctx, _i, lists) {
				rrf(lists, 60);
			},
		}),
	],
};
