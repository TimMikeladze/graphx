import { type DbClient, dialectOf } from './dialect.ts';
import {
	annSeedsAsOf,
	embExtract,
	ftsSeedAsOf,
	ftsSeedLive,
	jsonArrayRows,
	vecSeedLive,
} from './dialect-sql.ts';
import { FOREVER } from './db.ts';
import {
	applyLimit,
	FANOUT_DEG_CTE,
	fanoutJoin,
	type QueryLimits,
	resolveLimits,
	withTimeout,
} from './governance.ts';
import type { EmbedFn, RetrievedNode } from './retrieve.ts';

/**
 * P13 — hybrid retrieval (§19.3–19.4). Fuse an ANN seed list and an FTS5 lexical
 * seed list by Reciprocal Rank Fusion, feed the fused seeds into the SAME cycle-safe,
 * depth-bounded walk P4 uses (§7), then optionally rerank + MMR the expanded
 * candidates before returning top-k.
 *
 * The walk here is a deliberate, self-contained copy of retrieve.ts's §7 walk
 * (seeds injected via `json_each` instead of `vector_top_k`), so P4 stays byte-stable
 * (the task forbids modifying P0–P11 files beyond schema/index). The two temporal
 * paths mirror retrieve.ts exactly:
 *  - **Current-time** (no `asOf`): seeds restricted to LIVE versions
 *    (`valid_to = FOREVER`); walk targets live edges/nodes by the same equality.
 *  - **As-of-past** (`asOf` set, `:t < FOREVER`, D3): vector seeds over-fetch the live
 *    index then keep ids with a version valid at `:t` (mirroring retrieve.ts); lexical
 *    seeds match the version actually valid at `:t`; the walk uses half-open `:t`
 *    predicates throughout.
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
 * Caller-provided reranker (§19.4) — same injection pattern as {@link EmbedFn}. Given
 * the query and the expanded candidate subgraph (in walk order), return a relevance
 * score for each candidate to KEEP. Candidates absent from the returned list are
 * dropped; the survivors are ordered by `score` descending. No local cross-encoder is
 * bundled — bring your own (a cross-encoder call, an LLM judge, etc.).
 */
export type RerankFn = (query: string, candidates: RetrievedNode[]) => Promise<RerankScore[]>;

/**
 * MMR options (§19.4). `k` = final number of results to return after diversification;
 * `lambda` trades relevance (λ→1) against diversity (λ→0), default 0.5.
 */
export interface MmrOpts {
	k: number;
	lambda?: number;
}

/** Options for {@link hybridRetrieve}. Superset of P4's `RetrieveOpts` plus fusion knobs. */
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
 * Reciprocal Rank Fusion over ranked id lists (M5). Each list is already in rank
 * order; the FIRST occurrence of an id in a list is its best (lowest) rank. Fused
 * score = Σ 1/(rrfK + rank_i). Returns ids ordered by fused score descending.
 */
