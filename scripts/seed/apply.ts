/**
 * Loads a plan into a database. The only impure half of the seed: everything decided about the
 * graph's shape happened in `generate.ts` / `temporal.ts`, and this just embeds the bodies and
 * hands the rows to the bulk loaders.
 */
import type { DbClient, EmbedFn } from '../../packages/core/src/index.ts';
import { bulkEdges, bulkLoad } from '../../packages/core/src/index.ts';
import type { Plan } from './generate.ts';
import { demoSchema } from './schema.ts';

export interface ApplyResult {
	/** Distinct node identities. */
	nodes: number;
	/** Node version rows written (identities + their superseded revisions). */
	versions: number;
	edges: number;
	/** Live nodes that carry an embedding, and so are reachable by semantic search. */
	embedded: number;
}

export interface ApplyOpts {
	/**
	 * Cap on embedded live nodes (default 5000; 0 means every live node).
	 *
	 * This is the seed's dominant cost by a wide margin. Building libSQL's vector index over the
	 * loaded rows grows superlinearly — measured on this schema at 256 dims, 2k vectors take ~6s,
	 * 5k ~16s, 10k ~36s and 25k ~108s — while everything else together (generate, embed, insert
	 * 25k nodes and 65k edges) finishes in about a second.
	 *
	 * The trade is real and worth stating: `/retrieve` and `/hybrid` can only ever return nodes
	 * that carry a vector, so above the cap semantic search sees a sample of the graph rather than
	 * all of it. The sample is taken by an even stride over the load order, which the generator has
	 * already interleaved by type and community, so it stays representative.
	 */
	maxEmbedded?: number;
}

/** Edge rows per `bulkEdges` call — one call is one batch, so this bounds peak statement size. */
const EDGE_SLICE = 10_000;

const DEFAULT_MAX_EMBEDDED = 5_000;

export async function applyPlan(
	raw: DbClient,
	plan: Plan,
	embed: EmbedFn,
	opts: ApplyOpts = {},
): Promise<ApplyResult> {
	if (plan.nodes.length === 0) return { nodes: 0, versions: 0, edges: 0, embedded: 0 };

	// Only open versions are candidates: the ANN index is partial over live rows, so a vector on a
	// superseded version is storage nobody queries.
	const live = plan.nodes.filter((node) => node.validTo === undefined);
	const cap = opts.maxEmbedded ?? DEFAULT_MAX_EMBEDDED;
	const stride = cap > 0 && live.length > cap ? Math.ceil(live.length / cap) : 1;
	const chosen = new Set(live.filter((_, i) => i % stride === 0).map((node) => node.id));

	const rows = await Promise.all(
		plan.nodes.map(async (node) =>
			node.validTo === undefined && chosen.has(node.id)
				? { ...node, emb: await embed(node.body as string) }
				: node,
		),
	);
	await bulkLoad(raw, demoSchema, rows, { chunkSize: 200 });

	for (let i = 0; i < plan.edges.length; i += EDGE_SLICE) {
		await bulkEdges(raw, demoSchema, plan.edges.slice(i, i + EDGE_SLICE), {
			chunkSize: 200,
			types: plan.types,
		});
	}

	return {
		nodes: plan.types.size,
		versions: plan.nodes.length,
		edges: plan.edges.length,
		embedded: chosen.size,
	};
}
