import { type DbClient, dialectOf, type SqlRow } from './dialect.ts';
import { epochIntType, jsonField, scalarMax } from './dialect-sql.ts';
import { FOREVER } from './db.ts';
import {
	applyLimit,
	type MetricsContext,
	metricLabels,
	type QueryLimits,
	resolveLimits,
	withTimeout,
} from './governance.ts';

/**
 * P7 — `journey()` (§10). Earliest-arrival, time-respecting cascade over the
 * temporal edge log.
 *
 * Time model (§10, B2): the start node and `from` epoch-ms seed a recursive walk.
 * An edge is usable iff it is still open at the walker's current arrival time
 * (`e.valid_to > j.t_arrive`); arrival at the next node is
 * `max(t_arrive, e.valid_from)` so a not-yet-open edge delays arrival to its
 * `valid_from`. `path` carries the visited-set to keep cycles terminating, and
 * `depth < maxDepth` bounds the fan-out.
 *
 * B2/D1: identity is ULID TEXT end-to-end, so the start node binds as TEXT in all
 * three anchor placeholders — only the `from` timestamp is `CAST(... AS INTEGER)`.
 * (Casting the id to INTEGER would coerce a ULID to 0 and return nothing.)
 */

/** Options for {@link journey}. `start` is a ULID node id; `from` is epoch ms. */
export interface JourneyOpts {
	start: string;
	from: number;
	rels?: string[];
	direction?: 'forward' | 'reverse' | 'both';
	maxDepth?: number;
	/** §19.2 governance: row cap, fan-out guard, and fail-safe timeout (M7). */
	limits?: Partial<QueryLimits>;
	/**
	 * P12 (§15) opt-in read-time upcaster. When set, the projected `name` is read from
	 * the upcast LATEST shape (so a renamed/derived name field still surfaces); when
	 * omitted, `name` is the raw `props ->> 'name'` (pre-P12 behavior — unchanged).
	 */
	upcaster?: { apply: (kind: string, props: Record<string, unknown>) => Record<string, unknown> };
	/**
	 * P15 (§19.6) observability: when set, feeds the slow-query log (via {@link withTimeout}) and
	 * observes traversal histograms (`graphx_traversal_rows`/`graphx_traversal_depth`). Omit ⇒ no
	 * metrics, zero overhead (pre-P15 behavior).
	 */
	metrics?: MetricsContext;
}

/** One reached node with its earliest arrival time and minimal hop count. */
export interface JourneyRow {
	id: string;
	arrival_t: number;
	hops: number;
	kind: string;
	name: unknown;
}

export async function journey(raw: DbClient, o: JourneyOpts): Promise<JourneyRow[]> {
	const d = dialectOf(raw);
	const dir = o.direction ?? 'forward';
	const maxDepth = o.maxDepth ?? 6;
	const rels = o.rels?.length ? o.rels : null;
	const [edgeMatch, nextExpr] =
		dir === 'forward'
			? ['e.src = j.node', 'e.dst']
			: dir === 'reverse'
				? ['e.dst = j.node', 'e.src']
				: [
						'(e.src = j.node OR e.dst = j.node)',
						'CASE WHEN e.src = j.node THEN e.dst ELSE e.src END',
					];
	const relClause = rels ? ` AND e.rel IN (${rels.map(() => '?').join(',')})` : '';
	const limits = resolveLimits(o.limits);
	const maxFanout = Math.floor(limits.maxFanout);

	// Supernode fan-out guard (§19.2): live out-degree per node in the walk direction.
	// A LEFT JOIN + `IS NULL OR <= maxFanout` predicate means only genuine live
	// supernodes are blocked from expansion — a node with few/zero live edges (it may
	// still be reachable via a historical-but-still-open edge) is never regressed. Live
	// out-degree is the proxy (matching the task's "live out-degree > maxFanout"); the
	// per-arrival usable set is time-varying and can't be a static CTE.
	let degBody: string;
	if (dir === 'forward') {
		degBody = `SELECT e.src AS node, COUNT(*) AS c FROM edge_versions e WHERE e.valid_to = ${FOREVER}${relClause} GROUP BY e.src`;
	} else if (dir === 'reverse') {
		degBody = `SELECT e.dst AS node, COUNT(*) AS c FROM edge_versions e WHERE e.valid_to = ${FOREVER}${relClause} GROUP BY e.dst`;
	} else {
		degBody = `SELECT node, COUNT(*) AS c FROM (
    SELECT e.src AS node FROM edge_versions e WHERE e.valid_to = ${FOREVER}${relClause}
    UNION ALL SELECT e.dst AS node FROM edge_versions e WHERE e.valid_to = ${FOREVER}${relClause}
  ) GROUP BY node`;
	}
	const degParams = dir === 'both' ? [...(rels ?? []), ...(rels ?? [])] : [...(rels ?? [])];
	const params = [...degParams, o.start, o.from, o.start, ...(rels ?? []), maxDepth, o.start];

	const sql = `
WITH RECURSIVE deg(node, c) AS (
  ${degBody}
),
journey(node, t_arrive, depth, path) AS (
  SELECT ?, CAST(? AS ${epochIntType(d)}), 0, ',' || ? || ','
  UNION ALL
  SELECT ${nextExpr}, ${scalarMax(d, 'j.t_arrive', 'e.valid_from')}, j.depth+1, j.path || ${nextExpr} || ','
  FROM journey j
  LEFT JOIN deg ON deg.node = j.node
  JOIN edge_versions e ON ${edgeMatch} AND e.valid_to > j.t_arrive${relClause}
  WHERE j.depth < ? AND j.path NOT LIKE '%,' || ${nextExpr} || ',%'
    AND (deg.c IS NULL OR deg.c <= ${maxFanout})
),
reached AS (SELECT node AS id, MIN(t_arrive) AS arrival_t, MIN(depth) AS hops
            FROM journey WHERE node <> ? GROUP BY node)
SELECT r.id, r.arrival_t, r.hops, n.kind, ${jsonField(d, 'n.props', 'name')} AS name, n.props AS props_json
FROM reached r JOIN node_versions n
  ON n.id = r.id AND n.valid_from <= r.arrival_t AND r.arrival_t < n.valid_to
ORDER BY r.arrival_t, r.hops`;

	const res = await withTimeout(
		raw.execute({ sql: applyLimit(sql, limits.maxRows), args: params }),
		limits.timeoutMs,
		o.metrics,
	);
	const rows = res.rows.map((row: SqlRow): JourneyRow => {
		const kind = String(row.kind);
		// P12: with an upcaster, project `name` from the upcast LATEST shape; without one,
		// keep the raw SQL `props ->> 'name'` projection byte-for-byte (pre-P12).
		const name = o.upcaster
			? (o.upcaster.apply(kind, JSON.parse(String(row.props_json)) as Record<string, unknown>)
					.name ?? null)
			: row.name;
		return {
			id: String(row.id),
			arrival_t: Number(row.arrival_t),
			hops: Number(row.hops),
			kind,
			name,
		};
	});
	if (o.metrics) {
		// §19.6 traversal histograms: result size (fan-out) and reached depth (max hops).
		const labels = metricLabels(o.metrics);
		o.metrics.sink.observe('graphx_traversal_rows', rows.length, labels);
		o.metrics.sink.observe(
			'graphx_traversal_depth',
			rows.reduce((m, r) => Math.max(m, r.hops), 0),
			labels,
		);
	}
	return rows;
}
