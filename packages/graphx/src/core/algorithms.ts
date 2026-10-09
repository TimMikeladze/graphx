import { type DbClient, dialectOf } from './dialect.ts';
import { isLive, resolveSlice, slicePredicate, type TimeSlice } from './temporal.ts';

/**
 * P8 — graph algorithms (§11; D3/D4, B8/B9/B10, M15/M17).
 *
 * Three capabilities over the temporal store:
 *  - **CSR mirror** — `buildCSR` (live `edges` view) / `snapshotCSR(t)` (half-open
 *    over `edge_versions`, D3). The node universe is the deterministic ascending
 *    scan of live node ids, giving the B8 dense-int dictionary `idToIdx`/`idxToId`.
 *    Every result is translated back to ULID ids. CSR is a SNAPSHOT (M15): the
 *    caller rebuilds after `sync()` — it does not track live mutations.
 *  - **shortestPath** — `mode:'memory'` (Dijkstra/A* over the CSR with a binary
 *    heap) or `mode:'sql'` (priority-queue recursive CTE, cycle-safe, optional
 *    depth bound M17, `LIMIT 1` on target). Both are correct for NON-NEGATIVE
 *    weights only (B9) and, unbounded, agree on the optimum; sql-mode enumerates
 *    simple paths (cycle-guard-terminated) so it is intended for small graphs,
 *    memory-mode for scale. A caller-supplied `maxDepth` makes sql-mode return only
 *    paths within that many hops (possibly suboptimal or null beyond it).
 *  - **analytics** — `pagerank` (power iteration), `community` (label propagation),
 *    `centrality` (degree). Each UPSERTs into the `node_analytics` side table (D4);
 *    `topNodes` JOINs it with the live `nodes` view and orders by the metric.
 */

/** Compressed-sparse-row adjacency snapshot + the B8 ULID↔dense-int dictionary. */
export interface CSR {
	/** Node count = dictionary size. */
	n: number;
	/** Length `n + 1`; node `u`'s out-edges are `targets[offsets[u] .. offsets[u+1])`. */
	offsets: Int32Array;
	/** Dense-int destination indices, grouped by source. Length = edge count. */
	targets: Int32Array;
	/** Edge weights, parallel to `targets`. */
	weights: Float32Array;
	/** ULID id → dense int. */
	idToIdx: Map<string, number>;
	/** Dense int → ULID id (ascending-by-id, deterministic). */
	idxToId: string[];
	/** The time slice this CSR mirrors; `{}` is the live graph. */
	slice: { asOf?: number; recordedAsOf?: number };
}

/** One out-neighbor of a CSR node: dense index, ULID id, and edge weight. */
export interface CsrNeighbor {
	to: number;
	id: string;
	weight: number;
}

/** Options for {@link shortestPath}. */
export interface ShortestPathOpts {
	/** Sum edge weights (default) vs. count hops (`false`). */
	weighted?: boolean;
	/** `'memory'` (CSR + heap, default) or `'sql'` (recursive CTE). */
	mode?: 'sql' | 'memory';
	/** Restrict to these relation types. */
	rels?: string[];
	/** A* heuristic `id → estimated remaining cost` (memory mode; must be admissible). */
	heuristic?: (id: string) => number;
	/**
	 * Optional sql-mode depth bound (M17 safety knob). When set, sql-mode considers
	 * only paths within this many hops and may return a SUBOPTIMAL path — or null —
	 * for a `dst` whose true shortest path is longer. Unset = unbounded (terminates
	 * via the cycle guard) and agrees with memory mode.
	 */
	maxDepth?: number;
	/** Route over the graph as of this instant (epoch ms) instead of the live graph. */
	asOf?: number;
	/** What graphx believed at this instant (recorded time, epoch ms). Omit ⇒ current beliefs. */
	recordedAsOf?: number;
	/** Route through nodes of these types only (memory mode). */
	types?: string[];
}

/** A shortest path: ULID ids `src..dst` and the total cost. */
export interface ShortestPathResult {
	path: string[];
	cost: number;
}

/** Options for {@link pagerank}. */
export interface PageRankOpts {
	damping?: number;
	tol?: number;
	maxIter?: number;
	/** Run over only these rels' edges (default: every rel). Every live node still gets a score. */
	rels?: string[];
	/** Score the graph as of this instant (epoch ms). An `asOf` run is returned, not persisted. */
	asOf?: number;
	/** What graphx believed at this instant (recorded time, epoch ms). Omit ⇒ current beliefs. */
	recordedAsOf?: number;
	/** Over nodes of these types only (default: every type). Other nodes get no score. */
	types?: string[];
}