function rrf(lists: string[][], rrfK: number): string[] {
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
	return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** `rel IN (?,…)` fragment + the bound rel args (empty when no rels filter). */
function relFragment(rels: string[] | null): string {
	return rels ? ` AND rel IN (${rels.map(() => '?').join(',')})` : '';
}

/** Directional adjacency body (edges stored once; expand fwd/rev/both), per §7. */
function adjCte(direction: 'forward' | 'reverse' | 'both', edgePred: string): string {
	const forward = `SELECT src AS a, dst AS b FROM edge_versions WHERE ${edgePred}`;
	const reverse = `SELECT dst AS a, src AS b FROM edge_versions WHERE ${edgePred}`;
	if (direction === 'forward') return forward;
	if (direction === 'reverse') return reverse;
	return `${forward} UNION ALL ${reverse}`;
}

/** Fetch the ANN + FTS seed id lists (current-time path), each in rank order. */
async function seedsCurrent(
	raw: DbClient,
	qEmbJson: string,
	query: string,
	match: string | null,
	fetchK: number,
): Promise<string[][]> {
	const d = dialectOf(raw);
	const vec = await raw.execute({ sql: vecSeedLive(d), args: [qEmbJson, fetchK] });
	const vecIds = vec.rows.map((r) => String(r.id));

	let ftsIds: string[] = [];
	if (match !== null) {
		const fts = await raw.execute({
			sql: ftsSeedLive(d),
			args: [d === 'postgres' ? query : match, fetchK],
		});
		ftsIds = fts.rows.map((r) => String(r.id));
	}
	return [vecIds, ftsIds];
}

/** Fetch the ANN + FTS seed id lists (as-of-past path, `:t < FOREVER`), in rank order. */
async function seedsAsOf(
	raw: DbClient,
	qEmbJson: string,
	query: string,
	match: string | null,
	fetchK: number,
	t: number,
): Promise<string[][]> {
	const d = dialectOf(raw);
	// Vector: over-fetch the live index, keep ids that have a version valid at :t, rank
	// (libSQL by the index rowid proxy; Postgres by cosine distance).
	const vec = await raw.execute({
		sql: annSeedsAsOf(d),
		args: [qEmbJson, fetchK, t, t, fetchK],
	});
	const vecIds = vec.rows.map((r) => String(r.id));

	let ftsIds: string[] = [];
	if (match !== null) {
		// Lexical: match the version actually valid at :t (the FTS index covers every
		// version, so this is exact — not best-effort like the live-only ANN leg).
		const fts = await raw.execute({
			sql: ftsSeedAsOf(d),
			args: [d === 'postgres' ? query : match, t, t, fetchK],
		});
		ftsIds = fts.rows.map((r) => String(r.id));
	}
	return [vecIds, ftsIds];
}

/** Run the §7 cycle-safe walk from an explicit fused-seed id list (current-time). */
async function walkCurrent(
	raw: DbClient,
	seedIds: string[],
	direction: 'forward' | 'reverse' | 'both',
	rels: string[] | null,
	maxDepth: number,
	limits: QueryLimits,
): Promise<RetrievedNode[]> {
	const edgePred = `valid_to = ${FOREVER}${relFragment(rels)}`;
	const sql = `
WITH RECURSIVE seeds(id) AS (${jsonArrayRows(dialectOf(raw))}),
adj AS (
  ${adjCte(direction, edgePred)}
),
${FANOUT_DEG_CTE},
walk AS (
  SELECT n.id AS id, n.body AS body, n.uri AS uri, 0 AS depth, ',' || n.id || ',' AS path
  FROM node_versions n JOIN seeds USING (id)
  WHERE n.valid_to = ${FOREVER}
  UNION ALL
  SELECT n.id, n.body, n.uri, walk.depth + 1, walk.path || n.id || ','
  FROM walk
  JOIN adj ON adj.a = walk.id
  ${fanoutJoin(limits.maxFanout)}
  JOIN node_versions n ON n.id = adj.b AND n.valid_to = ${FOREVER}
  WHERE walk.depth < ? AND walk.path NOT LIKE '%,' || n.id || ',%'
)
SELECT id, body, uri, MIN(depth) AS depth FROM walk GROUP BY id, body, uri ORDER BY depth`;

	const args: (string | number)[] = [JSON.stringify(seedIds)];
	const sides = direction === 'both' ? 2 : 1;
	for (let i = 0; i < sides; i++) args.push(...(rels ?? []));
	args.push(maxDepth);
	return rowsToNodes(
		await withTimeout(raw.execute({ sql: applyLimit(sql, limits.maxRows), args }), limits.timeoutMs),
	);
}

/** Run the §7 cycle-safe walk from an explicit fused-seed id list (as-of-past). */
async function walkAsOf(
	raw: DbClient,
	seedIds: string[],
	direction: 'forward' | 'reverse' | 'both',
	rels: string[] | null,
	maxDepth: number,
	t: number,
	limits: QueryLimits,
): Promise<RetrievedNode[]> {
	const edgePred = `valid_from <= ? AND ? < valid_to${relFragment(rels)}`;
	const sql = `
WITH RECURSIVE seeds(id) AS (${jsonArrayRows(dialectOf(raw))}),
adj AS (
  ${adjCte(direction, edgePred)}
),
${FANOUT_DEG_CTE},
walk AS (
  SELECT n.id AS id, n.body AS body, n.uri AS uri, 0 AS depth, ',' || n.id || ',' AS path
  FROM node_versions n JOIN seeds USING (id)
  WHERE n.valid_from <= ? AND ? < n.valid_to
  UNION ALL
  SELECT n.id, n.body, n.uri, walk.depth + 1, walk.path || n.id || ','
  FROM walk
  JOIN adj ON adj.a = walk.id
  ${fanoutJoin(limits.maxFanout)}
  JOIN node_versions n ON n.id = adj.b AND n.valid_from <= ? AND ? < n.valid_to
  WHERE walk.depth < ? AND walk.path NOT LIKE '%,' || n.id || ',%'
)
SELECT id, body, uri, MIN(depth) AS depth FROM walk GROUP BY id, body, uri ORDER BY depth`;

	const args: (string | number)[] = [JSON.stringify(seedIds)];
	const sides = direction === 'both' ? 2 : 1;
	for (let i = 0; i < sides; i++) args.push(t, t, ...(rels ?? []));
	args.push(t, t, t, t, maxDepth);
	return rowsToNodes(
		await withTimeout(raw.execute({ sql: applyLimit(sql, limits.maxRows), args }), limits.timeoutMs),
	);
}

function rowsToNodes(r: { rows: Record<string, unknown>[] }): RetrievedNode[] {
	return r.rows.map((row) => ({
		id: String(row.id),
		body: row.body === null ? null : String(row.body),
		uri: row.uri === null ? null : String(row.uri),
		depth: Number(row.depth),
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

/** Load candidate embeddings (the version valid now / at :t) as JS vectors. */
async function loadEmbeddings(
	raw: DbClient,
	ids: string[],
	isPast: boolean,
	t: number,
): Promise<Map<string, number[]>> {
	const placeholders = ids.map(() => '?').join(',');
	const pred = isPast ? `valid_from <= ? AND ? < valid_to` : `valid_to = ${FOREVER}`;
	const args: (string | number)[] = isPast ? [...ids, t, t] : [...ids];
	const r = await raw.execute({
		sql: `SELECT id, ${embExtract(dialectOf(raw))} AS e
FROM node_versions
WHERE id IN (${placeholders}) AND ${pred} AND emb IS NOT NULL`,
		args,
	});
	const out = new Map<string, number[]>();
	for (const row of r.rows) out.set(String(row.id), JSON.parse(String(row.e)) as number[]);
	return out;
}

/**
 * Greedy MMR (§19.4): iteratively pick the candidate maximizing
 * `λ·rel − (1−λ)·max-cos-sim-to-already-chosen`. `rel` is the rerank score when a
 * reranker ran, else cosine similarity to the query embedding. Drops near-duplicate
 * multi-hop results; returns the chosen `k` in selection order.
 */
function mmrSelect(
	candidates: RetrievedNode[],
	embById: Map<string, number[]>,
	qEmb: number[],
	rerankScore: Map<string, number> | null,
	lambda: number,
	k: number,
): RetrievedNode[] {
	const relOf = (id: string): number =>
		rerankScore ? (rerankScore.get(id) ?? 0) : cosine(qEmb, embById.get(id) ?? []);
	const simOf = (a: string, b: string): number => {
		const ea = embById.get(a);
		const eb = embById.get(b);
		return ea && eb ? cosine(ea, eb) : 0;
	};

	const pool = [...candidates];
	const chosen: RetrievedNode[] = [];
	while (chosen.length < k && pool.length > 0) {
		let bestIdx = 0;
		let bestScore = -Infinity;
		for (let i = 0; i < pool.length; i++) {
			const c = pool[i] as RetrievedNode;
			let maxSim = 0;
			for (const s of chosen) maxSim = Math.max(maxSim, simOf(c.id, s.id));
			const mmr = lambda * relOf(c.id) - (1 - lambda) * maxSim;
			if (mmr > bestScore) {
				bestScore = mmr;
				bestIdx = i;
			}
		}
		chosen.push(pool[bestIdx] as RetrievedNode);
		pool.splice(bestIdx, 1);
	}
	return chosen;
}

/**
 * Hybrid GraphRAG retrieve (§19.3–19.4). Runs the ANN and FTS5 lexical seed lists,
 * fuses them by RRF on the logical ULID `id` (NOT `ver` — M5), expands the fused
 * top-k seeds through the §7 cycle-safe walk, then applies the optional `rerank` and
 * `mmr` post-processors before returning. Drop-in alongside P4's `retrieve`.
 */
export async function hybridRetrieve(
	raw: DbClient,
	embed: EmbedFn,
	opts: HybridRetrieveOpts,
): Promise<RetrievedNode[]> {
	const k = opts.k ?? 10;
	const maxDepth = opts.maxDepth ?? 2;
	const direction = opts.direction ?? 'both';
	const rels = opts.rels && opts.rels.length > 0 ? opts.rels : null;
	const rrfK = opts.rrfK ?? DEFAULT_RRF_K;
	const fetchK = k * SEED_MULTIPLIER;
	const limits = resolveLimits(opts.limits);

	const qEmb = await embed(opts.query);
	const qEmbJson = JSON.stringify(qEmb);
	const match = sanitizeMatch(opts.query);

	const isPast = opts.asOf !== undefined && opts.asOf < FOREVER;
	const t = isPast ? (opts.asOf as number) : FOREVER;

	const lists = isPast
		? await seedsAsOf(raw, qEmbJson, opts.query, match, fetchK, t)
		: await seedsCurrent(raw, qEmbJson, opts.query, match, fetchK);

	const seedIds = rrf(lists, rrfK).slice(0, k);
	if (seedIds.length === 0) return [];

	let candidates = isPast
		? await walkAsOf(raw, seedIds, direction, rels, maxDepth, t, limits)
		: await walkCurrent(raw, seedIds, direction, rels, maxDepth, limits);

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
			isPast,
			t,
		);
		candidates = mmrSelect(candidates, embById, qEmb, rerankScore, opts.mmr.lambda ?? 0.5, opts.mmr.k);
	}

	return candidates;
}
