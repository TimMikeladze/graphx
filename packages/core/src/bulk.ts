import { FOREVER } from './db.ts';
import { type DbClient, dialectOf, type SqlStatement, type SqlValue } from './dialect.ts';
import { embFreshExpr, insertOrIgnore } from './dialect-sql.ts';
import { ulid } from 'ulidx';
import type { NodeType, Rel } from './define-graph-schema.ts';
import type { GraphSchema } from './graph.ts';
import { NODES_FTS_TRIGGER_DDL, NV_EMB_IDX_DDL } from './schema.ts';
import { Upcaster, type UpcasterRegistry } from './upcast.ts';

/**
 * P13 — bulk ingestion (§19.8). An import path DISTINCT from the live close-and-insert
 * writes (P3/P6): large multi-row inserts in one big transaction, with the ANN index
 * and FTS sync trigger DROPPED for the duration and rebuilt once at the end. Orders of
 * magnitude faster than per-row `addNode` for initial import.
 *
 * NOT an upsert. By default every row mints a FRESH ULID and a single open version
 * (`valid_from = loadTs`, `valid_to = FOREVER`) — no versioning, no close of prior rows,
 * so distinct ids never produce overlapping intervals.
 *
 * A row MAY instead carry an explicit `id` plus `validFrom`/`validTo`, which is how an
 * import brings its own history: several rows sharing one id become several version rows
 * under one identity. That shifts interval correctness onto the caller, so the loaders
 * check it up front — per id, intervals must not overlap and at most one may be open. A
 * fully closed timeline is legal and means the entity existed and ended (no live row).
 *
 * Both loaders are admin/initial-load paths and are NOT safe to interleave with concurrent
 * live writes (the trigger is absent mid-load; the final FTS `'rebuild'` reindexes
 * everything). Neither emits graph events or writes the outbox.
 */

/** One row to bulk-insert as a node version. `data` is validated against the schema. */
export interface BulkRow<S extends GraphSchema> {
	/**
	 * Reuse this identity instead of minting a ULID. Several rows sharing one `id` become
	 * several versions of it; the identity row is created if absent. Omit for a fresh node.
	 */
	id?: string;
	type: NodeType<S>;
	data: Record<string, unknown>;
	emb?: number[];
	body?: string;
	uri?: string;
	content_hash?: string;
	content_type?: string;
	/** Interval start (epoch ms). Default: the load's `loadTs`. */
	validFrom?: number;
	/** Interval end, exclusive (epoch ms). Default: FOREVER, i.e. an open (live) version. */
	validTo?: number;
}

/**
 * Result of {@link bulkLoad} / {@link bulkEdges}: one id per input row, in input order
 * (a supplied `id` is echoed back, so rows sharing an identity repeat it), and the row count.
 */
export interface BulkResult {
	ids: string[];
	count: number;
}

/** Options for {@link bulkLoad}. */
export interface BulkOpts {
	/** Rows per multi-row INSERT (default 100; keeps bound-arg count well under limits). */
	chunkSize?: number;
	/** Shared `valid_from` for every row (epoch ms; default `Date.now()`). */
	loadTs?: number;
	/**
	 * P12 (§15) upcaster registry. When set, each bulk row's data are `_v`-stamped exactly
	 * like {@link Graph.addNode}, so a registered type's bulk-loaded rows read back correctly
	 * (without it they would lack `_v`, be misread as v1, and the read-time chain would run
	 * over already-current data). Omit ⇒ no `_v` stamp (byte-identical to pre-P12 bulk).
	 */
	upcasters?: UpcasterRegistry;
}

interface RawNodeDef {
	parse: (v: unknown) => unknown;
}

interface PreparedRow {
	id: string;
	type: string;
	body: SqlValue;
	uri: SqlValue;
	content_hash: SqlValue;
	content_type: SqlValue;
	data: string;
	emb: number[] | null;
	validFrom: number;
	validTo: number;
}

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** The temporal slice of a prepared row, plus whether the caller supplied the id. */
interface Interval {
	id: string;
	supplied: boolean;
	validFrom: number;
	validTo: number;
}

