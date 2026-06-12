import type { Client } from '@libsql/client';

/**
 * P6 — temporal queries (§9). Read-side time travel over the close-and-insert
 * store: `history` lists every version for an id, `diff` reports rows whose
 * `[valid_from,valid_to)` interval changed in a window, and `asOfPredicate`
 * yields the half-open as-of predicate (D3) for reuse across query builders.
 *
 * Mutations (updateNode/deleteEdge, §19.1) live on the `Graph` class in
 * `graph.ts`; this file is portable read-only SQL.
 */

/** One `diff` result bucket: changed node rows and changed edge rows. */
export interface TemporalDiff {
	nodes: Array<Record<string, unknown>>;
	edges: Array<Record<string, unknown>>;
}

/**
 * All versions for a node id (hot rows only — `includeCold`/Parquet is P10),
 * ordered by `valid_from`. Closed versions are byte-stable, so this is the
 * immutable audit trail for the id.
 */
export async function history(raw: Client, id: string): Promise<Array<Record<string, unknown>>> {
	const r = await raw.execute({
		sql: 'SELECT ver, id, kind, body, uri, content_hash, content_type, props, valid_from, valid_to FROM node_versions WHERE id = ? ORDER BY valid_from',
		args: [id],
	});
	return r.rows as unknown as Array<Record<string, unknown>>;
}

/**
 * Rows whose `[valid_from,valid_to)` interval changed between `t1` and `t2`:
 * any version that opened (`valid_from`) or closed (`valid_to`) within the
 * half-open window `(t1, t2]`. Covers both new versions and supersession
 * closes for nodes and edges.
 */
export async function diff(raw: Client, t1: number, t2: number): Promise<TemporalDiff> {
	const where = '(valid_from > ? AND valid_from <= ?) OR (valid_to > ? AND valid_to <= ?)';
	const args = [t1, t2, t1, t2];
	const nodes = await raw.execute({
		sql: `SELECT ver, id, kind, props, valid_from, valid_to FROM node_versions WHERE ${where}`,
		args,
	});
	const edges = await raw.execute({
		sql: `SELECT ver, id, src, dst, rel, weight, props, valid_from, valid_to FROM edge_versions WHERE ${where}`,
		args,
	});
	return {
		nodes: nodes.rows as unknown as Array<Record<string, unknown>>,
		edges: edges.rows as unknown as Array<Record<string, unknown>>,
	};
}

/**
 * The half-open as-of predicate (D3): `<alias>.valid_from <= ? AND ? < <alias>.valid_to`.
 * Bind the as-of timestamp twice (positionally). Use ONLY for genuine past
 * reads where `:t < FOREVER`; current reads go through the `nodes`/`edges`
 * views instead.
 */
export function asOfPredicate(alias: string): string {
	return `${alias}.valid_from <= ? AND ? < ${alias}.valid_to`;
}
