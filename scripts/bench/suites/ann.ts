/**
 * The vector index, on its own axis.
 *
 * Every other suite holds the embedded-node cap flat while the graph grows, because letting the
 * index scale with node count would make the 100k corpus impractical to build (see `corpus.ts`).
 * That leaves a real question unanswered — what does the ANN leg cost as the index gets bigger? —
 * so this suite answers it directly: the node count is pinned at 10k and the vector count is
 * swept, which means each variant is its own cached corpus.
 *
 * `maxDepth: 0` keeps the walk out of the measurement. What is left is embed, ANN lookup, and the
 * row assembly for the seeds — the leg, not the expansion.
 */
import { hybridRetrieve, retrieve } from '../../../packages/core/src/index.ts';
import { embed } from '../corpus.ts';
import { defineCase, pick, type Suite } from '../types.ts';

// Capped by the live node count of the fixed 10k corpus: a cap above it just embeds everything.
const VECTORS = [1_000, 5_000, 10_000];

export const annSuite: Suite = {
	name: 'ann',
	// Fixed graph, swept index. Building the 10k-vector corpus is the slowest thing this harness
	// does (~40s on libSQL) — it is cached like every other corpus, so only the first run pays.
	// The node count is the constant here, so a run restricted to other scales skips this suite
	// rather than silently ignoring the restriction.
	variants: (scales) =>
		scales.includes('10k')
			? VECTORS.map((embedded) => ({
					label: `10k/${embedded / 1000}k vec`,
					scale: '10k' as const,
					embedded,
				}))
			: [],
	cases: [
		defineCase<void>({
			name: 'retrieve seeds only (k=10, depth=0)',
			async run(ctx, i) {
				await retrieve(ctx.client, embed, { query: pick(ctx.queries, i), k: 10, maxDepth: 0 });
			},
		}),

		defineCase<void>({
			name: 'retrieve seeds only (k=50, depth=0)',
			async run(ctx, i) {
				await retrieve(ctx.client, embed, { query: pick(ctx.queries, i), k: 50, maxDepth: 0 });
			},
		}),

		defineCase<void>({
			name: 'hybrid seeds only (k=10, depth=0)',
			// The lexical leg's cost does not track vector count, so the gap between this row and the
			// one above widens with the index — that gap is the ANN leg.
			async run(ctx, i) {
				await hybridRetrieve(ctx.client, embed, {
					query: pick(ctx.queries, i),
					k: 10,
					maxDepth: 0,
				});
			},
		}),
	],
};