/** Options for {@link community}. */
export interface CommunityOpts {
	maxIter?: number;
	/** Group over only these rels' edges (default: every rel). */
	rels?: string[];
	/** Group the graph as of this instant (epoch ms). An `asOf` run is returned, not persisted. */
	asOf?: number;
	/** What graphx believed at this instant (recorded time, epoch ms). Omit ⇒ current beliefs. */
	recordedAsOf?: number;
	/** Over nodes of these types only (default: every type). Other nodes get no score. */
	types?: string[];
}

/** Options for {@link centrality}. */
export interface CentralityOpts {
	/** Count only these rels' edges (default: every rel). */
	rels?: string[];
	/** Count over the graph as of this instant (epoch ms). An `asOf` run is returned, not persisted. */
	asOf?: number;
	/** What graphx believed at this instant (recorded time, epoch ms). Omit ⇒ current beliefs. */
	recordedAsOf?: number;
	/** Over nodes of these types only (default: every type). Other nodes get no score. */
	types?: string[];
}

/** Options for {@link betweenness}. */
export interface BetweennessOpts {
	/** Over only these rels' edges (default: every rel). */
	rels?: string[];
	/** Shortest paths by summed edge weight (default) or by hop count (`false`). */
	weighted?: boolean;
	/**
	 * Brandes from this many sampled sources instead of every node, scaled up by `n / samples`
	 * — the usual estimate for large graphs. Default: every node (exact).
	 */
	samples?: number;
	/** Seed for the source sample, so a sampled run is reproducible. Default 1. */
	seed?: number;
	/** Over the graph as of this instant (epoch ms). An `asOf` run is returned, not persisted. */
	asOf?: number;
	/** What graphx believed at this instant (recorded time, epoch ms). Omit ⇒ current beliefs. */
	recordedAsOf?: number;
	/** Over nodes of these types only (default: every type). Other nodes get no score. */
	types?: string[];
}

/** Centrality flavor. All persist to the `node_analytics.degree` column. */
export type CentralityKind = 'degree' | 'in' | 'out';

/** A persisted analytics metric, orderable by {@link topNodes}. */
export type Metric = 'pagerank' | 'community' | 'degree';

/**
 * A metric orderable by {@link topNodes}: a built-in analytic, or `score:<name>` for a score
 * written with {@link persistScores} (e.g. a Jev-judged dimension from `graphx/jev`).
 */
export type TopNodesMetric = Metric | `score:${string}`;

/** Options for {@link topNodes}. `by` orders the result; `type` filters node type. */
export interface TopNodesOpts {
	by: TopNodesMetric;
	type?: string;
	limit?: number;
}

/** One `topNodes` row: a live node plus its persisted analytics (null if uncomputed). */
export interface TopNode {
	id: string;
	type: string;
	pagerank: number | null;
	community: number | null;
	degree: number | null;
	/** The `score:<name>` value when ordered by one; `null` for a built-in metric. */
	score: number | null;
}

// ---------------------------------------------------------------------------
// CSR mirror
// ---------------------------------------------------------------------------

/**
 * Load a CSR for the live graph (`t = null`) or for the instant `t` (half-open).
 * The node universe is the ascending scan of live node ids (deterministic → stable
 * dense indices, B8); edges whose endpoints are not both live are skipped.
 */
