import type { Dialect } from './dialect.ts';

/**
 * Per-dialect SQL fragments. This is the home for every SQL string that genuinely
 * differs between backends. Each fragment currently implements the **libSQL** form
 * only; the Postgres branch throws until the Postgres adapter lands (it is never
 * reached while the only backend is libSQL). Later phases fill the Postgres branches
 * here instead of rewriting the call sites in schema.ts/constraints.ts/etc.
 *
 * Keep the libSQL output byte-identical to the original inline SQL — the existing test
 * suite asserts behavior against these exact strings.
 */

/** FOREVER sentinel (max JS Date ms) inlined into partial-index / view predicates. */
const FOREVER_LIT = '8640000000000000';

/**
 * Full Postgres DDL, the dialect counterpart to libSQL's {@link import('./schema.ts').schema}.
 * Differences from the libSQL schema, all per the design doc:
 *  - `ver` is `bigint GENERATED ALWAYS AS IDENTITY` (no SQLite rowid alias);
 *  - temporal columns are `bigint` (hold the FOREVER sentinel 8.64e15 comfortably);
 *  - `emb` is pgvector `vector(dim)` (the `vector` extension must exist in `public`,
 *    which is kept on every tenant's search_path);
 *  - full-text is a generated STORED `tsvector` column + GIN index (no FTS5 virtual
 *    table, no sync trigger — the column self-maintains and covers historical rows);
 *  - views use `CREATE OR REPLACE VIEW` (no `IF NOT EXISTS` form in PG);
 *  - `props` stays `text` (callers JSON.stringify/parse exactly as on libSQL).
 * Every `CREATE` is idempotent so it can re-run as a no-op. The HNSW vector index is
 * deliberately NOT created here — it is added with the vector-search port (later phase).
 */
export function postgresSchema(dim: number = 768): string {
	return `
CREATE TABLE IF NOT EXISTS node_identity (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS edge_identity (id text PRIMARY KEY);

CREATE TABLE IF NOT EXISTS node_versions (
  ver          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id           text NOT NULL REFERENCES node_identity(id),
  kind         text NOT NULL,
  body         text,
  uri          text,
  content_hash text,
  content_type text,
  props        text NOT NULL DEFAULT '{}',
  emb          vector(${dim}),
  valid_from   bigint NOT NULL,
  valid_to     bigint NOT NULL DEFAULT ${FOREVER_LIT},
  body_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED
);
CREATE INDEX IF NOT EXISTS nv_asof ON node_versions(id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS nv_kind ON node_versions(kind);
CREATE INDEX IF NOT EXISTS nodes_fts_gin ON node_versions USING gin(body_tsv);

CREATE TABLE IF NOT EXISTS edge_versions (
  ver        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id         text NOT NULL REFERENCES edge_identity(id),
  src        text NOT NULL REFERENCES node_identity(id),
  dst        text NOT NULL REFERENCES node_identity(id),
  rel        text NOT NULL,
  weight     real NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  props      text NOT NULL DEFAULT '{}',
  valid_from bigint NOT NULL,
  valid_to   bigint NOT NULL DEFAULT ${FOREVER_LIT}
);
CREATE INDEX IF NOT EXISTS ev_src_asof ON edge_versions(src, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ev_dst_asof ON edge_versions(dst, valid_from, valid_to);

CREATE OR REPLACE VIEW nodes AS
  SELECT id, kind, body, uri, content_hash, content_type, props, emb
  FROM node_versions WHERE valid_to = ${FOREVER_LIT};
CREATE OR REPLACE VIEW edges AS
  SELECT id, src, dst, rel, weight, props
  FROM edge_versions WHERE valid_to = ${FOREVER_LIT};

CREATE TABLE IF NOT EXISTS archival_state (
  table_name text PRIMARY KEY, watermark bigint NOT NULL, updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS node_analytics (
  id          text PRIMARY KEY REFERENCES node_identity(id),
  pagerank    real,
  community   bigint,
  degree      bigint,
  computed_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS na_pagerank ON node_analytics(pagerank);
CREATE INDEX IF NOT EXISTS na_community ON node_analytics(community);
CREATE INDEX IF NOT EXISTS na_degree ON node_analytics(degree);
`;
}

function notYet(fragment: string): never {
	throw new Error(
		`dialect-sql: ${fragment}(postgres) not implemented yet — Postgres backend is a later phase`,
	);
}

/** The embedding column's type. libSQL: native `F32_BLOB(dim)`; Postgres: pgvector `vector(dim)`. */
export function embColumnType(dialect: Dialect, dim: number): string {
	if (dialect === 'postgres') notYet('embColumnType');
	return `F32_BLOB(${dim})`;
}

/**
 * Value expression for inserting a FRESH embedding bound as a JSON-array string (`[1,2,3]`).
 * libSQL parses it with `vector(?)`; pgvector casts the same text with `?::vector`.
 */
export function embFreshExpr(dialect: Dialect): string {
	return dialect === 'postgres' ? '?::vector' : 'vector(?)';
}

/**
 * Value expression for REBINDING an embedding read back from an existing row (carry-forward
 * on `updateNode`). libSQL rebinds the raw `F32_BLOB` bytes directly (`?`); pgvector reads
 * `emb` back as its text form `[1,2,3]`, so it re-casts with `?::vector`.
 */
export function embRebindExpr(dialect: Dialect): string {
	return dialect === 'postgres' ? '?::vector' : '?';
}

/**
 * The partial live ANN index DDL (D5) — partial over live rows (`valid_to = FOREVER`).
 * libSQL: `libsql_vector_idx` function-expression index. Postgres: a pgvector HNSW
 * index (`USING hnsw (emb vector_cosine_ops)`), added when the Postgres adapter lands.
 */
export function vectorIndexDDL(dialect: Dialect): string {
	if (dialect === 'postgres') notYet('vectorIndexDDL');
	return `CREATE INDEX IF NOT EXISTS nv_emb_idx ON node_versions(libsql_vector_idx(emb, 'metric=cosine')) WHERE valid_to = ${FOREVER_LIT};`;
}

/**
 * The full-text index object(s). libSQL: an external-content FTS5 virtual table over
 * `node_versions` (`content_rowid='ver'`). Postgres: a generated `tsvector` column +
 * GIN index (no virtual table), added when the Postgres adapter lands.
 */
export function ftsTableDDL(dialect: Dialect): string {
	if (dialect === 'postgres') notYet('ftsTableDDL');
	return `CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(body, content='node_versions', content_rowid='ver');`;
}

/**
 * The FTS sync trigger. libSQL external-content FTS5 does NOT auto-sync, so an
 * `AFTER INSERT` trigger mirrors every new `node_versions` row (rowid = `ver`) into
 * `nodes_fts`. Postgres needs no trigger (a generated `tsvector` column self-maintains),
 * so this becomes an empty string there when the adapter lands.
 */
export function ftsTriggerDDL(dialect: Dialect): string {
	if (dialect === 'postgres') notYet('ftsTriggerDDL');
	return `CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON node_versions BEGIN
  INSERT INTO nodes_fts(rowid, body) VALUES (new.ver, new.body);
END;`;
}
