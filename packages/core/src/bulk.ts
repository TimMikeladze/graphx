import { type DbClient, dialectOf, type SqlStatement, type SqlValue } from './dialect.ts';
import { embFreshExpr } from './dialect-sql.ts';
import { ulid } from 'ulidx';
import type { NodeType } from './define-graph-schema.ts';
import type { GraphSchema } from './graph.ts';
import { NODES_FTS_TRIGGER_DDL, NV_EMB_IDX_DDL } from './schema.ts';
import { Upcaster, type UpcasterRegistry } from './upcast.ts';

/**
 * P13 — bulk ingestion (§19.8). An import path DISTINCT from the live close-and-insert
 * writes (P3/P6): large multi-row inserts in one big transaction, with the ANN index
 * and FTS sync trigger DROPPED for the duration and rebuilt once at the end. Orders of
 * magnitude faster than per-row `addNode` for initial import.
 *
 * NOT an upsert: every row mints a FRESH ULID and a single open version
 * (`valid_from = loadTs`, `valid_to` defaults to FOREVER) — there is no versioning,
 * no close of prior rows, so distinct ids never produce overlapping intervals. It is
 * an admin/initial-load path and is NOT safe to interleave with concurrent live writes
 * (the trigger is absent mid-load; the final FTS `'rebuild'` reindexes everything).
 */

/** One row to bulk-insert as a brand-new node. `data` is validated against the schema. */
export interface BulkRow<S extends GraphSchema> {
	type: NodeType<S>;
	data: Record<string, unknown>;
	emb?: number[];
	body?: string;
	uri?: string;
	content_hash?: string;
	content_type?: string;
}

/** Result of {@link bulkLoad}: the minted ULIDs (input order) and the row count. */
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
}

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
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
			id: ulid(),
			type: String(row.type),
			body: row.body ?? null,
			uri: row.uri ?? null,
			content_hash: row.content_hash ?? null,
			content_type: row.content_type ?? null,
			// P12: stamp `_v` for registered types (no-op for unregistered ⇒ pre-P12 bytes).
			data: JSON.stringify(upcaster.stamp(String(row.type), parsed)),
			emb: row.emb ?? null,
		};
	});

	// 2. Defer the indexes: drop the ANN index and the per-row FTS sync trigger. libSQL only —
	// on Postgres there is no FTS trigger (the generated `tsvector` self-maintains) and no HNSW
	// index is created yet, so there is nothing to defer.
	if (d !== 'postgres') {
		await raw.execute('DROP INDEX IF EXISTS nv_emb_idx');
		await raw.execute('DROP TRIGGER IF EXISTS nodes_fts_ai');
	}

	// One atomic `batch` (NOT `transaction()` — the latter detaches the connection from
	// a `:memory:` DB on this client build, breaking every follow-on op). Identity rows
	// precede their version rows in each chunk so the immediate FK check passes.
	try {
		const stmts: SqlStatement[] = [];
		for (const part of chunk(prepared, chunkSize)) {
			stmts.push({
				sql: `INSERT INTO node_identity (id) VALUES ${part.map(() => '(?)').join(',')}`,
				args: part.map((p) => p.id),
			});
			// Version rows: per-row emb placeholder (vector(?) when present, else NULL);
			// valid_to is omitted so the column DEFAULT (FOREVER) applies.
			const valuesSql = part
				.map((p) => (p.emb ? `(?,?,?,?,?,?,?,${embExpr},?)` : '(?,?,?,?,?,?,?,NULL,?)'))
				.join(',');
			const args: SqlValue[] = [];
			for (const p of part) {
				args.push(p.id, p.type, p.body, p.uri, p.content_hash, p.content_type, p.data);
				if (p.emb) args.push(JSON.stringify(p.emb));
				args.push(loadTs);
			}
			stmts.push({
				sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, content_type, data, emb, valid_from) VALUES ${valuesSql}`,
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
