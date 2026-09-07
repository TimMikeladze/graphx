import { FOREVER, ftsIndexOwner } from '../../src/core/db.ts';
import { dialectOf, type DbClient } from '../../src/core/dialect.ts';
import { embReadExpr, ftsSeedLive } from '../../src/core/dialect-sql.ts';
import type { Embedder } from '../../src/core/embedder.ts';
import { ftsArg, hybridRetrieve, rrf } from '../../src/core/hybrid.ts';
import { retrieve, vectorSeedRows } from '../../src/core/retrieve.ts';

/**
 * The individual retrieval legs, isolated so they can be scored against each other.
 *
 * `hybridRetrieve` fuses the vector and FTS seed lists with RRF, feeds the top-k into the walk,
 * and returns the expanded rows ordered by DEPTH — the fused ranking is used but never surfaced.
 * So an honest ablation has to split in two:
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

function cosineDistance(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] as number) * (b[i] as number);
		na += (a[i] as number) ** 2;
		nb += (b[i] as number) ** 2;
	}
	if (na === 0 || nb === 0) return 1;
	return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Every live document scored against the query, nearest first, with its cosine DISTANCE.
 *
 * Distance is the ground truth a ranking is merely a view over: it is tie-immune, so two engines
 * that disagree about which of two equidistant documents to keep at the cut still have to agree
 * here. Computed exactly in JS over every stored vector rather than through the ANN index.
 */
export async function annScored(
	raw: DbClient,
	embedder: Embedder,
	query: string,
): Promise<{ id: string; dist: number }[]> {
	const q = await embedder.embedOne(query);
	const r = await raw.execute(
		`SELECT e.id AS id, ${embReadExpr(dialectOf(raw))} AS e
		 FROM node_embeddings e JOIN node_versions n ON n.id = e.id
		 WHERE n.valid_to = ${FOREVER} AND e.chunk = 0`,
	);
	return r.rows
		.map((row) => ({
			id: String(row.id),
			dist: cosineDistance(q, JSON.parse(String(row.e)) as number[]),
		}))
		.sort((a, b) => a.dist - b.dist);
}

/**
 * The vector seed list with ties broken deterministically (by distance, then id).
 *
 * `annSeeds` goes through the ANN index, which orders equidistant rows arbitrarily and differently
 * on each call — so a score computed from it moves run to run purely on coin-flips. Deterministic
 * tie-breaking is standard practice in retrieval evaluation for exactly this reason: it isolates
 * the quality of the ranking from the engine's arbitrary tie order, so a moved score means a real
 * change. Parity and behavioral tests use `annSeeds` (the real path); scoring uses this.
 */
export async function annSeedsStable(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	k: number,
): Promise<string[]> {
	const scored = await annScored(raw, embedder, query);
	return scored
		.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.slice(0, k)
		.map((s) => s.id);
}

/** {@link fusedSeeds} over the deterministic vector leg — the fusion input used for scoring. */
export async function fusedSeedsStable(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	k: number,
): Promise<string[]> {
	const fetchK = k * SEED_MULTIPLIER;
	const lists = [
		await annSeedsStable(raw, embedder, query, fetchK),
		await ftsSeeds(raw, query, fetchK),
	];
	return rrf(lists, RRF_K)
		.slice(0, k)
		.map((s) => s.id);
}

/** Vector seed list, best-first, through the real ANN path. The vector leg on its own. */
export async function annSeeds(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	k: number,
): Promise<string[]> {
	const rows = await vectorSeedRows(raw, await embedder.embedOne(query), k);
	return rows.map((r) => r.id);
}

/** Full-text seed list, best-first. The lexical leg on its own. */
export async function ftsSeeds(raw: DbClient, query: string, k: number): Promise<string[]> {
	const d = dialectOf(raw);
	const arg = ftsArg(d, query);
	if (arg === null) return [];
	await ftsIndexOwner(raw)?.ensureFtsFresh();
	const r = await raw.execute({ sql: ftsSeedLive(d), args: [arg, k] });
	return r.rows.map((row) => String(row.id));
}

/** The RRF-fused seed list — exactly what `hybridRetrieve` feeds into its walk. */
export async function fusedSeeds(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	k: number,
): Promise<string[]> {
	const fetchK = k * SEED_MULTIPLIER;
	const lists = [await annSeeds(raw, embedder, query, fetchK), await ftsSeeds(raw, query, fetchK)];
	return rrf(lists, RRF_K)
		.slice(0, k)
		.map((s) => s.id);
}

/** Vector seeds expanded through the graph walk — `retrieve`, the vector-only GraphRAG path. */
export async function annWalk(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	k: number,
	maxDepth: number,
): Promise<string[]> {
	return (await retrieve(raw, embedder, { query, k, maxDepth })).map((r) => r.id);
}

/** Fused seeds expanded through the same walk — `hybridRetrieve`, the full path. */
export async function hybridWalk(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	k: number,
	maxDepth: number,
): Promise<string[]> {
	return (await hybridRetrieve(raw, embedder, { query, k, maxDepth })).map((r) => r.id);
}