/**
 * Guard the interval invariants the loaders can no longer take for granted once callers
 * supply their own ids: every interval non-empty, and per supplied id, no two intervals
 * overlapping with at most one left open. Runs BEFORE any index is dropped or row written,
 * so a bad plan cannot half-apply. Minted ids are unique by construction and skip the
 * per-id pass.
 */
function validateIntervals(label: string, rows: Interval[]): void {
	const byId = new Map<string, Interval[]>();
	for (const r of rows) {
		if (!(r.validFrom < r.validTo)) {
			throw new Error(
				`${label}: validFrom must be < validTo, got ${r.validFrom} >= ${r.validTo} for '${r.id}'`,
			);
		}
		if (!r.supplied) continue;
		const group = byId.get(r.id);
		if (group) group.push(r);
		else byId.set(r.id, [r]);
	}

	for (const [id, group] of byId) {
		const open = group.filter((r) => r.validTo === FOREVER).length;
		if (open > 1) {
			throw new Error(`${label}: id '${id}' must have at most one open version, got ${open}`);
		}
		const sorted = [...group].sort((a, b) => a.validFrom - b.validFrom);
		for (let i = 1; i < sorted.length; i++) {
			const prev = sorted[i - 1]!;
			const cur = sorted[i]!;
			if (cur.validFrom < prev.validTo) {
				throw new Error(
					`${label}: id '${id}' has overlapping intervals [${prev.validFrom},${prev.validTo}) and [${cur.validFrom},${cur.validTo})`,
				);
			}
		}
	}
}

/** Distinct ids in first-seen order — one identity row per identity, however many versions it has. */
function distinctIds(rows: { id: string }[]): string[] {
	return [...new Set(rows.map((r) => r.id))];
}

/**
 * Bulk-load nodes (§19.8). Validates every row's data against the schema FIRST (so a
 * bad row fails before any index is dropped), then: drops `nv_emb_idx` + the FTS
 * trigger, inserts identity + version rows chunked in one transaction, recreates the
 * partial-live ANN index and the trigger, rebuilds the FTS index, and `ANALYZE`s.
 */
