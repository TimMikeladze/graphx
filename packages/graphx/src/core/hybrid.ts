import { assertNever, type DbClient, type Dialect, dialectOf } from './dialect.ts';
import { embReadExpr, ftsSeedAsOf, ftsSeedLive } from './dialect-sql.ts';
import { FOREVER, ftsIndexOwner } from './runtime.ts';
import type { Embedder } from './embedder.ts';
import { tokenize } from './fts/tokenize.ts';
import type { QueryLimits } from './governance.ts';
import { resolveLimits } from './governance.ts';
import type { GraphSchema } from './graph.ts';
import {
	idsValidAt,
	requireEmbeddings,
	type RetrievedNode,
	type Seed,
	vectorSeedRows,
	walk,
} from './retrieve.ts';

/**
 * P13 — hybrid retrieval (§19.3–19.4). Fuse a vector seed list and a full-text seed list by
 * Reciprocal Rank Fusion, feed the fused seeds into the SAME cycle-safe, depth-bounded walk
 * `retrieve` uses (§7), then optionally rerank + MMR the expanded candidates before returning.
 *
 * The two temporal paths mirror `retrieve.ts`:
 *  - **Current-time** (no `asOf`): both seed lists are live; the walk targets live rows.
 *  - **As-of-past** (`asOf` set, `:t < FOREVER`, D3): vector seeds over-fetch the live vectors
 *    and keep ids with a version valid at `:t`; lexical seeds match the version actually valid
 *    at `:t` (the FTS index covers every version); the walk uses half-open `:t` predicates.
 */

/** RRF constant — the `60` in `score = Σ 1/(60 + rank_i)` (§19.3). */
const DEFAULT_RRF_K = 60;
/** Over-fetch multiplier for each seed list before fusion. */
const SEED_MULTIPLIER = 4;

/** A per-candidate relevance score returned by a caller-supplied {@link RerankFn}. */
export interface RerankScore {
	id: string;
	score: number;
}

/**
 * Caller-provided reranker (§19.4). Given the query and the expanded candidate subgraph (in
 * walk order), return a relevance score for each candidate to KEEP. Candidates absent from
 * the returned list are dropped; the survivors are ordered by `score` descending. No local
 * cross-encoder is bundled — bring your own (a cross-encoder call, an LLM judge, etc.).
 */
export type RerankFn = (query: string, candidates: RerankCandidate[]) => Promise<RerankScore[]>;

/** What a reranker reads of a candidate. Every schema's `RetrievedNode` is one. */
export type RerankCandidate = Omit<RetrievedNode, 'type' | 'data'> & {
	type: string;
	data: unknown;
};

/**
 * MMR options (§19.4). `k` = final number of results to return after diversification;
 * `lambda` trades relevance (λ→1) against diversity (λ→0), default 0.5.
 */
export interface MmrOpts {
	k: number;
	lambda?: number;
}

