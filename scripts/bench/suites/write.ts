/**
 * The write path. Every case here mutates, so each takes a private restored copy of the corpus
 * (see `freshCorpus`) — otherwise the bulk cases would double the graph under themselves and the
 * later iterations would be measuring a different database than the earlier ones.
 *
 * The single-row and bulk paths are both present because the interesting number is the ratio: it
 * says what an ingest pipeline gives up by writing row-at-a-time, and whether the chunk size is
 * anywhere near the right one.
 */
import type { BulkEdgeRow, BulkRow } from '../../../packages/core/src/index.ts';
import { bulkEdges, bulkLoad } from '../../../packages/core/src/index.ts';
import type { DemoSchema } from '../../seed/schema.ts';
import { demoSchema } from '../../seed/schema.ts';
import type { Corpus } from '../corpus.ts';
import { defineCase, pick, type Suite } from '../types.ts';

/** Live ids of one node type, in primary-key order — the input pool for the endpoint-typed cases. */
async function idsOfType(ctx: Corpus, type: string, limit: number): Promise<string[]> {
	const r = await ctx.client.execute({
		sql: 'SELECT id FROM nodes WHERE type = ? ORDER BY id LIMIT ?',
		args: [type, limit],
	});
	return r.rows.map((row) => String(row.id));
}

/** A batch of fresh tag rows. No `id`, so every load mints new identities and never conflicts. */
function tagRows(count: number, tag: string): Array<BulkRow<DemoSchema>> {
	return Array.from({ length: count }, (_, i) => ({
		type: 'tag' as const,
		data: { label: `${tag}-${i}` },
		body: `bulk ${tag} label ${i}`,
	}));
}

const BULK_ROWS = 5_000;

/**
 * Bulk cases append `BULK_ROWS` per iteration, so an unbounded run would grow the graph out from
 * under its own measurements. Capping the iterations keeps the perturbation to a quarter of the
 * smallest corpus, at the cost of a coarser p95 on these rows.
 */
const BULK_MEASURE = { minIters: 3, maxIters: 5 };

export const writeSuite: Suite = {
	name: 'write',
	cases: [
		defineCase<void>({
			name: 'addNode',
			mutates: true,
			async run(ctx, i) {
				await ctx.graph.addNode({ type: 'tag', data: { label: `bench-${i}` } });
			},
		}),

		defineCase<string[]>({
			name: 'addEdge',
			mutates: true,
			setup: (ctx) => idsOfType(ctx, 'person', 1_000),
			async run(ctx, i, people) {
				// Distinct endpoints, and a stride that avoids re-writing the same pair back to back.
				await ctx.graph.addEdge({
					rel: 'knows',
					src: pick(people, i),
					dst: pick(people, i + 1),
				});
			},
		}),

		defineCase<string[]>({
			name: 'updateNode',
			mutates: true,
			setup: (ctx) => idsOfType(ctx, 'tag', 1_000),
			async run(ctx, i, tags) {
				// The version-close path: read the live row, close it, insert its successor.
				await ctx.graph.updateNode(pick(tags, i), { data: { label: `updated-${i}` } });
			},
		}),

		defineCase<string[]>({
			name: 'deleteNode',
			mutates: true,
			// A delete is not idempotent — the second call on an id throws — so the pool is consumed
			// rather than cycled, and the iteration cap is bounded by its size (500) minus warmup.
			measure: { maxIters: 400 },
			setup: async (ctx) => ctx.nodeIds,
			async run(ctx, i, ids) {
				await ctx.graph.deleteNode(ids[i] as string);
			},
		}),

		defineCase<Array<BulkRow<DemoSchema>>>({
			name: `bulkLoad ${BULK_ROWS} rows, chunk 200`,
			mutates: true,
			measure: BULK_MEASURE,
			setup: async () => tagRows(BULK_ROWS, 'c200'),
			async run(ctx, _i, rows) {
				await bulkLoad(ctx.client, demoSchema, rows, { chunkSize: 200 });
			},
		}),

		defineCase<Array<BulkRow<DemoSchema>>>({
			name: `bulkLoad ${BULK_ROWS} rows, chunk 1000`,
			mutates: true,
			measure: BULK_MEASURE,
			setup: async () => tagRows(BULK_ROWS, 'c1000'),
			async run(ctx, _i, rows) {
				await bulkLoad(ctx.client, demoSchema, rows, { chunkSize: 1_000 });
			},
		}),

		defineCase<Array<BulkEdgeRow<DemoSchema>>>({
			name: `bulkEdges ${BULK_ROWS} rows, chunk 200`,
			mutates: true,
			measure: BULK_MEASURE,
			setup: async (ctx) => {
				const people = await idsOfType(ctx, 'person', 2_000);
				return Array.from({ length: BULK_ROWS }, (_, i) => ({
					rel: 'knows' as const,
					src: pick(people, i),
					dst: pick(people, i + 7),
				}));
			},
			async run(ctx, _i, rows) {
				// No `types` map, so endpoint validation is skipped — this measures the insert path
				// alone, which is what an importer that already knows its node types would pay.
				await bulkEdges(ctx.client, demoSchema, rows, { chunkSize: 200 });
			},
		}),

		defineCase<Array<BulkEdgeRow<DemoSchema>>>({
			name: `bulkEdges ${BULK_ROWS} rows, chunk 1000`,
			mutates: true,
			measure: BULK_MEASURE,
			setup: async (ctx) => {
				const people = await idsOfType(ctx, 'person', 2_000);
				return Array.from({ length: BULK_ROWS }, (_, i) => ({
					rel: 'knows' as const,
					src: pick(people, i),
					dst: pick(people, i + 7),
				}));
			},
			async run(ctx, _i, rows) {
				await bulkEdges(ctx.client, demoSchema, rows, { chunkSize: 1_000 });
			},
		}),
	],
};
