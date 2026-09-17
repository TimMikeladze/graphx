import { type DbClient, dialectOf } from './dialect.ts';
import { annSeeds, jsonArrayRows } from './dialect-sql.ts';
import { FOREVER } from './runtime.ts';
import { assertVector, type Embedder, EmbeddingError } from './embedder.ts';
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
import { readEmbeddingMeta } from './schema.ts';
import type { DataOf, NodeType } from './define-graph-schema.ts';
import type { GraphSchema } from './graph.ts';

/**
 * P4 — GraphRAG `retrieve` (§7, corrected; D3/D5), rebuilt on the vector side table.
 *
 * Embed the query, take the nearest vector rows from `node_embeddings` (chunks, grouped to
 * their node by best distance), then run a cycle-safe, depth-bounded recursive walk out from
 * those seeds and return the deduped subgraph — one row per id at its MIN depth, carrying the
 * node's `type`/`data`/`body`, the seed whose walk reached it, and (for seeds) the score.
 *
 * Two temporal paths, divided by the D3 boundary rule:
 *  - **Current-time** (no `asOf`): every row in `node_embeddings` is a live vector, so the
 *    seeds are already live; the walk targets live edges/nodes via `valid_to = FOREVER`.
 *  - **As-of-past** (`asOf` set, `:t < FOREVER`): vectors exist only for live versions, so
 *    over-fetch `k × 4` nearest live rows, keep the ids that have SOME version valid at `:t`,
 *    truncate to `k`; the walk uses the half-open `:t` predicate throughout. Best-effort: a node
 *    that no longer has a live version (retracted) cannot be seeded for a past query.
 *
 * The walk is shared with `hybrid.ts`, which supplies fused seeds instead of vector seeds.
 */

/** Which retrieval legs produced a row. `walk` = reached by expansion, not a seed. */
export type RetrievalVia = 'vector' | 'fts' | 'walk';

/** One node in the retrieved subgraph, typed by the schema. */
export type RetrievedNode<S extends GraphSchema = GraphSchema> = {
	[K in NodeType<S>]: {
		id: string;
		type: K;
		data: DataOf<S, K>;
		body: string | null;
		uri: string | null;
		/** 0 = seed, ≥1 = walked. */
		depth: number;
		/**
		 * Cosine similarity to the query for a vector seed, the RRF score for a hybrid seed,
		 * `null` for a walked row.
		 */
		score: number | null;
		via: RetrievalVia[];
		/** The seed whose walk reached this row (the row's own id for a seed). */
		seed: string;
		/** The best-matching chunk's text when the type is chunked; `null` otherwise. */
		snippet: string | null;
	};
}[NodeType<S>];

/** Options for {@link retrieve}. `asOf` (epoch ms) time-travels; omitted = now. */
export interface RetrieveOpts {
	query: string;
	/** Number of seeds (default 10). */
	k?: number;
	maxDepth?: number;
	direction?: 'forward' | 'reverse' | 'both';
	rels?: string[];
	asOf?: number;
	/** §19.2 governance: row cap, fan-out guard, and fail-safe timeout (M7). */
	limits?: Partial<QueryLimits>;
	/**
	 * P15 (§19.6) observability: when set, feeds the slow-query log (via {@link withTimeout}) and
	 * observes traversal histograms (`graphx_traversal_rows`/`graphx_traversal_depth`).
	 */
	metrics?: MetricsContext;
	/** Read-time upcasting for `data` (P12). `Graph.retrieve` supplies its own registry. */
	upcast?: (type: string, data: Record<string, unknown>) => Record<string, unknown>;
}

/** A seed handed to the walk: where it came from and how well it matched. */
export interface Seed {
	id: string;
	score: number | null;
	via: RetrievalVia[];
	snippet: string | null;
}

/** Over-fetch multiplier for the as-of-past seed path (D5). */
const ASOF_SEED_MULTIPLIER = 4;

function isZeroVector(v: number[]): boolean {
	return v.every((x) => x === 0);
}

/**
 * Refuse to search a namespace that was never initialised with an embedder, or with a different
 * one than the query would be embedded by — a query vector from another model is noise.
 */
