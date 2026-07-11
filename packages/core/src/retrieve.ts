import { type DbClient, dialectOf } from './dialect.ts';
import { annSeedsAsOf, annSeedsLive } from './dialect-sql.ts';
import { FOREVER } from './db.ts';
import {
	applyLimit,
	FANOUT_DEG_CTE,
	fanoutJoin,
	type MetricsContext,
	metricLabels,
	type QueryLimits,
	resolveLimits,
	withTimeout,
} from './governance.ts';

/**
 * P4 — vectors + GraphRAG `retrieve` (§7, corrected; D3/D5).
 *
 * Embed the query, ANN-seed off the partial live vector index `nv_emb_idx`, then
 * run a cycle-safe, depth-bounded recursive walk over the graph and return the
 * deduped subgraph (one row per id, at its MIN depth, ordered by depth).
 *
 * Two paths, divided by the D3 boundary rule:
 *  - **Current-time** (no `asOf`): `nv_emb_idx` is partial over LIVE rows
 *    (`valid_to = FOREVER`), so the ANN seeds are already live; the walk targets
 *    live edges/nodes via the `valid_to = FOREVER` equality.
 *  - **As-of-past** (`asOf` set, `:t < FOREVER`): the live index can't see past
 *    rows, so over-fetch `k × 4` from it (D5), temporal-filter the seeds to the
 *    versions valid at `:t` (`valid_from <= :t AND :t < valid_to`), dedup by id,
 *    truncate to `k`; the walk uses the half-open `:t` predicate throughout.
 *    Best-effort: a node whose embedding is no longer in the live index (its live
 *    version was archived/re-embedded) can't be seeded for a past query.
 */

/** Caller-provided embedder: text → dense vector (§3). */
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * A deterministic, model-free embedder for dev / tests / demos: a hashed bag-of-tokens vector of
 * width `dim`. Same text → same vector; texts sharing tokens share dimensions, so `retrieve` /
 * `hybridRetrieve` return sensible neighbors with NO embedding model, API key, or network. It is
 * lexical, not semantic — swap in a real model for production. `dim` defaults to 768 (the same
 * default as {@link init}'s vector width), so `hashEmbed()` and `init(client)` line up with zero
 * dimension bookkeeping.
 */
export function hashEmbed(dim = 768): EmbedFn {
	return (text: string) => {
		const v = Array.from({ length: dim }, () => 0);
		for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
			let h = 0;
			for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
			const idx = h % dim;
			v[idx] = (v[idx] ?? 0) + 1;
		}
		return Promise.resolve(v);
	};
}

/**
 * Probe an embedder for its output dimension (embeds one tiny constant). Use it to line `init`'s
 * vector width up with the model instead of hardcoding a number that must be kept in sync — a
 * mismatch silently rejects every insert (dimension error). The width is fixed per model, so one
 * probe is authoritative.
 */
export async function dimOf(embed: EmbedFn): Promise<number> {
	return (await embed('graphx')).length;
}

/** Options for {@link retrieve}. `asOf` (epoch ms) time-travels; omitted = now. */
export interface RetrieveOpts {
	query: string;
	k?: number;
	maxDepth?: number;
	direction?: 'forward' | 'reverse' | 'both';
	rels?: string[];
	asOf?: number;
	/** §19.2 governance: row cap, fan-out guard, and fail-safe timeout (M7). */
	limits?: Partial<QueryLimits>;
	/**
	 * P15 (§19.6) observability: when set, feeds the slow-query log (via {@link withTimeout}) and
	 * observes traversal histograms (`graphx_traversal_rows`/`graphx_traversal_depth`). Omit ⇒ no
	 * metrics, zero overhead (pre-P15 behavior).
	 */
	metrics?: MetricsContext;
}

/** §19.6 traversal histograms: observe the subgraph size (fan-out) and max reached depth. */
function observeTraversal(ctx: MetricsContext | undefined, rows: RetrievedNode[]): void {
	if (!ctx) return;
	const labels = metricLabels(ctx);
	ctx.sink.observe('graphx_traversal_rows', rows.length, labels);
	ctx.sink.observe(
		'graphx_traversal_depth',
		rows.reduce((m, r) => Math.max(m, r.depth), 0),
		labels,
	);
}

/** One node in the retrieved subgraph. `depth` 0 = ANN seed, ≥1 = walked. */
export interface RetrievedNode {
	id: string;
	body: string | null;
	uri: string | null;
	depth: number;
}

/** Over-fetch multiplier for the as-of-past seed path (D5). */
const ASOF_SEED_MULTIPLIER = 4;

/**
 * Build the directional adjacency CTE body. Edges are stored ONCE; `direction`
 * selects which way(s) to expand: forward src→dst, reverse dst→src, both = the
 * union of the two. `edgePred` carries the temporal/live predicate and any
 * `rel IN (...)` filter (param-bound by the caller).
 */