async function loadCSR(
	raw: DbClient,
	slice: TimeSlice,
	rels: string[] | null,
	types: string[] | null = null,
): Promise<CSR> {
	const relIn = rels ? ` AND rel IN (${rels.map(() => '?').join(',')})` : '';
	const typeIn = types ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
	let nodeRows: Array<{ id: unknown }>;
	let edgeRows: Array<{ src: unknown; dst: unknown; weight: unknown }>;
	if (isLive(slice)) {
		nodeRows = (
			await raw.execute({
				sql: `SELECT id FROM nodes WHERE 1 = 1${typeIn} ORDER BY id`,
				args: types ?? [],
			})
		).rows as never;
		edgeRows = (
			await raw.execute({
				sql: `SELECT src, dst, weight FROM edges WHERE 1 = 1${relIn} ORDER BY src, dst`,
				args: rels ?? [],
			})
		).rows as never;
	} else {
		const pred = slicePredicate('', slice);
		nodeRows = (
			await raw.execute({
				sql: `SELECT id FROM node_versions WHERE ${pred.sql}${typeIn} ORDER BY id`,
				args: [...pred.args, ...(types ?? [])],
			})
		).rows as never;
		edgeRows = (
			await raw.execute({
				sql: `SELECT src, dst, weight FROM edge_versions WHERE ${pred.sql}${relIn} ORDER BY src, dst`,
				args: [...pred.args, ...(rels ?? [])],
			})
		).rows as never;
	}

	const idxToId: string[] = nodeRows.map((r) => String(r.id));
	const idToIdx = new Map<string, number>();
	for (let i = 0; i < idxToId.length; i++) idToIdx.set(idxToId[i] ?? '', i);
	const n = idxToId.length;

	const es: Array<{ s: number; d: number; w: number }> = [];
	for (const r of edgeRows) {
		const s = idToIdx.get(String(r.src));
		const d = idToIdx.get(String(r.dst));
		if (s === undefined || d === undefined) continue; // dangling endpoint (not live)
		es.push({ s, d, w: Number(r.weight) });
	}
	const m = es.length;

	const offsets = new Int32Array(n + 1);
	for (const e of es) offsets[e.s + 1] = (offsets[e.s + 1] ?? 0) + 1; // out-degree count
	for (let i = 0; i < n; i++) offsets[i + 1] = (offsets[i + 1] ?? 0) + (offsets[i] ?? 0); // prefix sum
	const targets = new Int32Array(m);
	const weights = new Float32Array(m);
	const cursor = Int32Array.from(offsets);
	for (const e of es) {
		const pos = cursor[e.s] ?? 0;
		cursor[e.s] = pos + 1;
		targets[pos] = e.d;
		weights[pos] = e.w;
	}

	return { n, offsets, targets, weights, idToIdx, idxToId, slice: resolveSlice(slice) };
}

/** Which part of the graph a CSR mirrors: some rels' edges, some node types (default: all). */
export interface CsrScope {
	rels?: string[];
	/** Only nodes of these types — an edge to any other node is dropped. */
	types?: string[];
}

const scope = (o: CsrScope) =>
	[o.rels?.length ? o.rels : null, o.types?.length ? o.types : null] as const;

/** CSR over the current/live graph (`edges` view). */
export function buildCSR(raw: DbClient, opts: CsrScope = {}): Promise<CSR> {
	return loadCSR(raw, {}, ...scope(opts));
}

/**
 * CSR over the graph in a time slice: as it stood at `asOf` (valid time) and as graphx
 * believed it at `recordedAsOf` (recorded time). An axis omitted, or at/after `FOREVER`,
 * means now; both now is the live graph.
 */
export function snapshotCSR(raw: DbClient, slice: TimeSlice, opts: CsrScope = {}): Promise<CSR> {
	return loadCSR(raw, slice, ...scope(opts));
}

/** The CSR for an algorithm's options: live, or the slice they name. */
function csrAt(raw: DbClient, slice: TimeSlice, o: CsrScope): Promise<CSR> {
	return loadCSR(raw, slice, ...scope(o));
}

