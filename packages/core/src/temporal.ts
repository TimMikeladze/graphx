import { type DbClient, dialectOf, type SqlValue } from './dialect.ts';
import type { GraphEvent, GraphEventOp } from './events.ts';
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
export async function history(raw: DbClient, id: string): Promise<Array<Record<string, unknown>>> {
	const r = await raw.execute({
		sql: 'SELECT ver, id, type, body, uri, content_hash, content_type, data, valid_from, valid_to FROM node_versions WHERE id = ? ORDER BY valid_from',
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
export async function diff(raw: DbClient, t1: number, t2: number): Promise<TemporalDiff> {
	const where = '(valid_from > ? AND valid_from <= ?) OR (valid_to > ? AND valid_to <= ?)';
	const args = [t1, t2, t1, t2];
	const nodes = await raw.execute({
		sql: `SELECT ver, id, type, data, valid_from, valid_to FROM node_versions WHERE ${where}`,
		args,
	});
	const edges = await raw.execute({
		sql: `SELECT ver, id, src, dst, rel, weight, data, valid_from, valid_to FROM edge_versions WHERE ${where}`,
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
 * to derive `nextCursor` without a second query. Rows are returned VERBATIM (raw stored `data`
 * TEXT) — never `JSON.parse`d/upcast here; the changelog reports the bytes that were written.
 */
async function feedStream(
	raw: DbClient,
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
	raw: DbClient,
	cursor: ChangeFeedCursor = {},
	opts: ChangeFeedOpts = {},
): Promise<ChangeFeedPage> {
	if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
		throw new Error(`changeFeed: limit must be a positive integer, got ${opts.limit}`);
	}
	const maxRows = resolveLimits(opts.limits).maxRows;
	const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
	const nodeCols = 'ver, id, type, data, valid_from, valid_to';
	const edgeCols = 'ver, id, src, dst, rel, weight, data, valid_from, valid_to';
	const nodes = await feedStream(raw, 'node_versions', nodeCols, cursor.nodes, pageSize);
	const edges = await feedStream(raw, 'edge_versions', edgeCols, cursor.edges, pageSize);
	return {
		nodes: nodes.rows,
		edges: edges.rows,
		nextCursor: { nodes: nodes.nextCursor, edges: edges.nextCursor },
	};
}

/** Cursor for {@link outboxTail}: the `seq` of the last event consumed. Omit for the beginning. */
export interface OutboxCursor {
	seq?: number;
}

/** Options for {@link outboxTail}. */
export interface OutboxTailOpts {
	/** Page size; clamped to `maxRows`. Defaults to `maxRows`. */
	limit?: number;
	/** Restrict to node or edge events. */
	entity?: 'node' | 'edge';
	/** Restrict to specific ops (e.g. only the deletes). */
	ops?: GraphEventOp[];
	/** §19.2 governance caps; `maxRows` bounds the page (default 10k). */
	limits?: Partial<QueryLimits>;
}

/** One {@link outboxTail} page: the events + the cursor to poll the next. `null` when drained. */
export interface OutboxPage {
	events: GraphEvent[];
	nextCursor: number | null;
}

/** Reshape a `graph_outbox` row into a {@link GraphEvent} (null src/dst ⇒ omitted, not `"null"`). */
function rowToEvent(row: Record<string, unknown>): GraphEvent {
	return {
		seq: Number(row.seq),
		op: String(row.op) as GraphEventOp,
		entity: String(row.entity) as 'node' | 'edge',
		id: String(row.id),
		label: row.label == null ? '' : String(row.label),
		shape: String(row.shape) as 'insert' | 'close',
		ts: Number(row.ts),
		src: row.src == null ? undefined : String(row.src),
		dst: row.dst == null ? undefined : String(row.dst),
		source: row.source == null ? undefined : String(row.source),
	};
}

/**
 * Tailable, delete-inclusive event feed (eventing Layer 2) — the durable sibling of {@link
 * changeFeed} that DOES surface pure closes (deleteNode/deleteEdge/supersede), because the
 * `graph_outbox` rows are written from the mutation altitude where the close is known. One
 * `seq` keyset (`seq > cursor ORDER BY seq`), a single monotonic stream, keyset-paginated so
 * polling never skips or overlaps; `nextCursor` is `null` once drained. Poll again from the
 * last non-null cursor to pick up events written after catch-up.
 *
 * Backend ordering: on libSQL every writer serializes through one BEGIN IMMEDIATE connection, so
 * the AUTOINCREMENT `seq` equals commit order and the bare keyset is airtight. On Postgres the
 * IDENTITY `seq` is assigned at INSERT, so a transaction with a lower seq can commit AFTER one
 * with a higher seq; a naive `seq > cursor` would skip it once the cursor advanced. The gate
 * {@link PG_OUTBOX_VISIBLE} withholds any row until every transaction that could still hold a
 * lower seq has finished, so no row is ever skipped (at the cost of tail latency behind a
 * long-running writer). It is `age()`-based, not a raw `xid::bigint` compare, so it stays
 * correct across xid epoch rollover -- a plain integer compare of the 32-bit `xmin` against the
 * 64-bit snapshot horizon reads as always-true past 2^32 and would silently disable the gate.
 */
/**
 * Postgres visibility gate for the outbox tail/head. A row is released only once its inserting txn
 * is OLDER than the snapshot xmin horizon (every txn that could still hold a lower `seq` has
 * finished), so out-of-order IDENTITY commits never skip a row. Uses `age()` -- wraparound- and
 * epoch-safe -- rather than a raw `xid::bigint` compare: the 32-bit `xmin` and the 64-bit `xid8`
 * horizon aren't comparable as plain integers once the xid epoch advances (the raw compare would
 * read as always-true and silently disable the gate). `age(xid)` grows with age within the ~2^31
 * live window, so `age(xmin) > age(horizon)` means the row's txn precedes the horizon. Cast the
 * `xid8` horizon down to `xid` so `age()` (which takes a 32-bit `xid`) accepts it.
 */
const PG_OUTBOX_VISIBLE = 'age(xmin) > age(pg_snapshot_xmin(pg_current_snapshot())::xid)';

export async function outboxTail(
	raw: DbClient,
	cursor: OutboxCursor = {},
	opts: OutboxTailOpts = {},
): Promise<OutboxPage> {
	if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
		throw new Error(`outboxTail: limit must be a positive integer, got ${opts.limit}`);
	}
	if (cursor.seq !== undefined && !Number.isInteger(cursor.seq)) {
		throw new Error('invalid cursor');
	}
	const maxRows = resolveLimits(opts.limits).maxRows;
	const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
	const conds: string[] = [];
	const args: SqlValue[] = [];
	if (cursor.seq !== undefined) {
		conds.push('seq > ?');
		args.push(cursor.seq);
	}
	if (opts.entity) {
		conds.push('entity = ?');
		args.push(opts.entity);
	}
	if (opts.ops && opts.ops.length > 0) {
		conds.push(`op IN (${opts.ops.map(() => '?').join(',')})`);
		args.push(...opts.ops);
	}
	// Postgres visibility watermark (see the doc comment). libSQL needs no gate.
	if (dialectOf(raw) === 'postgres') {
		conds.push(PG_OUTBOX_VISIBLE);
	}
	const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
	const sql = `SELECT seq, op, entity, id, label, src, dst, shape, ts, source FROM graph_outbox${where} ORDER BY seq LIMIT ?`;
	args.push(pageSize + 1); // over-fetch one to detect a next page
	const r = await raw.execute({ sql, args });
	const rows = r.rows as unknown as Array<Record<string, unknown>>;
	if (rows.length > pageSize) {
		const page = rows.slice(0, pageSize).map(rowToEvent);
		const last = page[page.length - 1] as GraphEvent;
		return { events: page, nextCursor: last.seq ?? null };
	}
	return { events: rows.map(rowToEvent), nextCursor: null };
}

/**
 * The horizon-safe "current tail" seq for a live subscriber that wants only NEW events (the SSE
 * `since=now` start). A bare `MAX(seq)` is WRONG on Postgres: the IDENTITY `seq` commits out of
 * order, so `MAX(seq)` can see a higher-seq committed row while a lower-seq txn is still in flight
 * — starting the cursor past it means that lower-seq event is skipped forever once it commits
 * (`seq > cursor` never matches). The same `xmin` visibility gate {@link outboxTail} applies to the
 * tail is applied here so the start cursor never advances past a not-yet-visible row. libSQL needs
 * no gate (serialized writer ⇒ `seq` == commit order).
 */
export async function outboxHead(raw: DbClient): Promise<number> {
	const gate = dialectOf(raw) === 'postgres' ? ` WHERE ${PG_OUTBOX_VISIBLE}` : '';
	const r = await raw.execute(`SELECT COALESCE(MAX(seq), 0) AS head FROM graph_outbox${gate}`);
	return Number((r.rows[0] as { head: unknown }).head);
}

/**
 * Drop consumed outbox rows: `DELETE WHERE seq < beforeSeq`. Retention/coordination is the
 * caller's policy (prune below the slowest live consumer's cursor, or by age) — core just
 * provides the mechanism. Returns the number of rows deleted.
 */
export async function pruneOutbox(raw: DbClient, beforeSeq: number): Promise<number> {
	if (!Number.isInteger(beforeSeq)) {
		throw new Error(`pruneOutbox: beforeSeq must be an integer, got ${beforeSeq}`);
	}
	const r = await raw.execute({ sql: 'DELETE FROM graph_outbox WHERE seq < ?', args: [beforeSeq] });
	return r.rowsAffected;
}
