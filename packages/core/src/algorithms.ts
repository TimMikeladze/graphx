import { type DbClient, dialectOf } from './dialect.ts';
import { FOREVER } from './db.ts';

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
	/** Snapshot instant (epoch ms), or `null` for the current/live graph. */
	t: number | null;
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
}

/** Options for {@link community}. */
export interface CommunityOpts {
	maxIter?: number;
}

/** Centrality flavor. All persist to the `node_analytics.degree` column. */
export type CentralityKind = 'degree' | 'in' | 'out';

/** A persisted analytics metric, orderable by {@link topNodes}. */
export type Metric = 'pagerank' | 'community' | 'degree';

/** Options for {@link topNodes}. `by` orders the result; `type` filters node type. */
export interface TopNodesOpts {
	by: Metric;
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
}

// ---------------------------------------------------------------------------
// CSR mirror
// ---------------------------------------------------------------------------

/**
 * Load a CSR for the live graph (`t = null`) or for the instant `t` (half-open).
 * The node universe is the ascending scan of live node ids (deterministic → stable
 * dense indices, B8); edges whose endpoints are not both live are skipped.
 */
async function loadCSR(raw: DbClient, t: number | null, rels: string[] | null): Promise<CSR> {
	const relIn = rels ? ` AND rel IN (${rels.map(() => '?').join(',')})` : '';
	let nodeRows: Array<{ id: unknown }>;
	let edgeRows: Array<{ src: unknown; dst: unknown; weight: unknown }>;
	if (t === null) {
		nodeRows = (await raw.execute('SELECT id FROM nodes ORDER BY id')).rows as never;
		edgeRows = (
			await raw.execute({
				sql: `SELECT src, dst, weight FROM edges WHERE 1 = 1${relIn} ORDER BY src, dst`,
				args: rels ?? [],
			})
		).rows as never;
	} else {
		nodeRows = (
			await raw.execute({
				sql: 'SELECT id FROM node_versions WHERE valid_from <= ? AND ? < valid_to ORDER BY id',
				args: [t, t],
			})
		).rows as never;
		edgeRows = (
			await raw.execute({
				sql: `SELECT src, dst, weight FROM edge_versions WHERE valid_from <= ? AND ? < valid_to${relIn} ORDER BY src, dst`,
				args: [t, t, ...(rels ?? [])],
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

	return { n, offsets, targets, weights, idToIdx, idxToId, t };
}

/** CSR over the current/live graph (`edges` view). */
export function buildCSR(raw: DbClient, opts: { rels?: string[] } = {}): Promise<CSR> {
	return loadCSR(raw, null, opts.rels?.length ? opts.rels : null);
}

/**
 * CSR over the graph as of instant `t` (half-open over `edge_versions`, D3). A `t`
 * at/after `FOREVER` means "now" and is routed to the live path — never bound into
 * a `:t < valid_to` predicate (which is false for every live row, D3).
 */
export function snapshotCSR(raw: DbClient, t: number, opts: { rels?: string[] } = {}): Promise<CSR> {
	const rels = opts.rels?.length ? opts.rels : null;
	return loadCSR(raw, t >= FOREVER ? null : t, rels);
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
): Promise<ShortestPathResult | null> {
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
	const orderClause = d === 'libsql' ? `\n  ORDER BY w.cost + ${costExpr}` : '';
	// Postgres and DuckDB both require the recursive column types to match the
	// non-recursive term; the running cost is `double precision` (weight is `real`), so
	// the anchor's 0 is cast.
	const zeroCost = d === 'libsql' ? '0.0' : 'CAST(0.0 AS double precision)';
	const sql = `
WITH RECURSIVE walk(node, cost, path, depth) AS (
  SELECT ?, ${zeroCost}, ',' || ? || ',', 0
  UNION ALL
  SELECT e.dst, w.cost + ${costExpr}, w.path || e.dst || ',', w.depth + 1
  FROM walk w
  JOIN edges e ON e.src = w.node${relClause}
  WHERE w.node <> ?${depthClause}
    AND w.path NOT LIKE '%,' || e.dst || ',%'${orderClause}
)
SELECT cost, path FROM walk WHERE node = ? ORDER BY cost LIMIT 1`;
	const args: (string | number)[] = [
		src,
		src,
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
		return sqlShortestPath(raw, src, dst, weighted, rels, opts.maxDepth);
	}

	const csr = await buildCSR(raw, rels ? { rels } : {});
	const s = csr.idToIdx.get(src);
	const d = csr.idToIdx.get(dst);
	if (s === undefined || d === undefined) return null;
	return dijkstra(csr, s, d, weighted, opts.heuristic);
}

// ---------------------------------------------------------------------------
// analytics — pagerank / community / centrality + persistence
// ---------------------------------------------------------------------------

/** UPSERT one metric column for many ids into `node_analytics` (chunked batches). */
async function persist(raw: DbClient, metric: Metric, rows: Array<[string, number]>): Promise<void> {
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
 * PageRank via power iteration over the live CSR. Dangling (out-degree-0) mass is
 * redistributed uniformly so the vector stays a distribution (sums to ~1). Results
 * are persisted to `node_analytics.pagerank` and returned as `id → score`.
 */
export async function pagerank(raw: DbClient, opts: PageRankOpts = {}): Promise<Map<string, number>> {
	const damping = opts.damping ?? 0.85;
	const tol = opts.tol ?? 1e-9;
	const maxIter = opts.maxIter ?? 100;
	const csr = await buildCSR(raw);
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
	await persist(raw, 'pagerank', [...result]);
	return result;
}

/**
 * Community detection by asynchronous label propagation over the undirected live
 * graph. Ties break to the smallest label for determinism; final labels are
 * remapped to dense community ids in ascending-node order. Persisted to
 * `node_analytics.community`.
 */
export async function community(raw: DbClient, opts: CommunityOpts = {}): Promise<Map<string, number>> {
	const maxIter = opts.maxIter ?? 20;
	const csr = await buildCSR(raw);
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
	await persist(raw, 'community', [...result]);
	return result;
}

/**
 * Degree centrality over the live CSR. `'degree'` = in + out, `'in'`/`'out'` isolate
 * one side. Persisted to `node_analytics.degree`.
 */
export async function centrality(
	raw: DbClient,
	kind: CentralityKind = 'degree',
): Promise<Map<string, number>> {
	const csr = await buildCSR(raw);
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
			kind === 'in' ? (inn[u] ?? 0) : kind === 'out' ? (out[u] ?? 0) : (out[u] ?? 0) + (inn[u] ?? 0);
		result.set(idxToId[u] ?? '', val);
	}
	await persist(raw, 'degree', [...result]);
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
	if (!Object.hasOwn(METRIC_COL, opts.by)) throw new Error(`topNodes: unknown metric '${opts.by}'`);
	const col = METRIC_COL[opts.by];
	const limit = opts.limit ?? 10;
	const typeClause = opts.type ? ' AND n.type = ?' : '';
	const sql = `SELECT n.id AS id, n.type AS type, na.pagerank AS pagerank, na.community AS community, na.degree AS degree
		FROM node_analytics na JOIN nodes n ON n.id = na.id
		WHERE na.${col} IS NOT NULL${typeClause}
		ORDER BY na.${col} DESC
		LIMIT ?`;
	const args: (string | number)[] = opts.type ? [opts.type, limit] : [limit];
	const r = await raw.execute({ sql, args });
	return r.rows.map((row) => ({
		id: String(row.id),
		type: String(row.type),
		pagerank: row.pagerank === null ? null : Number(row.pagerank),
		community: row.community === null ? null : Number(row.community),
		degree: row.degree === null ? null : Number(row.degree),
	}));
}