function adjCte(direction: 'forward' | 'reverse' | 'both', edgePred: string): string {
	const forward = `SELECT src AS a, dst AS b FROM edge_versions WHERE ${edgePred}`;
	const reverse = `SELECT dst AS a, src AS b FROM edge_versions WHERE ${edgePred}`;
	if (direction === 'forward') return forward;
	if (direction === 'reverse') return reverse;
	return `${forward} UNION ALL ${reverse}`;
}

/**
 * GraphRAG retrieve. Returns the deduped subgraph (one row per id at MIN depth)
 * reachable from the ANN seeds within `maxDepth`, ordered by depth.
 */
export async function retrieve(
	raw: DbClient,
	embed: EmbedFn,
	opts: RetrieveOpts,
): Promise<RetrievedNode[]> {
	const qEmb = await embed(opts.query);
	const k = opts.k ?? 10;
	const maxDepth = opts.maxDepth ?? 2;
	const direction = opts.direction ?? 'both';
	const rels = opts.rels && opts.rels.length > 0 ? opts.rels : null;
	const qEmbJson = JSON.stringify(qEmb);
	const limits = resolveLimits(opts.limits);
	const d = dialectOf(raw);

	const isPast = opts.asOf !== undefined && opts.asOf < FOREVER;

	if (isPast) {
		// As-of-past: :t < FOREVER → half-open predicates everywhere (D3). Seeds:
		// over-fetch from the live index, temporal-filter, dedup by id, truncate to k.
		const t = opts.asOf as number;
		const edgePred = `valid_from <= ? AND ? < valid_to`;
		// `adj` uses un-aliased edge_versions, so build the rel filter without a prefix.
		const relPredAdj = rels ? ` AND rel IN (${rels.map(() => '?').join(',')})` : '';

		// vector_top_k returns LIVE rowids (the index is partial over live rows); the
		// live row's *logical id* is what we keep. We then walk the version of that id
		// valid at :t — which may be an OLDER version than the one the index seeded.
		// Restrict seeds to ids that actually have a version valid at :t. Rank by the
		// index rowid (proxy for ANN rank), dedup by id, truncate to k.
		const sql = `
WITH RECURSIVE seeds AS (${annSeedsAsOf(d)}
),
adj AS (
  ${adjCte(direction, edgePred + relPredAdj)}
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

		// Param order = textual SQL order.
		const args: (string | number)[] = [
			qEmbJson, // seeds: vector(?)
			k * ASOF_SEED_MULTIPLIER, // seeds: vector_top_k k (over-fetch)
			t, // seeds: valid_from <= ?
			t, // seeds: ? < valid_to
			k, // seeds: LIMIT ?
		];
		// adj edge predicate params (forward + reverse if both); each side: t, t, ...rels
		const adjSides = direction === 'both' ? 2 : 1;
		for (let i = 0; i < adjSides; i++) {
			args.push(t, t, ...(rels ?? []));
		}
		args.push(
			t, // walk base: valid_from <= ?
			t, // walk base: ? < valid_to
			t, // walk recursive: valid_from <= ?
			t, // walk recursive: ? < valid_to
			maxDepth, // walk recursive: depth < ?
		);

		const r = await withTimeout(
			raw.execute({ sql: applyLimit(sql, limits.maxRows), args }),
			limits.timeoutMs,
			opts.metrics,
		);
		const rows = r.rows.map((row) => ({
			id: String(row.id),
			body: row.body === null ? null : String(row.body),
			uri: row.uri === null ? null : String(row.uri),
			depth: Number(row.depth),
		}));
		observeTraversal(opts.metrics, rows);
		return rows;
	}

	// Current-time: the live partial index already returns only live rows (D3/D5);
	// walk targets live edges/nodes via the valid_to = FOREVER equality.
	const edgePredLive = `valid_to = ${FOREVER}`;
	const relPredAdj = rels ? ` AND rel IN (${rels.map(() => '?').join(',')})` : '';

	const sql = `
WITH RECURSIVE seeds AS (${annSeedsLive(d)}
),
adj AS (
  ${adjCte(direction, edgePredLive + relPredAdj)}
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

	const args: (string | number)[] = [qEmbJson, k];
	const adjSides = direction === 'both' ? 2 : 1;
	for (let i = 0; i < adjSides; i++) {
		args.push(...(rels ?? []));
	}
	args.push(maxDepth);

	const r = await withTimeout(
		raw.execute({ sql: applyLimit(sql, limits.maxRows), args }),
		limits.timeoutMs,
		opts.metrics,
	);
	const rows = r.rows.map((row) => ({
		id: String(row.id),
		body: row.body === null ? null : String(row.body),
		uri: row.uri === null ? null : String(row.uri),
		depth: Number(row.depth),
	}));
	observeTraversal(opts.metrics, rows);
	return rows;
}