export async function requireEmbeddings(
	raw: DbClient,
	embedder: Embedder,
	context: string,
): Promise<void> {
	const meta = await readEmbeddingMeta(raw);
	if (meta === null) {
		throw new EmbeddingError(
			'missing',
			`${context}: this namespace has no embeddings — initialise it with an embedder (init(db, embedder)) and write some nodes`,
		);
	}
	if (meta.model !== embedder.id) {
		throw new EmbeddingError(
			'model',
			`${context}: this namespace is embedded with '${meta.model}' but the query embedder is '${embedder.id}' — run reembed to switch models`,
		);
	}
}

/** Normalize without overflowing/underflowing squares of finite components. */
function unitVector(vector: number[]): number[] {
	let scale = 0;
	for (const value of vector) scale = Math.max(scale, Math.abs(value));
	if (scale === 0) return vector;
	const scaled = vector.map((value) => value / scale);
	const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
	return scaled.map((value) => value / norm);
}

/**
 * Ordinary SQLite exact search. One SELECT snapshots metadata and all chunks together;
 * reading/parsing/ranking costs O(total stored vector components) time and memory,
 * plus O(nodes log nodes) sorting. No vector or SQL math extension is required.
 */
async function sqliteVectorSeedRows(
	raw: DbClient,
	qEmb: number[],
	k: number,
): Promise<Array<{ id: string; dist: number; snippet: string | null }>> {
	const result = await raw.execute(`SELECT e.id, e.chunk, e.text, e.emb, m.value AS dim
FROM graph_meta m LEFT JOIN node_embeddings e ON 1 = 1
WHERE m.key = 'emb_dim'
ORDER BY e.id, e.chunk`);
	const dim = Number(result.rows[0]?.dim);
	if (!Number.isSafeInteger(dim) || dim <= 0) {
		throw new EmbeddingError('dimension', 'SQLite vector search: invalid namespace dimension');
	}
	assertVector(qEmb, dim, 'SQLite query');
	if (isZeroVector(qEmb)) return [];
	const query = unitVector(qEmb);
	const best = new Map<string, { id: string; dist: number; snippet: string | null }>();
	for (const row of result.rows) {
		if (row.id == null) continue; // Empty vector table still returns the metadata row.
		const id = String(row.id);
		let vector: unknown;
		try {
			vector = JSON.parse(String(row.emb));
		} catch {
			throw new EmbeddingError('invalid', `SQLite stored vector ${id}/${row.chunk}: invalid JSON`);
		}
		if (!Array.isArray(vector)) {
			throw new EmbeddingError(
				'invalid',
				`SQLite stored vector ${id}/${row.chunk}: expected a JSON array`,
			);
		}
		assertVector(vector, dim, `SQLite stored vector ${id}/${row.chunk}`);
		const unit = unitVector(vector);
		const similarity = query.reduce((dot, value, i) => dot + value * (unit[i] as number), 0);
		const dist = 1 - Math.max(-1, Math.min(1, similarity));
		const current = best.get(id);
		if (!current || dist < current.dist) {
			best.set(id, { id, dist, snippet: row.text == null ? null : String(row.text) });
		}
	}
	return [...best.values()]
		.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.slice(0, k);
}

/** Nearest vector rows to `qEmb`, grouped to nodes by best distance, best first. */
export async function vectorSeedRows(
	raw: DbClient,
	qEmb: number[],
	k: number,
): Promise<Array<{ id: string; dist: number; snippet: string | null }>> {
	if (k <= 0) return [];
	if (dialectOf(raw) === 'sqlite') return sqliteVectorSeedRows(raw, qEmb, k);
	if (isZeroVector(qEmb)) return [];
	const { sql, bind } = annSeeds(dialectOf(raw));
	// Ask for more rows than nodes wanted: several chunks of one node may all rank near the top.
	const r = await raw.execute({ sql, args: bind(JSON.stringify(qEmb), k * 4) });
	const best = new Map<string, { id: string; dist: number; snippet: string | null }>();
	for (const row of r.rows) {
		const id = String(row.id);
		const dist = Number(row.dist);
		const cur = best.get(id);
		if (!cur || dist < cur.dist) {
			best.set(id, { id, dist, snippet: row.text == null ? null : String(row.text) });
		}
	}
	return [...best.values()].sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1)).slice(0, k);
}

