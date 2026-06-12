import type { Client } from '@libsql/client';
import { decodeCursor, encodeCursor, type QueryLimits, resolveLimits } from './governance.ts';

/**
 * P6 — temporal queries (§9). Read-side time travel over the close-and-insert
 * store: `history` lists every version for an id, `diff` reports rows whose
 * `[valid_from,valid_to)` interval changed in a window, `asOfPredicate` yields the
 * half-open as-of predicate (D3) for reuse across query builders, and `changeFeed`
 * (§19.10) is the tailable CDC sibling of `diff`.
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

/** Opaque per-stream cursors for {@link changeFeed}; pass a prior page's `nextCursor` back. */
export interface ChangeFeedCursor {
	/** The node stream cursor (from `nextCursor.nodes`); omit for the beginning. */
	nodes?: string;
	/** The edge stream cursor (from `nextCursor.edges`); omit for the beginning. */
	edges?: string;
}

/** Options for {@link changeFeed}. */
export interface ChangeFeedOpts {
	/** §19.2 governance caps; `maxRows` bounds each stream's page (default 10k). */
	limits?: Partial<QueryLimits>;
	/** Per-stream page size; clamped to `maxRows`. Defaults to `maxRows`. */
	limit?: number;
}

/** One {@link changeFeed} page: the new node/edge versions + the cursor to poll each next. */
export interface ChangeFeedPage {
	nodes: Array<Record<string, unknown>>;
	edges: Array<Record<string, unknown>>;
	/** `null` per stream when that stream has no more rows. */
	nextCursor: { nodes: string | null; edges: string | null };
}

/**
 * Decode a `(valid_from, ver)` keyset cursor. Rejects every malformed shape as a clean
 * `invalid cursor` (HTTP-400-mappable) BEFORE the values reach an SQL bind: wrong arity, and —
 * since {@link decodeCursor} only guarantees a non-empty string[], not numeric strings — any
 * part that is not a canonical integer string. The round-trip `String(n) === part` guard
 * catches non-numeric (`'abc'`→NaN), non-finite (`'Infinity'`/`'1e999'`→Infinity), fractional,
 * and empty (`''`→0, a silent stream reset) tampered cursors that would otherwise crash with a
 * libSQL `RangeError` (mapped to 500) or quietly return the wrong page.
 */
function decodeFeedCursor(cursor: string): { vf: number; ver: number } {
	const parts = decodeCursor(cursor); // validates non-empty string[] / base64 JSON
	if (parts.length !== 2) throw new Error('invalid cursor');
	const vf = Number(parts[0]);
	const ver = Number(parts[1]);
	if (
		!Number.isInteger(vf) ||
		!Number.isInteger(ver) ||
		String(vf) !== parts[0] ||
		String(ver) !== parts[1]
	) {
		throw new Error('invalid cursor');
	}
	return { vf, ver };
}

/**
 * Page one version stream (nodes or edges) by the `(valid_from, ver)` keyset. The row-value
 * keyset — `valid_from > ? OR (valid_from = ? AND ver > ?)` — is the crux: a bare
 * `valid_from > ?` cursor SKIPS rows that share the boundary `valid_from` when a page splits
 * them, whereas `ver` (the table's INTEGER PRIMARY KEY) is a unique tie-break, making
 * `(valid_from, ver)` a strict total order with no skip and no overlap. Over-fetches one row
 * to derive `nextCursor` without a second query. Rows are returned VERBATIM (raw stored `props`
 * TEXT) — never `JSON.parse`d/upcast here; the changelog reports the bytes that were written.
 */
async function feedStream(
	raw: Client,
	table: string,
	cols: string,
	cursor: string | undefined,
	pageSize: number,
): Promise<{ rows: Array<Record<string, unknown>>; nextCursor: string | null }> {
	const args: number[] = [];
	let where = '';
	// null and undefined both mean "from the beginning"; a present-but-malformed cursor
	// still surfaces a clean `invalid cursor` (HTTP-400-mappable) via decodeFeedCursor.
	if (cursor != null) {
		const { vf, ver } = decodeFeedCursor(cursor);
		where = ' WHERE (valid_from > ? OR (valid_from = ? AND ver > ?))';
		args.push(vf, vf, ver);
	}
	const sql = `SELECT ${cols} FROM ${table}${where} ORDER BY valid_from, ver LIMIT ?`;
	args.push(pageSize + 1); // over-fetch one to detect a next page
	const r = await raw.execute({ sql, args });
	const rows = r.rows as unknown as Array<Record<string, unknown>>;
	if (rows.length > pageSize) {
		const page = rows.slice(0, pageSize);
		const last = page[page.length - 1] as Record<string, unknown>;
		return { rows: page, nextCursor: encodeCursor([String(last.valid_from), String(last.ver)]) };
	}
	return { rows, nextCursor: null };
}

/**
 * Tailable change feed / CDC (§19.10) — "the temporal log IS the changelog". The sibling of
 * {@link diff}: emits the NEW version rows (`valid_from > cursor`) for nodes and edges,
 * ordered by the `(valid_from, ver)` keyset, keyset-paginated so polling never skips or
 * overlaps — even when ≥2 versions share a `valid_from`. Nodes and edges have independent
 * `ver` sequences, so each carries its OWN cursor; consumers poll each with its last cursor.
 * `nextCursor` is `null` per stream once that stream is drained (caught up); a tailing
 * consumer keeps polling and resumes from the last non-null cursor it held (the last row's
 * `(valid_from, ver)` position) to pick up versions written after it caught up.
 *
 * Semantics (decision A.3, matches the spec's literal `valid_from`-only SQL): this surfaces
 * INSERTs and UPDATE-successors only. A pure close is NOT surfaced — there are TWO such paths:
 * `deleteEdge` (closes the live row with NO successor), and the supersession of a prior
 * single-valued `(src, rel)` edge by a new `addEdge` (the old edge's `valid_to` moves with no
 * new `valid_from` row for that id; the NEW edge appears as an INSERT). In both, a closed id
 * silently leaves the live set, so consumers reconcile EVERY close via {@link diff}, which also
 * keys on `valid_to`. A `valid_to`-keyed companion close-feed is a possible follow-up; keeping
 * the cursor `valid_from`-only keeps it monotonic.
 *
 * RAW by construction: there is no upcaster parameter, so the feed reports the actual stored
 * bytes (a changelog must report what was written, not the P12 read-time shape).
 */
export async function changeFeed(
	raw: Client,
	cursor: ChangeFeedCursor = {},
	opts: ChangeFeedOpts = {},
): Promise<ChangeFeedPage> {
	if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
		throw new Error(`changeFeed: limit must be a positive integer, got ${opts.limit}`);
	}
	const maxRows = resolveLimits(opts.limits).maxRows;
	const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
	const nodeCols = 'ver, id, kind, props, valid_from, valid_to';
	const edgeCols = 'ver, id, src, dst, rel, weight, props, valid_from, valid_to';
	const nodes = await feedStream(raw, 'node_versions', nodeCols, cursor.nodes, pageSize);
	const edges = await feedStream(raw, 'edge_versions', edgeCols, cursor.edges, pageSize);
	return {
		nodes: nodes.rows,
		edges: edges.rows,
		nextCursor: { nodes: nodes.nextCursor, edges: edges.nextCursor },
	};
}