/** Out-neighbors of dense node `u` — the `offsets[u]..offsets[u+1]` slice, ULID-translated. */
export function neighbors(csr: CSR, u: number): CsrNeighbor[] {
	const start = csr.offsets[u] ?? 0;
	const end = csr.offsets[u + 1] ?? 0;
	const out: CsrNeighbor[] = [];
	for (let i = start; i < end; i++) {
		const to = csr.targets[i] ?? 0;
		out.push({ to, id: csr.idxToId[to] ?? '', weight: csr.weights[i] ?? 0 });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Binary min-heap (portable, parallel key/value arrays)
// ---------------------------------------------------------------------------

class MinHeap {
	private keys: number[] = [];
	private vals: number[] = [];

	size(): number {
		return this.keys.length;
	}

	push(key: number, val: number): void {
		this.keys.push(key);
		this.vals.push(val);
		let i = this.keys.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if ((this.keys[p] ?? 0) <= (this.keys[i] ?? 0)) break;
			this.swap(i, p);
			i = p;
		}
	}

	/** Pop the value with the smallest key, or `undefined` if empty. */
	pop(): number | undefined {
		const len = this.keys.length;
		if (len === 0) return undefined;
		const topVal = this.vals[0];
		const lastKey = this.keys.pop();
		const lastVal = this.vals.pop();
		if (len > 1 && lastKey !== undefined && lastVal !== undefined) {
			this.keys[0] = lastKey;
			this.vals[0] = lastVal;
			this.siftDown();
		}
		return topVal;
	}

	private siftDown(): void {
		let i = 0;
		const len = this.keys.length;
		for (;;) {
			const l = 2 * i + 1;
			const r = 2 * i + 2;
			let min = i;
			if (l < len && (this.keys[l] ?? 0) < (this.keys[min] ?? 0)) min = l;
			if (r < len && (this.keys[r] ?? 0) < (this.keys[min] ?? 0)) min = r;
			if (min === i) break;
			this.swap(i, min);
			i = min;
		}
	}

	private swap(i: number, j: number): void {
		const tk = this.keys[i] ?? 0;
		this.keys[i] = this.keys[j] ?? 0;
		this.keys[j] = tk;
		const tv = this.vals[i] ?? 0;
		this.vals[i] = this.vals[j] ?? 0;
		this.vals[j] = tv;
	}
}

// ---------------------------------------------------------------------------
// shortestPath
// ---------------------------------------------------------------------------

/** Dijkstra / A* over a CSR (non-negative weights, B9). Returns null if unreachable. */
function dijkstra(
	csr: CSR,
	s: number,
	d: number,
	weighted: boolean,
	heuristic: ((id: string) => number) | undefined,
): ShortestPathResult | null {
	const { n, offsets, targets, weights, idxToId } = csr;
	const dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
	const prev = new Int32Array(n).fill(-1);
	const settled = new Uint8Array(n);
	const h = (idx: number): number => (heuristic ? heuristic(idxToId[idx] ?? '') : 0);

	dist[s] = 0;
	const heap = new MinHeap();
	heap.push(h(s), s);
	while (heap.size() > 0) {
		const u = heap.pop();
		if (u === undefined) break;
		if (settled[u]) continue;
		settled[u] = 1;
		if (u === d) break;
		const du = dist[u] ?? Number.POSITIVE_INFINITY;
		const start = offsets[u] ?? 0;
		const end = offsets[u + 1] ?? 0;
		for (let i = start; i < end; i++) {
			const v = targets[i] ?? 0;
			if (settled[v]) continue;
			const w = weighted ? (weights[i] ?? 0) : 1;
			const nd = du + w;
			if (nd < (dist[v] ?? Number.POSITIVE_INFINITY)) {
				dist[v] = nd;
				prev[v] = u;
				heap.push(nd + h(v), v);
			}
		}
	}

	const cost = dist[d] ?? Number.POSITIVE_INFINITY;
	if (!Number.isFinite(cost)) return null;
	const path: string[] = [idxToId[d] ?? ''];
	let cur = d;
	while (cur !== s) {
		const p = prev[cur] ?? -1;
		if (p === -1) break;
		cur = p;
		path.push(idxToId[cur] ?? '');
	}
	path.reverse();
	return { path, cost };
}

async function sqlShortestPath(
	raw: DbClient,
	src: string,
	dst: string,
	weighted: boolean,
	rels: string[] | null,
	maxDepth: number | undefined,
	slice: TimeSlice,
): Promise<ShortestPathResult | null> {
	// In a past slice, walk the edge versions in it instead of the live `edges` view.
	const historic = !isLive(slice);
	const pred = slicePredicate('e', slice);
	const edgeSource = historic ? 'edge_versions' : 'edges';
	const timeClause = historic ? ` AND ${pred.sql}` : '';
	const relClause = rels ? ` AND e.rel IN (${rels.map(() => '?').join(',')})` : '';
	const costExpr = weighted ? 'e.weight' : '1.0';
	// Optional M17 depth bound: omitted = unbounded (the cycle guard still terminates
	// the walk by restricting it to simple paths, so it agrees with memory-mode).
	const depthClause = maxDepth !== undefined ? '\n    AND w.depth < ?' : '';
	// Priority-queue recursive CTE: ORDER BY cumulative cost pulls the cheapest frontier
	// first; the path-LIKE guard keeps it cycle-safe (simple paths only — the optimum for
	// non-negative weights, B9). ORDER BY inside a recursive term is a SQLite-only
	// extension — Postgres and DuckDB both reject it ("ORDER BY in a recursive query is
	// not allowed"), so it is omitted there: the CTE then fully enumerates simple paths and
	// the OUTER `ORDER BY cost LIMIT 1` still selects the optimum (no pruning, fine for
	// small graphs).
	const d = dialectOf(raw);
	const orderClause = d === 'libsql' || d === 'sqlite' ? `\n  ORDER BY w.cost + ${costExpr}` : '';
	// Postgres and DuckDB both require the recursive column types to match the
	// non-recursive term; the running cost is `double precision` (weight is `real`), so
	// the anchor's 0 is cast.
	const zeroCost = d === 'libsql' || d === 'sqlite' ? '0.0' : 'CAST(0.0 AS double precision)';
	const sql = `
WITH RECURSIVE walk(node, cost, path, depth) AS (
  SELECT ?, ${zeroCost}, ',' || ? || ',', 0
  UNION ALL
  SELECT e.dst, w.cost + ${costExpr}, w.path || e.dst || ',', w.depth + 1
  FROM walk w
  JOIN ${edgeSource} e ON e.src = w.node${timeClause}${relClause}
  WHERE w.node <> ?${depthClause}
    AND w.path NOT LIKE '%,' || e.dst || ',%'${orderClause}
)
SELECT cost, path FROM walk WHERE node = ? ORDER BY cost LIMIT 1`;
	const args: (string | number)[] = [
		src,
		src,
		...(historic ? pred.args : []),
		...(rels ?? []),
		dst,
		...(maxDepth !== undefined ? [maxDepth] : []),
		dst,
	];
	const r = await raw.execute({ sql, args });
	const row = r.rows[0];
	if (!row) return null;
	const path = String(row.path)
		.split(',')
		.filter((s) => s.length > 0);
	return { path, cost: Number(row.cost) };
}

/**
 * Shortest path `src → dst`. Correct for NON-NEGATIVE weights only (B9). `src === dst`
 * is a zero-cost single-node path. Returns `null` when no route exists.
 */
export async function shortestPath(
	raw: DbClient,
	src: string,
	dst: string,
	opts: ShortestPathOpts = {},
): Promise<ShortestPathResult | null> {
	if (src === dst) return { path: [src], cost: 0 };
	const weighted = opts.weighted ?? true;
	const mode = opts.mode ?? 'memory';
	const rels = opts.rels?.length ? opts.rels : null;

	if (mode === 'sql') {
		return sqlShortestPath(raw, src, dst, weighted, rels, opts.maxDepth, opts);
	}

	const csr = await csrAt(raw, opts, { rels: rels ?? undefined, types: opts.types });
	const s = csr.idToIdx.get(src);
	const d = csr.idToIdx.get(dst);
	if (s === undefined || d === undefined) return null;
	return dijkstra(csr, s, d, weighted, opts.heuristic);
}

// ---------------------------------------------------------------------------
// analytics — pagerank / community / centrality + persistence
// ---------------------------------------------------------------------------

/** UPSERT one metric column for many ids into `node_analytics` (chunked batches). */
async function persist(
	raw: DbClient,
	metric: Metric,
	rows: Array<[string, number]>,
): Promise<void> {
	if (rows.length === 0) return;
	const now = Date.now();
	const stmts = rows.map(([id, val]) => ({
		sql: `INSERT INTO node_analytics (id, ${metric}, computed_at) VALUES (?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET ${metric} = excluded.${metric}, computed_at = excluded.computed_at`,
		args: [id, val, now] as (string | number)[],
	}));
	const CHUNK = 500;
	for (let i = 0; i < stmts.length; i += CHUNK) {
		await raw.batch(stmts.slice(i, i + CHUNK), 'write');
	}
}

/** A custom score name: letters, digits, `_`, `-`, `.` and `:`. */
const SCORE_NAME = /^[\w.:-]{1,64}$/;

/**
 * Persist a named per-node score (UPSERT into `node_scores`), orderable with
 * `topNodes({ by: 'score:<metric>' })`. Scores are derived data like the built-in analytics:
 * current values, not versioned, and dropped with the node on purge.
 */
export async function persistScores(
	raw: DbClient,
	metric: string,
	rows: Array<[id: string, score: number]>,
): Promise<void> {
	if (!SCORE_NAME.test(metric)) throw new Error(`persistScores: invalid metric name '${metric}'`);
	if (rows.length === 0) return;
	const now = Date.now();
	const stmts = rows.map(([id, score]) => ({
		sql: `INSERT INTO node_scores (id, metric, score, computed_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(id, metric) DO UPDATE SET score = excluded.score, computed_at = excluded.computed_at`,
		args: [id, metric, score, now] as (string | number)[],
	}));
	const CHUNK = 500;
	for (let i = 0; i < stmts.length; i += CHUNK) {
		await raw.batch(stmts.slice(i, i + CHUNK), 'write');
	}
}

/** Build a symmetric (undirected) adjacency from a directed CSR's out-edges. */
function buildUndirected(csr: CSR): { uOff: Int32Array; uTar: Int32Array } {
	const { n, offsets, targets } = csr;
	const m = targets.length;
	const deg = new Int32Array(n);
	for (let u = 0; u < n; u++) {
		const start = offsets[u] ?? 0;
		const end = offsets[u + 1] ?? 0;
		for (let i = start; i < end; i++) {
			const v = targets[i] ?? 0;
			deg[u] = (deg[u] ?? 0) + 1;
			deg[v] = (deg[v] ?? 0) + 1;
		}
	}
	const uOff = new Int32Array(n + 1);
	for (let u = 0; u < n; u++) uOff[u + 1] = (uOff[u] ?? 0) + (deg[u] ?? 0);
	const uTar = new Int32Array(2 * m);
	const cursor = Int32Array.from(uOff);
	for (let u = 0; u < n; u++) {
		const start = offsets[u] ?? 0;
		const end = offsets[u + 1] ?? 0;
		for (let i = start; i < end; i++) {
			const v = targets[i] ?? 0;
			const pu = cursor[u] ?? 0;
			cursor[u] = pu + 1;
			uTar[pu] = v;
			const pv = cursor[v] ?? 0;
			cursor[v] = pv + 1;
			uTar[pv] = u;
		}
	}
	return { uOff, uTar };
}

/**
 * PageRank via power iteration over the live CSR (or the one at `asOf`). Dangling
 * (out-degree-0) mass is redistributed uniformly so the vector stays a distribution
 * (sums to ~1). Returned as `id → score`; a live run is also persisted to
 * `node_analytics.pagerank`.
 */
export async function pagerank(
	raw: DbClient,
	opts: PageRankOpts = {},
): Promise<Map<string, number>> {
	const damping = opts.damping ?? 0.85;
	const tol = opts.tol ?? 1e-9;
	const maxIter = opts.maxIter ?? 100;
	const csr = await csrAt(raw, opts, opts);
	const { n, offsets, targets, idxToId } = csr;
	const result = new Map<string, number>();
	if (n === 0) return result;

	const outdeg = new Int32Array(n);
	for (let u = 0; u < n; u++) outdeg[u] = (offsets[u + 1] ?? 0) - (offsets[u] ?? 0);
	const base = (1 - damping) / n;
	let pr = new Float64Array(n).fill(1 / n);

	for (let iter = 0; iter < maxIter; iter++) {
		const next = new Float64Array(n).fill(base);
		let dangling = 0;
		for (let u = 0; u < n; u++) {
			const pu = pr[u] ?? 0;
			const deg = outdeg[u] ?? 0;
			if (deg === 0) {
				dangling += pu;
				continue;
			}
			const share = (damping * pu) / deg;
			const start = offsets[u] ?? 0;
			const end = offsets[u + 1] ?? 0;
			for (let i = start; i < end; i++) {
				const v = targets[i] ?? 0;
				next[v] = (next[v] ?? 0) + share;
			}
		}
		const danglingShare = (damping * dangling) / n;
		let delta = 0;
		for (let u = 0; u < n; u++) {
			const nu = (next[u] ?? 0) + danglingShare;
			next[u] = nu;
			delta += Math.abs(nu - (pr[u] ?? 0));
		}
		pr = next;
		if (delta < tol) break;
	}

	for (let u = 0; u < n; u++) result.set(idxToId[u] ?? '', pr[u] ?? 0);
	if (isLive(opts)) await persist(raw, 'pagerank', [...result]);
	return result;
}

/**
 * Community detection by asynchronous label propagation over the undirected live
 * graph (or the one at `asOf`). Ties break to the smallest label for determinism;
 * final labels are remapped to dense community ids in ascending-node order. A live
 * run is persisted to `node_analytics.community`.
 */
export async function community(
	raw: DbClient,
	opts: CommunityOpts = {},
): Promise<Map<string, number>> {
	const maxIter = opts.maxIter ?? 20;
	const csr = await csrAt(raw, opts, opts);
	const { n, idxToId } = csr;
	const result = new Map<string, number>();
	if (n === 0) return result;

	const { uOff, uTar } = buildUndirected(csr);
	const label = new Int32Array(n);
	for (let i = 0; i < n; i++) label[i] = i;

	for (let iter = 0; iter < maxIter; iter++) {
		let changed = false;
		for (let u = 0; u < n; u++) {
			const start = uOff[u] ?? 0;
			const end = uOff[u + 1] ?? 0;
			if (start === end) continue; // isolated node keeps its own label
			const counts = new Map<number, number>();
			for (let i = start; i < end; i++) {
				const lv = label[uTar[i] ?? 0] ?? 0;
				counts.set(lv, (counts.get(lv) ?? 0) + 1);
			}
			let bestLabel = label[u] ?? 0;
			let bestCount = -1;
			for (const [lab, cnt] of counts) {
				if (cnt > bestCount || (cnt === bestCount && lab < bestLabel)) {
					bestCount = cnt;
					bestLabel = lab;
				}
			}
			if ((label[u] ?? 0) !== bestLabel) {
				label[u] = bestLabel;
				changed = true;
			}
		}
		if (!changed) break;
	}

	const remap = new Map<number, number>();
	let nextId = 0;
	for (let u = 0; u < n; u++) {
		const l = label[u] ?? 0;
		let c = remap.get(l);
		if (c === undefined) {
			c = nextId++;
			remap.set(l, c);
		}
		result.set(idxToId[u] ?? '', c);
	}
	if (isLive(opts)) await persist(raw, 'community', [...result]);
	return result;
}

/**
 * Degree centrality over the live CSR (or the one at `asOf`). `'degree'` = in + out,
 * `'in'`/`'out'` isolate one side. A live run is persisted to `node_analytics.degree`.
 */
export async function centrality(
	raw: DbClient,
	kind: CentralityKind = 'degree',
	opts: CentralityOpts = {},
): Promise<Map<string, number>> {
	const csr = await csrAt(raw, opts, opts);
	const { n, offsets, targets, idxToId } = csr;
	const result = new Map<string, number>();
	if (n === 0) return result;

	const inn = new Int32Array(n);
	const out = new Int32Array(n);
	for (let u = 0; u < n; u++) {
		const start = offsets[u] ?? 0;
		const end = offsets[u + 1] ?? 0;
		out[u] = end - start;
		for (let i = start; i < end; i++) {
			const v = targets[i] ?? 0;
			inn[v] = (inn[v] ?? 0) + 1;
		}
	}
	for (let u = 0; u < n; u++) {
		const val =
			kind === 'in'
				? (inn[u] ?? 0)
				: kind === 'out'
					? (out[u] ?? 0)
					: (out[u] ?? 0) + (inn[u] ?? 0);
		result.set(idxToId[u] ?? '', val);
	}
	if (isLive(opts)) await persist(raw, 'degree', [...result]);
	return result;
}

/** mulberry32 — a tiny seeded PRNG, so a sampled betweenness run is reproducible. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Betweenness centrality (Brandes) over the directed live CSR (or the one at `asOf`):
 * how many shortest paths between other nodes run through each node. Normalised to
 * 0–1 by `(n − 1)(n − 2)`. With `samples`, Brandes runs from that many sampled sources
 * and scales up — the standard estimate when every-source is too slow.
 *
 * A live run is persisted as the score `betweenness`, so
 * `topNodes({ by: 'score:betweenness' })` reads it back.
 */
export async function betweenness(
	raw: DbClient,
	opts: BetweennessOpts = {},
): Promise<Map<string, number>> {
	const weighted = opts.weighted ?? true;
	const csr = await csrAt(raw, opts, opts);
	const { n, offsets, targets, weights, idxToId } = csr;
	const result = new Map<string, number>();
	if (n === 0) return result;

	let sources: number[] = Array.from({ length: n }, (_, i) => i);
	if (opts.samples !== undefined && opts.samples < n) {
		const rand = seeded(opts.seed ?? 1);
		for (let i = n - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			const tmp = sources[i] ?? 0;
			sources[i] = sources[j] ?? 0;
			sources[j] = tmp;
		}
		sources = sources.slice(0, Math.max(1, opts.samples));
	}

	const cb = new Float64Array(n);
	const sigma = new Float64Array(n);
	const dist = new Float64Array(n);
	const delta = new Float64Array(n);
	const order = new Int32Array(n);
	// Predecessor lists, reused across sources: preds of v are predBuf[predOff[v] .. predOff[v] + predLen[v]).
	const indeg = new Int32Array(n);
	for (let i = 0; i < targets.length; i++)
		indeg[targets[i] ?? 0] = (indeg[targets[i] ?? 0] ?? 0) + 1;
	const predOff = new Int32Array(n + 1);
	for (let v = 0; v < n; v++) predOff[v + 1] = (predOff[v] ?? 0) + (indeg[v] ?? 0);
	const predBuf = new Int32Array(targets.length);
	const predLen = new Int32Array(n);

	for (const s of sources) {
		sigma.fill(0);
		dist.fill(Number.POSITIVE_INFINITY);
		delta.fill(0);
		predLen.fill(0);
		sigma[s] = 1;
		dist[s] = 0;
		let count = 0;
		const settled = new Uint8Array(n);
		const heap = new MinHeap();
		heap.push(0, s);
		while (heap.size() > 0) {
			const u = heap.pop();
			if (u === undefined) break;
			if (settled[u]) continue;
			settled[u] = 1;
			order[count++] = u;
			const du = dist[u] ?? 0;
			const start = offsets[u] ?? 0;
			const end = offsets[u + 1] ?? 0;
			for (let i = start; i < end; i++) {
				const v = targets[i] ?? 0;
				const nd = du + (weighted ? (weights[i] ?? 0) : 1);
				const dv = dist[v] ?? Number.POSITIVE_INFINITY;
				if (nd < dv - 1e-9) {
					dist[v] = nd;
					sigma[v] = sigma[u] ?? 0;
					predBuf[predOff[v] ?? 0] = u;
					predLen[v] = 1;
					heap.push(nd, v);
				} else if (Math.abs(nd - dv) <= 1e-9 && !settled[v]) {
					sigma[v] = (sigma[v] ?? 0) + (sigma[u] ?? 0);
					predBuf[(predOff[v] ?? 0) + (predLen[v] ?? 0)] = u;
					predLen[v] = (predLen[v] ?? 0) + 1;
				}
			}
		}
		for (let k = count - 1; k >= 0; k--) {
			const w = order[k] ?? 0;
			const base = predOff[w] ?? 0;
			const coeff = (1 + (delta[w] ?? 0)) / (sigma[w] || 1);
			for (let j = 0; j < (predLen[w] ?? 0); j++) {
				const v = predBuf[base + j] ?? 0;
				delta[v] = (delta[v] ?? 0) + (sigma[v] ?? 0) * coeff;
			}
			if (w !== s) cb[w] = (cb[w] ?? 0) + (delta[w] ?? 0);
		}
	}

	const scale = n / sources.length / (n > 2 ? (n - 1) * (n - 2) : 1);
	for (let u = 0; u < n; u++) result.set(idxToId[u] ?? '', (cb[u] ?? 0) * scale);
	if (isLive(opts)) await persistScores(raw, 'betweenness', [...result]);
	return result;
}

/** Whitelist of orderable columns — guards the interpolated ORDER BY against injection. */
const METRIC_COL: Record<Metric, string> = {
	pagerank: 'pagerank',
	community: 'community',
	degree: 'degree',
};

/**
 * Top nodes by a persisted metric. JOINs `node_analytics` with the live `nodes`
 * view (D4), optionally filters node `type`, and orders by the metric DESC.
 */
export async function topNodes(raw: DbClient, opts: TopNodesOpts): Promise<TopNode[]> {
	// Own-property check: a plain-object lookup would inherit Object.prototype keys
	// ('constructor', '__proto__', ...) as truthy, letting an untrusted `by` (P11
	// serves this over the wire) escape the whitelist into the interpolated ORDER BY.
	const limit = opts.limit ?? 10;
	const typeClause = opts.type ? ' AND n.type = ?' : '';
	if (opts.by.startsWith('score:')) {
		const metric = opts.by.slice('score:'.length);
		if (!SCORE_NAME.test(metric)) throw new Error(`topNodes: unknown metric '${opts.by}'`);
		const r = await raw.execute({
			sql: `SELECT n.id AS id, n.type AS type, na.pagerank AS pagerank, na.community AS community,
					na.degree AS degree, ns.score AS score
				FROM node_scores ns JOIN nodes n ON n.id = ns.id
				LEFT JOIN node_analytics na ON na.id = ns.id
				WHERE ns.metric = ?${typeClause}
				ORDER BY ns.score DESC
				LIMIT ?`,
			args: opts.type ? [metric, opts.type, limit] : [metric, limit],
		});
		return r.rows.map(toTopNode);
	}
	if (!Object.hasOwn(METRIC_COL, opts.by)) throw new Error(`topNodes: unknown metric '${opts.by}'`);
	const col = METRIC_COL[opts.by as Metric];
	const sql = `SELECT n.id AS id, n.type AS type, na.pagerank AS pagerank, na.community AS community, na.degree AS degree
		FROM node_analytics na JOIN nodes n ON n.id = na.id
		WHERE na.${col} IS NOT NULL${typeClause}
		ORDER BY na.${col} DESC
		LIMIT ?`;
	const args: (string | number)[] = opts.type ? [opts.type, limit] : [limit];
	const r = await raw.execute({ sql, args });
	return r.rows.map(toTopNode);
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toTopNode(row: Record<string, unknown>): TopNode {
	return {
		id: String(row.id),
		type: String(row.type),
		pagerank: num(row.pagerank),
		community: num(row.community),
		degree: num(row.degree),
		score: num(row.score),
	};
}