/** The subset of `ids` that has a version valid at `t`, in the order given. */
export async function idsValidAt(raw: DbClient, ids: string[], t: number): Promise<string[]> {
	if (ids.length === 0) return [];
	const r = await raw.execute({
		sql: `SELECT DISTINCT n.id AS id FROM node_versions n
JOIN (${jsonArrayRows(dialectOf(raw))}) s ON s.id = n.id
WHERE n.valid_from <= ? AND ? < n.valid_to`,
		args: [JSON.stringify(ids), t, t],
	});
	const keep = new Set(r.rows.map((row) => String(row.id)));
	return ids.filter((id) => keep.has(id));
}

/**
 * Vector seeds for `query`: the `k` nearest nodes now, or — as-of-past — the `k` nearest live
 * nodes that also existed at `t`. Scores are cosine similarity (`1 − distance`).
 */
export async function vectorSeeds(
	raw: DbClient,
	embedder: Embedder,
	query: string,
	k: number,
	asOf: number | undefined,
): Promise<Seed[]> {
	const qEmb = await embedder.embedOne(query);
	const isPast = asOf !== undefined && asOf < FOREVER;
	const rows = await vectorSeedRows(raw, qEmb, isPast ? k * ASOF_SEED_MULTIPLIER : k);
	let ordered = rows;
	if (isPast) {
		const keep = new Set(
			await idsValidAt(
				raw,
				rows.map((r) => r.id),
				asOf as number,
			),
		);
		ordered = rows.filter((r) => keep.has(r.id)).slice(0, k);
	}
	return ordered.map((r) => ({ id: r.id, score: 1 - r.dist, via: ['vector'], snippet: r.snippet }));
}

/** Build the directional adjacency CTE body (edges stored once; expand fwd/rev/both). */
function adjCte(direction: 'forward' | 'reverse' | 'both', edgePred: string): string {
	const forward = `SELECT src AS a, dst AS b FROM edge_versions WHERE ${edgePred}`;
	const reverse = `SELECT dst AS a, src AS b FROM edge_versions WHERE ${edgePred}`;
	if (direction === 'forward') return forward;
	if (direction === 'reverse') return reverse;
	return `${forward} UNION ALL ${reverse}`;
}

/** §19.6 traversal histograms: observe the subgraph size (fan-out) and max reached depth. */
function observeTraversal(ctx: MetricsContext | undefined, rows: Array<{ depth: number }>): void {
	if (!ctx) return;
	const labels = metricLabels(ctx);
	ctx.sink.observe('graphx_traversal_rows', rows.length, labels);
	ctx.sink.observe(
		'graphx_traversal_depth',
		rows.reduce((m, r) => Math.max(m, r.depth), 0),
		labels,
	);
}

