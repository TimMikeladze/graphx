import type { Client, Row } from '@libsql/client';

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
}

/** One reached node with its earliest arrival time and minimal hop count. */
export interface JourneyRow {
	id: string;
	arrival_t: number;
	hops: number;
	kind: string;
	name: unknown;
}

export async function journey(raw: Client, o: JourneyOpts): Promise<JourneyRow[]> {
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
	const params = [o.start, o.from, o.start, ...(rels ?? []), maxDepth, o.start];

	const sql = `
WITH RECURSIVE journey(node, t_arrive, depth, path) AS (
  SELECT ?, CAST(? AS INTEGER), 0, ',' || ? || ','
  UNION ALL
  SELECT ${nextExpr}, MAX(j.t_arrive, e.valid_from), j.depth+1, j.path || ${nextExpr} || ','
  FROM journey j JOIN edge_versions e ON ${edgeMatch} AND e.valid_to > j.t_arrive${relClause}
  WHERE j.depth < ? AND j.path NOT LIKE '%,' || ${nextExpr} || ',%'
),
reached AS (SELECT node AS id, MIN(t_arrive) AS arrival_t, MIN(depth) AS hops
            FROM journey WHERE node <> ? GROUP BY node)
SELECT r.id, r.arrival_t, r.hops, n.kind, n.props ->> 'name' AS name
FROM reached r JOIN node_versions n
  ON n.id = r.id AND n.valid_from <= r.arrival_t AND r.arrival_t < n.valid_to
ORDER BY r.arrival_t, r.hops`;

	const res = await raw.execute({ sql, args: params });
	return res.rows.map(
		(row: Row): JourneyRow => ({
			id: String(row.id),
			arrival_t: Number(row.arrival_t),
			hops: Number(row.hops),
			kind: String(row.kind),
			name: row.name,
		}),
	);
}
