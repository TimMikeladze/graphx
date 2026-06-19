import { applyConnPragmas } from './db.ts';
import { type DbClient, dialectOf } from './dialect.ts';
import {
	embColumnType,
	ftsTableDDL,
	ftsTriggerDDL,
	postgresSchema,
	vectorIndexDDL,
} from './dialect-sql.ts';

/**
 * The partial live ANN index DDL (D5). Exported so the P13 bulk loader can DROP it
 * before a large import and recreate it afterward (deferred index build, §19.8).
 * The predicate `valid_to = 8640000000000000` (FOREVER) makes it partial over live
 * rows only; it is dim-independent (the `F32_BLOB(dim)` lives on the column).
 */
export const NV_EMB_IDX_DDL: string = vectorIndexDDL('libsql');

/**
 * The FTS5 external-content sync trigger DDL (M2, §19.3). External-content FTS5 does
 * NOT auto-sync, so this `AFTER INSERT` trigger mirrors every new `node_versions` row
 * (rowid = `ver`) into `nodes_fts`. Closes are UPDATEs (no FTS mutation) — intentional,
 * so the index covers every version (live + historical), which is what powers as-of
 * lexical search. Exported so the bulk loader can DROP it during a load (per-row FTS
 * sync would defeat the deferral) and recreate it before the final `'rebuild'`.
 */
export const NODES_FTS_TRIGGER_DDL: string = ftsTriggerDDL('libsql');

/**
 * Full P1 DDL (§4 corrected + D1/D5/B9) with the embedding dimension substituted
 * into `F32_BLOB(<dim>)`. Every `CREATE` is `IF NOT EXISTS` so `init()` re-runs as
 * a no-op. `executeMultiple` runs the whole script (no `;`-splitting).
 *
 * D5: `nv_emb_idx` is a **partial** vector index over LIVE rows only
 * (`WHERE valid_to = FOREVER`). This is verified to execute on @libsql/client at
 * init time (see test/p1-schema.test.ts). P4's as-of-past path must over-fetch and
 * temporal-filter because the index covers live rows only.
 *
 * P13 (M2, §19.3): `nodes_fts` is an external-content FTS5 index over `node_versions`
 * (`content_rowid='ver'`) kept in sync by `nodes_fts_ai`; both are additive and join
 * the lexical seed list into hybrid retrieval.
 */
export function schema(dim: number = 768): string {
	return `
CREATE TABLE IF NOT EXISTS node_identity (id TEXT PRIMARY KEY);   -- ULID
CREATE TABLE IF NOT EXISTS edge_identity (id TEXT PRIMARY KEY);   -- ULID

CREATE TABLE IF NOT EXISTS node_versions (
  ver          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL REFERENCES node_identity(id),
  kind         TEXT NOT NULL,
  body         TEXT,
  uri          TEXT,
  content_hash TEXT,
  embed_hash   TEXT,
  content_type TEXT,
  props        TEXT NOT NULL DEFAULT '{}',
  emb          ${embColumnType('libsql', dim)},
  valid_from   INTEGER NOT NULL,
  valid_to     INTEGER NOT NULL DEFAULT 8640000000000000
);
CREATE INDEX IF NOT EXISTS nv_asof ON node_versions(id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS nv_kind ON node_versions(kind);
${NV_EMB_IDX_DDL}

-- P13 (M2/§19.3): external-content FTS5 over node_versions, synced by the trigger below.
${ftsTableDDL('libsql')}
${NODES_FTS_TRIGGER_DDL}

CREATE TABLE IF NOT EXISTS edge_versions (
  ver        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL REFERENCES edge_identity(id),
  src        TEXT NOT NULL REFERENCES node_identity(id),
  dst        TEXT NOT NULL REFERENCES node_identity(id),
  rel        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  props      TEXT NOT NULL DEFAULT '{}',
  source     TEXT,
  valid_from INTEGER NOT NULL,
  valid_to   INTEGER NOT NULL DEFAULT 8640000000000000
);
CREATE INDEX IF NOT EXISTS ev_src_asof ON edge_versions(src, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ev_dst_asof ON edge_versions(dst, valid_from, valid_to);

CREATE VIEW IF NOT EXISTS nodes AS
  SELECT id, kind, body, uri, content_hash, embed_hash, content_type, props, emb
  FROM node_versions WHERE valid_to = 8640000000000000;
CREATE VIEW IF NOT EXISTS edges AS
  SELECT id, src, dst, rel, weight, props, source
  FROM edge_versions WHERE valid_to = 8640000000000000;

CREATE TABLE IF NOT EXISTS archival_state (
  table_name TEXT PRIMARY KEY, watermark INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- D4/B10: analytics live in a SIDE table, UPSERTed by P8 jobs and JOINed by topNodes.
-- Version rows stay byte-stable — no analytics columns on node_versions. Per-metric
-- indexes back the ORDER BY <metric> DESC in topNodes.
CREATE TABLE IF NOT EXISTS node_analytics (
  id          TEXT PRIMARY KEY REFERENCES node_identity(id),
  pagerank    REAL,
  community   INTEGER,
  degree      INTEGER,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS na_pagerank ON node_analytics(pagerank);
CREATE INDEX IF NOT EXISTS na_community ON node_analytics(community);
CREATE INDEX IF NOT EXISTS na_degree ON node_analytics(degree);
`;
}

/**
 * Create the schema on `client`, idempotent. Sets `journal_mode = WAL` (persists in
 * the file; harmless on `:memory:`), applies the per-connection pragmas
 * (`foreign_keys`, `busy_timeout`), then runs the multi-statement DDL.
 */
export async function init(client: DbClient, dim?: number): Promise<void> {
	if (dialectOf(client) === 'postgres') {
		// Postgres: no per-connection pragmas (FKs always on, MVCC, WAL inherent). The
		// `vector` extension is expected to exist in `public` (on the search_path).
		await client.executeMultiple(postgresSchema(dim));
		return;
	}
	await client.execute('PRAGMA journal_mode = WAL');
	await applyConnPragmas(client);
	await client.executeMultiple(schema(dim));
}

/**
 * Additive column guard (§4.1): `CREATE ... IF NOT EXISTS` covers tables but SQLite
 * has no `ADD COLUMN IF NOT EXISTS`, so check first and only `ALTER` when the column
 * is absent. Uses `table_xinfo` (not `table_info`) because on this @libsql/client
 * build `table_info` HIDES generated columns — and generated columns are exactly
 * what this guard adds, so it must see them to stay idempotent.
 */
export async function ensureColumn(
	client: DbClient,
	table: string,
	col: string,
	ddl: string,
): Promise<void> {
	const info = await client.execute(`PRAGMA table_xinfo(${table})`);
	if (!info.rows.some((r) => String(r.name) === col)) {
		await client.execute(ddl);
	}
}