/** Options for {@link hybridRetrieve}. Superset of `RetrieveOpts` plus fusion knobs. */
export interface HybridRetrieveOpts {
	query: string;
	/** Number of fused seeds fed into the walk (default 10). */
	k?: number;
	maxDepth?: number;
	direction?: 'forward' | 'reverse' | 'both';
	rels?: string[];
	asOf?: number;
	/** RRF constant (default 60). */
	rrfK?: number;
	/** Optional cross-encoder/LLM rerank of the expanded candidates (§19.4). */
	rerank?: RerankFn;
	/** Optional MMR diversification of the expanded candidates (§19.4). */
	mmr?: MmrOpts;
	/** §19.2 governance: row cap, fan-out guard, and fail-safe timeout (M7). */
	limits?: Partial<QueryLimits>;
	/** Read-time upcasting for `data` (P12). `Graph.hybridRetrieve` supplies its own registry. */
	upcast?: (type: string, data: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Sanitize free user text into a safe FTS5 MATCH expression (M3). FTS5 has its own
 * query grammar (`AND`/`OR`/`NOT`/`NEAR`, `*`, `^`, `:`, `"`, `-`, parentheses); raw
 * user input would either inject operators or error on a syntax slip (e.g. an
 * unbalanced quote). Policy: split on whitespace, wrap each token as a quoted FTS5
 * string (doubling embedded `"`), and join with `OR` for recall. Quoting demotes every
 * operator to a literal term, so nothing the user types can change the query shape.
 * Returns `null` for empty/whitespace-only input (caller skips the lexical leg).
 */
export function sanitizeMatch(query: string): string | null {
	const tokens = query
		.split(/\s+/)
		.filter((t) => t.length > 0)
		.map((t) => `"${t.replace(/"/g, '""')}"`);
	return tokens.length > 0 ? tokens.join(' OR ') : null;
}

/**
 * The bound argument every full-text fragment expects, for the dialect in hand. `null` when
 * the query has no usable tokens — the caller skips the lexical leg rather than running a
 * match guaranteed to return nothing.
 *
 * This exists because the three dialects want three different things from the same user text:
 * libSQL an FTS5 expression, Postgres the raw text (its `tsquery` is built in SQL), DuckDB a
 * JSON array of tokens. "Has usable tokens" is judged by the shared {@link tokenize} — the
 * same test every dialect's index is built with — so all three dialects agree on which inputs
 * are empty, even though only DuckDB's argument is literally the token list.
 */
export function ftsArg(dialect: Dialect, query: string): string | null {
	if (tokenize(query).length === 0) return null;
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return sanitizeMatch(query);
		case 'postgres':
			// tsQueryOr parses the raw text itself; pre-tokenizing would double the work and
			// throw away the dictionary's own stopword handling.
			return query;
		case 'duckdb':
			// No grammar to inject into: operators tokenize to ordinary terms.
			return JSON.stringify(tokenize(query));
		default:
			return assertNever(dialect, 'ftsArg');
	}
}

/**
 * Reciprocal Rank Fusion over ranked id lists (M5). Each list is already in rank
 * order; the FIRST occurrence of an id in a list is its best (lowest) rank. Fused
 * score = Σ 1/(rrfK + rank_i). Returns ids ordered by fused score descending, with the score.
 *
 * Exported for retrieval evaluation, which scores the fused seed order directly.
 */
export function rrf(lists: string[][], rrfK: number): Array<{ id: string; score: number }> {
	const score = new Map<string, number>();
	for (const list of lists) {
		const seen = new Set<string>();
		for (let i = 0; i < list.length; i++) {
			const id = list[i] as string;
			if (seen.has(id)) continue; // best rank per id within a list
			seen.add(id);
			score.set(id, (score.get(id) ?? 0) + 1 / (rrfK + (i + 1)));
		}
	}
	return [...score.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.map(([id, s]) => ({ id, score: s }));
}

/** Full-text seed ids for `query`, best first (live or as-of). Empty when the query has no tokens. */
export async function ftsSeedIds(
	raw: DbClient,
	query: string,
	fetchK: number,
	asOf: number | undefined,
): Promise<string[]> {
	const d = dialectOf(raw);
	const arg = ftsArg(d, query);
	if (arg === null) return [];
	await ftsIndexOwner(raw)?.ensureFtsFresh();
	const isPast = asOf !== undefined && asOf < FOREVER;
	const r = isPast
		? await raw.execute({
				sql: ftsSeedAsOf(d),
				args: [arg, asOf as number, asOf as number, fetchK],
			})
		: await raw.execute({ sql: ftsSeedLive(d), args: [arg, fetchK] });
	return r.rows.map((row) => String(row.id));
}

/** Both seed lists in rank order, plus the vector rows' snippets for the fused seeds. */
export async function hybridSeedLists(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	fetchK: number,
	asOf: number | undefined,
): Promise<{ vec: string[]; fts: string[]; snippets: Map<string, string | null>; qEmb: number[] }> {
	const qEmb = await embedder.embedOne(query);
	const isPast = asOf !== undefined && asOf < FOREVER;
	let vecRows = await vectorSeedRows(raw, qEmb, isPast ? fetchK * SEED_MULTIPLIER : fetchK);
	if (isPast) {
		const keep = new Set(
			await idsValidAt(
				raw,
				vecRows.map((r) => r.id),
				asOf as number,
			),
		);
		vecRows = vecRows.filter((r) => keep.has(r.id)).slice(0, fetchK);
	}
	const fts = await ftsSeedIds(raw, query, fetchK, asOf);
	return {
		vec: vecRows.map((r) => r.id),
		fts,
		snippets: new Map(vecRows.map((r) => [r.id, r.snippet])),
		qEmb,
	};
}

/** Fused seeds: RRF over both lists, truncated to `k`, tagged with the legs that ranked them. */
export function fuseSeeds(
	vec: string[],
	fts: string[],
	rrfK: number,
	k: number,
	snippets: Map<string, string | null>,
): Seed[] {
	const inVec = new Set(vec);
	const inFts = new Set(fts);
	return rrf([vec, fts], rrfK)
		.slice(0, k)
		.map(({ id, score }) => ({
			id,
			score,
			via: [
				...(inVec.has(id) ? (['vector'] as const) : []),
				...(inFts.has(id) ? (['fts'] as const) : []),
			],
			snippet: snippets.get(id) ?? null,
		}));
}

function cosine(a: number[], b: number[]): number {
	// Guard missing/mismatched vectors (e.g. a candidate with no stored embedding) so
	// the result is a clean 0, never NaN — NaN would poison every MMR comparison.
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Load candidates' first-chunk vectors as JS arrays (for MMR). */
async function loadEmbeddings(raw: DbClient, ids: string[]): Promise<Map<string, number[]>> {
	const out = new Map<string, number[]>();
	for (let i = 0; i < ids.length; i += 400) {
		const part = ids.slice(i, i + 400);
		const r = await raw.execute({
			sql: `SELECT id, ${embReadExpr(dialectOf(raw))} AS e
FROM node_embeddings
WHERE chunk = 0 AND id IN (${part.map(() => '?').join(',')})`,
			args: part,
		});
		for (const row of r.rows) out.set(String(row.id), JSON.parse(String(row.e)) as number[]);
	}
	return out;
}

/**
 * Greedy MMR (§19.4): iteratively pick the candidate maximizing
 * `λ·rel − (1−λ)·max-cos-sim-to-already-chosen`. `rel` is the rerank score when a
 * reranker ran, else cosine similarity to the query embedding. Drops near-duplicate
 * multi-hop results; returns the chosen `k` in selection order.
 */
function mmrSelect<S extends GraphSchema>(
	candidates: RetrievedNode<S>[],
	embById: Map<string, number[]>,
	qEmb: number[],
	rerankScore: Map<string, number> | null,
	lambda: number,
	k: number,
): RetrievedNode<S>[] {
	const relOf = (id: string): number =>
		rerankScore ? (rerankScore.get(id) ?? 0) : cosine(qEmb, embById.get(id) ?? []);
	const simOf = (a: string, b: string): number => {
		const ea = embById.get(a);
		const eb = embById.get(b);
		return ea && eb ? cosine(ea, eb) : 0;
	};

	const pool = [...candidates];
	const chosen: RetrievedNode<S>[] = [];
	while (chosen.length < k && pool.length > 0) {
		let bestIdx = 0;
		let bestScore = -Infinity;
		for (let i = 0; i < pool.length; i++) {
			const c = pool[i] as RetrievedNode<S>;
			let maxSim = 0;
			for (const s of chosen) maxSim = Math.max(maxSim, simOf(c.id, s.id));
			const mmr = lambda * relOf(c.id) - (1 - lambda) * maxSim;
			if (mmr > bestScore) {
				bestScore = mmr;
				bestIdx = i;
			}
		}
		chosen.push(pool[bestIdx] as RetrievedNode<S>);
		pool.splice(bestIdx, 1);
	}
	return chosen;
}

/**
 * Hybrid GraphRAG retrieve (§19.3–19.4). Runs the vector and full-text seed lists, fuses them
 * by RRF on the logical ULID `id` (NOT `ver` — M5), expands the fused top-k seeds through the
 * §7 cycle-safe walk, then applies the optional `rerank` and `mmr` post-processors.
 */
export async function hybridRetrieve<S extends GraphSchema = GraphSchema>(
	raw: DbClient,
	embedder: Embedder,
	opts: HybridRetrieveOpts,
): Promise<RetrievedNode<S>[]> {
	await requireEmbeddings(raw, embedder, 'hybridRetrieve');
	const k = opts.k ?? 10;
	const rrfK = opts.rrfK ?? DEFAULT_RRF_K;
	const fetchK = k * SEED_MULTIPLIER;

	const { vec, fts, snippets, qEmb } = await hybridSeedLists(
		raw,
		embedder,
		opts.query,
		fetchK,
		opts.asOf,
	);
	const seeds = fuseSeeds(vec, fts, rrfK, k, snippets);
	if (seeds.length === 0) return [];

	let candidates = await walk<S>(raw, seeds, {
		maxDepth: opts.maxDepth ?? 2,
		direction: opts.direction ?? 'both',
		rels: opts.rels && opts.rels.length > 0 ? opts.rels : null,
		asOf: opts.asOf,
		limits: resolveLimits(opts.limits),
		upcast: opts.upcast,
	});

	let rerankScore: Map<string, number> | null = null;
	if (opts.rerank) {
		const scores = await opts.rerank(opts.query, candidates);
		rerankScore = new Map(scores.map((s) => [s.id, s.score]));
		candidates = candidates
			.filter((c) => rerankScore?.has(c.id))
			.sort((a, b) => (rerankScore?.get(b.id) ?? 0) - (rerankScore?.get(a.id) ?? 0));
	}

	if (opts.mmr && candidates.length > 0) {
		const embById = await loadEmbeddings(
			raw,
			candidates.map((c) => c.id),
		);
		candidates = mmrSelect(
			candidates,
			embById,
			qEmb,
			rerankScore,
			opts.mmr.lambda ?? 0.5,
			opts.mmr.k,
		);
	}

	return candidates;
}
