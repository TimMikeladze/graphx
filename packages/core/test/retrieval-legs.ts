import { FOREVER } from '../src/db.ts';
import { dialectOf, type DbClient } from '../src/dialect.ts';
import { ftsSeedLive, vecSeedLive } from '../src/dialect-sql.ts';
import { hybridRetrieve, rrf, sanitizeMatch } from '../src/hybrid.ts';
import { retrieve, type EmbedFn } from '../src/retrieve.ts';

/**
 * The individual retrieval legs, isolated so they can be scored against each other.
 *
 * `hybridRetrieve` fuses the ANN and FTS seed lists with RRF, feeds the top-k into the walk, and
 * returns the expanded rows ordered by DEPTH — the fused ranking is used but never surfaced. So
 * an honest ablation has to split in two:
 *
 *  - **Ranked metrics** (MRR, nDCG) on the seed lists, which are genuinely in rank order.
 *  - **Recall** on the walk-expanded sets, where order carries no meaning and the question is
 *    only whether the relevant documents were reached at all.
 *
 * These call the SAME dialect SQL and the SAME `rrf` that `hybridRetrieve` uses, so a change to
 * fusion or to either seed query moves the scores rather than quietly bypassing them.
 */

/** RRF constant used by `hybridRetrieve` (its `DEFAULT_RRF_K`). */
const RRF_K = 60;
/** Seed over-fetch used by `hybridRetrieve` (its `SEED_MULTIPLIER`). */
const SEED_MULTIPLIER = 4;

/**
 * Every live document scored against the query, nearest first, with its cosine DISTANCE.
 *
 * Distance is the ground truth a ranking is merely a view over: it is tie-immune, so two engines
 * that disagree about which of two equidistant documents to keep at the cut still have to agree
 * here. The expressions mirror the metric each dialect's `nv_emb_idx` is built with
 * (`vector_cosine_ops` / `metric=cosine`), evaluated exactly rather than through the ANN index.
 */
export async function annScored(
	raw: DbClient,
	embed: EmbedFn,
	query: string,
): Promise<{ id: string; dist: number }[]> {
	const d = dialectOf(raw);
	const distExpr = d === 'postgres' ? 'emb <=> ?::vector' : 'vector_distance_cos(emb, vector(?))';
	const r = await raw.execute({
		sql: `SELECT id, ${distExpr} AS dist FROM node_versions
		      WHERE valid_to = ${FOREVER} AND emb IS NOT NULL ORDER BY dist`,
		args: [JSON.stringify(await embed(query))],
	});
	return r.rows.map((row) => ({ id: String(row.id), dist: Number(row.dist) }));
}

/**
 * The ANN seed list with ties broken deterministically (by distance, then id).
 *
 * `annSeeds` goes through the ANN index, which orders equidistant rows arbitrarily and differently
 * on each call — so a score computed from it moves run to run purely on coin-flips (measured:
 * fused recall swinging 0.72 ↔ 0.76 with no code change). Deterministic tie-breaking is standard
 * practice in retrieval evaluation for exactly this reason: it isolates the quality of the ranking
 * from the engine's arbitrary tie order, so a moved score means a real change.
 *
 * Parity and behavioral tests use `annSeeds` (the real path); scoring uses this.
 */
export async function annSeedsStable(
	raw: DbClient,
	embed: EmbedFn,
	query: string,
	k: number,
): Promise<string[]> {
	const scored = await annScored(raw, embed, query);
	return scored
		.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.slice(0, k)
		.map((s) => s.id);
}

/** {@link fusedSeeds} over the deterministic ANN leg — the fusion input used for scoring. */
export async function fusedSeedsStable(
	raw: DbClient,
	embed: EmbedFn,
	query: string,
	k: number,
): Promise<string[]> {
	const fetchK = k * SEED_MULTIPLIER;
	const lists = [
		await annSeedsStable(raw, embed, query, fetchK),
		await ftsSeeds(raw, query, fetchK),
	];
	return rrf(lists, RRF_K).slice(0, k);
}

/** ANN seed list, best-first. The vector leg on its own. */
export async function annSeeds(
	raw: DbClient,
	embed: EmbedFn,
	query: string,
	k: number,
): Promise<string[]> {
	const r = await raw.execute({
		sql: vecSeedLive(dialectOf(raw)),
		args: [JSON.stringify(await embed(query)), k],
	});
	return r.rows.map((row) => String(row.id));
}

/** Full-text seed list, best-first. The lexical leg on its own. */
export async function ftsSeeds(raw: DbClient, query: string, k: number): Promise<string[]> {
	const d = dialectOf(raw);
	const match = sanitizeMatch(query);
	if (match === null) return [];
	const r = await raw.execute({
		sql: ftsSeedLive(d),
		args: [d === 'postgres' ? query : match, k],
	});
	return r.rows.map((row) => String(row.id));
}

/** The RRF-fused seed list — exactly what `hybridRetrieve` feeds into its walk. */
export async function fusedSeeds(
	raw: DbClient,
	embed: EmbedFn,
	query: string,
	k: number,
): Promise<string[]> {
	const fetchK = k * SEED_MULTIPLIER;
	const lists = [await annSeeds(raw, embed, query, fetchK), await ftsSeeds(raw, query, fetchK)];
	return rrf(lists, RRF_K).slice(0, k);
}

/** ANN seeds expanded through the graph walk — `retrieve`, the vector-only GraphRAG path. */
export async function annWalk(
	raw: DbClient,
	embed: EmbedFn,
	query: string,
	k: number,
	maxDepth: number,
): Promise<string[]> {
	return (await retrieve(raw, embed, { query, k, maxDepth })).map((r) => r.id);
}

/** Fused seeds expanded through the same walk — `hybridRetrieve`, the full path. */
export async function hybridWalk(
	raw: DbClient,
	embed: EmbedFn,
	query: string,
	k: number,
	maxDepth: number,
): Promise<string[]> {
	return (await hybridRetrieve(raw, embed, { query, k, maxDepth })).map((r) => r.id);
}