export async function bulkLoad<S extends GraphSchema>(
	raw: DbClient,
	schema: S,
	rows: BulkRow<S>[],
	opts: BulkOpts = {},
): Promise<BulkResult> {
	const chunkSize = opts.chunkSize ?? 100;
	const loadTs = opts.loadTs ?? Date.now();
	const d = dialectOf(raw);
	const embExpr = embFreshExpr(d);
	const upcaster = new Upcaster(schema, opts.upcasters ?? {});

	// 1. Validate + prepare everything up front — fail fast, BEFORE touching indexes.
	const prepared: PreparedRow[] = rows.map((row) => {
		const def = (schema.nodes as Record<string, RawNodeDef | undefined>)[row.type];
		if (!def) throw new Error(`bulkLoad: unknown type '${String(row.type)}'`);
		const parsed = def.parse(row.data) as Record<string, unknown>;
		return {
			id: row.id ?? ulid(),
			type: String(row.type),
			body: row.body ?? null,
			uri: row.uri ?? null,
			content_hash: row.content_hash ?? null,
			content_type: row.content_type ?? null,
			// P12: stamp `_v` for registered types (no-op for unregistered ⇒ pre-P12 bytes).
			data: JSON.stringify(upcaster.stamp(String(row.type), parsed)),
			emb: row.emb ?? null,
			validFrom: row.validFrom ?? loadTs,
			validTo: row.validTo ?? FOREVER,
		};
	});
	validateIntervals(
		'bulkLoad',
		prepared.map((p, i) => ({
			id: p.id,
			supplied: rows[i]!.id !== undefined,
			validFrom: p.validFrom,
			validTo: p.validTo,
		})),
	);

	// 2. Defer the indexes: drop the ANN index and the per-row FTS sync trigger. libSQL only —
	// on Postgres there is no FTS trigger (the generated `tsvector` self-maintains) and no HNSW
	// index is created yet, so there is nothing to defer.
	if (d !== 'postgres') {
		await raw.execute('DROP INDEX IF EXISTS nv_emb_idx');
		await raw.execute('DROP TRIGGER IF EXISTS nodes_fts_ai');
	}

	// One atomic `batch` (NOT `transaction()` — the latter detaches the connection from
	// a `:memory:` DB on this client build, breaking every follow-on op). Every identity
	// row precedes every version row so the immediate FK check passes.
	try {
		const stmts: SqlStatement[] = [];
		// Identity rows first, deduped: several versions share one identity, and a supplied id
		// may already exist, so this is an INSERT-OR-IGNORE over the distinct ids.
		for (const part of chunk(distinctIds(prepared), chunkSize)) {
			stmts.push({
				sql: insertOrIgnore(d, 'node_identity', 'id', part.map(() => '(?)').join(',')),
				args: part,
			});
		}
		for (const part of chunk(prepared, chunkSize)) {
			// Version rows: per-row emb placeholder (vector(?) when present, else NULL).
			const valuesSql = part
				.map((p) => (p.emb ? `(?,?,?,?,?,?,?,${embExpr},?,?)` : '(?,?,?,?,?,?,?,NULL,?,?)'))
				.join(',');
			const args: SqlValue[] = [];
			for (const p of part) {
				args.push(p.id, p.type, p.body, p.uri, p.content_hash, p.content_type, p.data);
				if (p.emb) args.push(JSON.stringify(p.emb));
				args.push(p.validFrom, p.validTo);
			}
			stmts.push({
				sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, content_type, data, emb, valid_from, valid_to) VALUES ${valuesSql}`,
				args,
			});
		}
		if (stmts.length > 0) await raw.batch(stmts, 'write');
	} finally {
		// 3. Always restore queryability — recreate the ANN index and the FTS trigger,
		// even if the load threw (a failed batch is atomic, so no rows leak). libSQL only.
		if (d !== 'postgres') {
			await raw.execute(NV_EMB_IDX_DDL);
			await raw.execute(NODES_FTS_TRIGGER_DDL);
		}
	}

	// 4. Rebuild the FTS index from the content table (libSQL only — PG's generated tsvector
	// is already current), then refresh planner stats.
	if (d !== 'postgres') {
		await raw.execute(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`);
	}
	await raw.execute('ANALYZE');

	return { ids: prepared.map((p) => p.id), count: prepared.length };
}

/** One row to bulk-insert as an edge version. `data` is validated against the schema. */
export interface BulkEdgeRow<S extends GraphSchema> {
	/** Reuse this identity instead of minting a ULID (several rows sharing it become versions). */
	id?: string;
	rel: Rel<S>;
	src: string;
	dst: string;
	weight?: number;
	data?: Record<string, unknown>;
	source?: string;
	/** Interval start (epoch ms). Default: the load's `loadTs`. */
	validFrom?: number;
	/** Interval end, exclusive (epoch ms). Default: FOREVER, i.e. an open (live) edge. */
	validTo?: number;
}

/** Options for {@link bulkEdges}. */
export interface BulkEdgeOpts {
	/** Rows per multi-row INSERT (default 100; keeps bound-arg count well under limits). */
	chunkSize?: number;
	/** Shared `valid_from` for every row lacking an explicit `validFrom` (epoch ms; default now). */
	loadTs?: number;
	/**
	 * `id -> node type` for endpoint validation. `Graph.addEdge` checks `from`/`to` with a
	 * SELECT per endpoint, which is the dominant cost at import scale — a bulk caller already
	 * knows every node's type (it just loaded them), so the check runs in memory instead.
	 * Omit to skip endpoint validation entirely, exactly as {@link bulkLoad} skips it today;
	 * the FK on `edge_versions.src`/`dst` still rejects ids that do not exist at all.
	 */
	types?: ReadonlyMap<string, string>;
}

interface RawEdgeDef {
	data?: { parse: (v: unknown) => unknown };
	from?: string | readonly string[];
	to?: string | readonly string[];
	single?: boolean;
}

interface PreparedEdge {
	id: string;
	src: string;
	dst: string;
	rel: string;
	weight: number;
	data: string;
	source: SqlValue;
	validFrom: number;
	validTo: number;
}

function typeSet(spec: string | readonly string[] | undefined): Set<string> | null {
	if (spec === undefined) return null;
	return new Set(typeof spec === 'string' ? [spec] : spec);
}

/**
 * Bulk-load edges (§19.8) — the edge sibling of {@link bulkLoad}, for the same import path.
 * `Graph.addEdge` costs two endpoint SELECTs plus a write batch per edge; this validates
 * everything in memory up front and inserts identity + version rows chunked in one batch.
 *
 * Refuses a `single: true` rel: single-valued cardinality (§19.5) requires closing the
 * existing live `(src, rel)` edge in the same transaction, which a bulk insert does not do.
 * Loading one here would leave two live edges where the schema promises one, so it throws
 * rather than corrupt the invariant.
 *
 * No index deferral: `edge_versions` carries only its two `(src|dst, valid_from, valid_to)`
 * btree indexes, and neither the ANN index nor the FTS trigger touches edges.
 */
export async function bulkEdges<S extends GraphSchema>(
	raw: DbClient,
	schema: S,
	rows: BulkEdgeRow<S>[],
	opts: BulkEdgeOpts = {},
): Promise<BulkResult> {
	const chunkSize = opts.chunkSize ?? 100;
	const loadTs = opts.loadTs ?? Date.now();
	const d = dialectOf(raw);
	const types = opts.types;

	// Validate + prepare everything before the first write — a bad row must not half-apply.
	const prepared: PreparedEdge[] = rows.map((row) => {
		const def = (schema.edges as Record<string, RawEdgeDef | undefined>)[row.rel];
		if (!def) throw new Error(`bulkEdges: unknown rel '${String(row.rel)}'`);
		if (def.single) {
			throw new Error(
				`bulkEdges: rel '${String(row.rel)}' is single-valued — use Graph.addEdge, which closes the predecessor`,
			);
		}
		const parsedData = def.data ? def.data.parse(row.data ?? {}) : (row.data ?? {});

		if (types) {
			for (const [role, id, spec] of [
				['src', row.src, def.from],
				['dst', row.dst, def.to],
			] as const) {
				const allowed = typeSet(spec);
				if (!allowed) continue;
				const actual = types.get(id);
				if (actual === undefined) {
					throw new Error(`bulkEdges: unknown endpoint '${id}' (${role} of '${String(row.rel)}')`);
				}
				if (!allowed.has(actual)) {
					throw new Error(
						`bulkEdges: rel '${String(row.rel)}' ${role} '${id}' has type '${actual}', expected one of ${[...allowed].join(', ')}`,
					);
				}
			}
		}

		return {
			id: row.id ?? ulid(),
			src: row.src,
			dst: row.dst,
			rel: String(row.rel),
			weight: row.weight ?? 1.0,
			data: JSON.stringify(parsedData),
			source: row.source ?? null,
			validFrom: row.validFrom ?? loadTs,
			validTo: row.validTo ?? FOREVER,
		};
	});
	validateIntervals(
		'bulkEdges',
		prepared.map((p, i) => ({
			id: p.id,
			supplied: rows[i]!.id !== undefined,
			validFrom: p.validFrom,
			validTo: p.validTo,
		})),
	);

	const stmts: SqlStatement[] = [];
	// Every identity row precedes every version row so the immediate FK check passes.
	for (const part of chunk(distinctIds(prepared), chunkSize)) {
		stmts.push({
			sql: insertOrIgnore(d, 'edge_identity', 'id', part.map(() => '(?)').join(',')),
			args: part,
		});
	}
	for (const part of chunk(prepared, chunkSize)) {
		const args: SqlValue[] = [];
		for (const p of part) {
			args.push(p.id, p.src, p.dst, p.rel, p.weight, p.data, p.source, p.validFrom, p.validTo);
		}
		stmts.push({
			sql: `INSERT INTO edge_versions (id, src, dst, rel, weight, data, source, valid_from, valid_to)
				VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`,
			args,
		});
	}
	if (stmts.length > 0) await raw.batch(stmts, 'write');

	return { ids: prepared.map((p) => p.id), count: prepared.length };
}