/** What the walk needs beyond the seeds. */
export interface WalkOpts {
	maxDepth: number;
	direction: 'forward' | 'reverse' | 'both';
	rels: string[] | null;
	asOf: number | undefined;
	limits: QueryLimits;
	metrics?: MetricsContext;
	upcast?: (type: string, data: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The §7 cycle-safe, depth-bounded walk from `seeds`. Returns one row per reached id at its
 * MIN depth, ordered by depth then seed rank, with the seed metadata merged onto depth-0 rows.
 * Shared by {@link retrieve} and `hybridRetrieve`.
 */
export async function walk<S extends GraphSchema>(
	raw: DbClient,
	seeds: Seed[],
	opts: WalkOpts,
): Promise<RetrievedNode<S>[]> {
	if (seeds.length === 0) return [];
	const d = dialectOf(raw);
	const isPast = opts.asOf !== undefined && opts.asOf < FOREVER;
	const t = opts.asOf as number;
	const relPred = opts.rels ? ` AND rel IN (${opts.rels.map(() => '?').join(',')})` : '';
	const edgePred = isPast
		? `valid_from <= ? AND ? < valid_to${relPred}`
		: `valid_to = ${FOREVER}${relPred}`;
	const nodePred = (alias: string): string =>
		isPast
			? `${alias}.valid_from <= ? AND ? < ${alias}.valid_to`
			: `${alias}.valid_to = ${FOREVER}`;

	const sql = `
WITH RECURSIVE seeds(id) AS (${jsonArrayRows(d)}),
adj AS (
  ${adjCte(opts.direction, edgePred)}
),
${FANOUT_DEG_CTE},
walk AS (
  SELECT n.id AS id, n.type AS type, n.data AS data, n.body AS body, n.uri AS uri,
         0 AS depth, n.id AS seed, ',' || n.id || ',' AS path
  FROM node_versions n JOIN seeds USING (id)
  WHERE ${nodePred('n')}
  UNION ALL
  SELECT n.id, n.type, n.data, n.body, n.uri, walk.depth + 1, walk.seed, walk.path || n.id || ','
  FROM walk
  JOIN adj ON adj.a = walk.id
  ${fanoutJoin(opts.limits.maxFanout)}
  JOIN node_versions n ON n.id = adj.b AND ${nodePred('n')}
  WHERE walk.depth < ? AND walk.path NOT LIKE '%,' || n.id || ',%'
)
SELECT id, type, data, body, uri, depth, seed FROM (
  SELECT w.id, w.type, w.data, w.body, w.uri, w.depth, w.seed,
         ROW_NUMBER() OVER (PARTITION BY w.id ORDER BY w.depth, w.seed) AS rn
  FROM walk w
) ranked
WHERE rn = 1
ORDER BY depth, id`;

	const args: (string | number)[] = [JSON.stringify(seeds.map((s) => s.id))];
	const sides = opts.direction === 'both' ? 2 : 1;
	for (let i = 0; i < sides; i++) {
		if (isPast) args.push(t, t);
		args.push(...(opts.rels ?? []));
	}
	if (isPast) args.push(t, t, t, t);
	args.push(opts.maxDepth);

	const r = await withTimeout(
		raw.execute({ sql: applyLimit(sql, opts.limits.maxRows), args }),
		opts.limits.timeoutMs,
		opts.metrics,
	);
	const rank = new Map(seeds.map((s, i) => [s.id, i]));
	const byId = new Map(seeds.map((s) => [s.id, s]));
	const rows = r.rows.map((row) => {
		const id = String(row.id);
		const type = String(row.type);
		const raw = JSON.parse(String(row.data)) as Record<string, unknown>;
		const seed = byId.get(id);
		const depth = Number(row.depth);
		return {
			id,
			type,
			data: opts.upcast ? opts.upcast(type, raw) : raw,
			body: row.body === null ? null : String(row.body),
			uri: row.uri === null ? null : String(row.uri),
			depth,
			score: depth === 0 && seed ? seed.score : null,
			via: depth === 0 && seed ? seed.via : ['walk'],
			seed: String(row.seed),
			snippet: depth === 0 && seed ? seed.snippet : null,
		} as RetrievedNode<S>;
	});
	rows.sort(
		(a, b) =>
			a.depth - b.depth ||
			(rank.get(a.seed) ?? 0) - (rank.get(b.seed) ?? 0) ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	observeTraversal(opts.metrics, rows);
	return rows;
}

/**
 * GraphRAG retrieve. Returns the deduped subgraph (one row per id at MIN depth) reachable
 * from the vector seeds within `maxDepth`, ordered by depth then seed rank.
 */
export async function retrieve<S extends GraphSchema = GraphSchema>(
	raw: DbClient,
	embedder: Embedder,
	opts: RetrieveOpts,
): Promise<RetrievedNode<S>[]> {
	await requireEmbeddings(raw, embedder, 'retrieve');
	const k = opts.k ?? 10;
	const seeds = await vectorSeeds(raw, embedder, opts.query, k, opts.asOf);
	return walk<S>(raw, seeds, {
		maxDepth: opts.maxDepth ?? 2,
		direction: opts.direction ?? 'both',
		rels: opts.rels && opts.rels.length > 0 ? opts.rels : null,
		asOf: opts.asOf,
		limits: resolveLimits(opts.limits),
		metrics: opts.metrics,
		upcast: opts.upcast,
	});
}
