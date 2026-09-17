import { assertNever, type Dialect } from './dialect.ts';
import { bm25Cte, FTS_DDL } from './fts/index-tables.ts';

/**
 * Per-dialect SQL fragments. This is the home for every SQL string that genuinely
 * differs between backends. Ordinary SQLite shares scalar, JSON and FTS5 SQL with libSQL, but binds
 * vectors as JSON text and ranks them in portable code. Postgres and DuckDB use
 * their own SQL forms. Keep new backend differences here instead of rewriting
 * call sites in schema.ts/constraints.ts/etc.
 *
 * Keep the libSQL output byte-identical to the original inline SQL — the existing test
 * suite asserts behavior against these exact strings.
 */

/** FOREVER sentinel (max JS Date ms) inlined into partial-index / view predicates. */
const FOREVER_LIT = '8640000000000000';

/**
 * Scalar 2-argument max. libSQL overloads `MAX(a, b)` as a scalar; Postgres `max` is
 * strictly an aggregate, so the scalar form is `GREATEST(a, b)`.
 */
export function scalarMax(dialect: Dialect, a: string, b: string): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `MAX(${a}, ${b})`;
		case 'postgres':
			return `GREATEST(${a}, ${b})`;
		// DuckDB's max() is aggregate-only, same as Postgres.
		case 'duckdb':
			return `GREATEST(${a}, ${b})`;
		default:
			return assertNever(dialect, 'scalarMax');
	}
}

/**
 * Extract a top-level JSON string field from a `data` column. libSQL applies `->>` to
 * a TEXT JSON column directly; Postgres `->>` needs a `jsonb` operand, so the `text`
 * column is cast first. Returns the field as text in both.
 */
export function jsonField(dialect: Dialect, col: string, key: string): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `${col} ->> '${key}'`;
		case 'postgres':
			return `(${col})::jsonb ->> '${key}'`;
		// DuckDB's ->> takes a JSONPath, not a bare key, and json_extract returns JSON.
		// json_extract_string is the only form that yields an unquoted scalar.
		case 'duckdb':
			return `json_extract_string(${col}, '$.${key}')`;
		default:
			return assertNever(dialect, 'jsonField');
	}
}

/**
 * The integer type name for a `CAST(... AS …)` of an epoch-ms value. libSQL `INTEGER` is
 * 64-bit; Postgres `INTEGER` is 32-bit and overflows on millisecond timestamps, so it
 * must be `BIGINT`.
 */
export function epochIntType(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return 'INTEGER';
		case 'postgres':
			return 'BIGINT';
		// DuckDB's INTEGER is 32-bit, same trap as Postgres.
		case 'duckdb':
			return 'BIGINT';
		default:
			return assertNever(dialect, 'epochIntType');
	}
}

/**
 * Prop-equality predicate `<prop> = ?` for a `.where(alias, key, value)` filter. libSQL
 * uses `json_extract(col,'$.key')` (preserves the JSON scalar's type); Postgres extracts
 * as text via `(col)::jsonb ->> 'key'`, so the caller must bind the value as a string for
 * Postgres (text comparison) — see {@link jsonEqArg}.
 */
export function jsonEqExpr(dialect: Dialect, col: string, key: string): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `json_extract(${col}, '$.${key}') = ?`;
		case 'postgres':
			return `(${col})::jsonb ->> '${key}' = ?`;
		// Text comparison, so callers bind through jsonEqArg (below).
		case 'duckdb':
			return `json_extract_string(${col}, '$.${key}') = ?`;
		default:
			return assertNever(dialect, 'jsonEqExpr');
	}
}

/** The bound value for a {@link jsonEqExpr} filter — text on Postgres (the `->>` is text). */
export function jsonEqArg(dialect: Dialect, value: unknown): unknown {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return value;
		case 'postgres':
			if (value === null || value === undefined) return value;
			return typeof value === 'string' ? value : String(value);
		// Same text coercion as Postgres, for the same reason.
		case 'duckdb':
			return value === null || value === undefined
				? value
				: typeof value === 'string'
					? value
					: String(value);
		default:
			return assertNever(dialect, 'jsonEqArg');
	}
}

/**
 * "One row per key tuple" SELECT for keyset pagination. libSQL relies on `GROUP BY <keys>`
 * with bare non-aggregated columns (SQLite picks one row per group); Postgres forbids that,
 * so it uses `SELECT DISTINCT ON (<keys>)` (the matching `ORDER BY <keys>` is supplied by the
 * caller, which both dialects already emit). Returns the SELECT clause + the trailing GROUP BY
 * (empty on Postgres) to splice around the caller's FROM/WHERE.
 */
export function distinctSelect(
	dialect: Dialect,
	keys: string,
	cols: string,
): { select: string; group: string } {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return { select: `SELECT ${cols}`, group: `GROUP BY ${keys}` };
		case 'postgres':
			return { select: `SELECT DISTINCT ON (${keys}) ${cols}`, group: '' };
		// DuckDB implements Postgres-compatible DISTINCT ON, and rejects SQLite's bare-column
		// GROUP BY outright.
		case 'duckdb':
			return { select: `SELECT DISTINCT ON (${keys}) ${cols}`, group: '' };
		default:
			return assertNever(dialect, 'distinctSelect');
	}
}

/**
 * Full Postgres DDL, the dialect counterpart to libSQL's {@link import('./schema.ts').schema}.
 * Differences from the libSQL schema, all per the design doc:
 *  - `ver` is `bigint GENERATED ALWAYS AS IDENTITY` (no SQLite rowid alias);
 *  - temporal columns are `bigint` (hold the FOREVER sentinel 8.64e15 comfortably);
 *  - vectors live in `node_embeddings` (see {@link embeddingsTableDDL}), created by `init`
 *    once an embedder is known, as pgvector `vector(dim)` (the `vector` extension must exist in
 *    `public`, which is kept on every tenant's search_path);
 *  - full-text is a generated STORED `tsvector` column + GIN index (no FTS5 virtual
 *    table, no sync trigger — the column self-maintains and covers historical rows);
 *  - views use `CREATE OR REPLACE VIEW` (no `IF NOT EXISTS` form in PG);
 *  - `data` stays `text` (callers JSON.stringify/parse exactly as on libSQL).
 * Every `CREATE` is idempotent so it can re-run as a no-op.
 */
export function postgresSchema(): string {
	return `
CREATE TABLE IF NOT EXISTS node_identity (id text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS edge_identity (id text PRIMARY KEY);

CREATE TABLE IF NOT EXISTS node_versions (
  ver          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  id           text NOT NULL REFERENCES node_identity(id),
  type         text NOT NULL,
  body         text,
  uri          text,
  content_hash text,
  content_type text,
  data        text NOT NULL DEFAULT '{}',
  valid_from   bigint NOT NULL,
  valid_to     bigint NOT NULL DEFAULT ${FOREVER_LIT},
  body_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED
);
CREATE INDEX IF NOT EXISTS nv_asof ON node_versions(id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS nv_type ON node_versions(type);
CREATE INDEX IF NOT EXISTS nodes_fts_gin ON node_versions USING gin(body_tsv);

CREATE TABLE IF NOT EXISTS graph_meta (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE IF NOT EXISTS edge_versions (
  ver        bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  id         text NOT NULL REFERENCES edge_identity(id),
  src        text NOT NULL REFERENCES node_identity(id),
  dst        text NOT NULL REFERENCES node_identity(id),
  rel        text NOT NULL,
  weight     real NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  data      text NOT NULL DEFAULT '{}',
  source     text,
  valid_from bigint NOT NULL,
  valid_to   bigint NOT NULL DEFAULT ${FOREVER_LIT}
);
CREATE INDEX IF NOT EXISTS ev_src_asof ON edge_versions(src, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ev_dst_asof ON edge_versions(dst, valid_from, valid_to);

CREATE OR REPLACE VIEW nodes AS
  SELECT id, type, body, uri, content_hash, content_type, data
  FROM node_versions WHERE valid_to = ${FOREVER_LIT};
CREATE OR REPLACE VIEW edges AS
  SELECT id, src, dst, rel, weight, data, source
  FROM edge_versions WHERE valid_to = ${FOREVER_LIT};

CREATE TABLE IF NOT EXISTS archival_state (
  table_name text PRIMARY KEY, watermark bigint NOT NULL, updated_at bigint NOT NULL
);

-- Eventing (Layer 2): the Postgres counterpart of libSQL's graph_outbox. IDENTITY seq is
-- assigned at INSERT (not commit); outboxTail gates the tail on the snapshot xmin horizon so
-- a lower-seq row from a still-in-flight txn is never skipped (see temporal.ts).
CREATE TABLE IF NOT EXISTS graph_outbox (
  seq    bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  op     text NOT NULL,
  entity text NOT NULL,
  id     text NOT NULL,
  label  text,
  src    text,
  dst    text,
  shape  text NOT NULL,
  ts     bigint NOT NULL,
  source text
);
ALTER TABLE graph_outbox ADD COLUMN IF NOT EXISTS source text;

-- Eventing (Layer 3): trigger runner state. One cursor row per subscription name — the runner
-- resumes from it after a restart, which is the whole reason triggers ride the durable outbox
-- rather than the best-effort in-proc bus.
CREATE TABLE IF NOT EXISTS trigger_cursors (
  name       text PRIMARY KEY,
  seq        bigint NOT NULL,
  updated_at bigint NOT NULL
);

-- Events whose action exhausted its retries. Written so a poison event can be inspected instead
-- of wedging its subscription forever. \`trigger_name\` rather than \`trigger\` — the latter is a
-- reserved word in Postgres.
CREATE TABLE IF NOT EXISTS trigger_dead_letters (
  id           text PRIMARY KEY,
  subscription text NOT NULL,
  trigger_name text NOT NULL,
  seq          bigint NOT NULL,
  event        text NOT NULL,
  error        text NOT NULL,
  attempts     bigint NOT NULL,
  created_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON trigger_dead_letters(subscription, created_at DESC);

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

/**
 * Full DuckDB DDL — the third sibling of {@link schema} (libSQL) and {@link postgresSchema}.
 *
 * `node_versions`/`edge_versions` are REAL TABLES here, and `nodes`/`edges` are views
 * filtered to `valid_to = ${FOREVER_LIT}` — structurally the same shape as
 * {@link postgresSchema}. An earlier version of this function split `node_versions`/
 * `edge_versions` into separate live/history TABLES with UNION ALL compatibility views
 * standing in for the names every query uses, to route around DuckDB having no partial
 * indexes. That broke every write path in the codebase: `Graph.addNode`/`addEdge`/etc.
 * (graph.ts) and `bulkLoad`/`bulkEdges` (bulk.ts) all INSERT into `node_versions`/
 * `edge_versions` directly, and DuckDB refuses INSERT into a UNION ALL view ("Catalog
 * Error: node_versions is not an table"). The live/history split is real and valuable —
 * it is what makes Task 15's Parquet export cheap — but it belongs in the PARQUET LAYOUT
 * built at commit time, not in the local schema every write path targets directly.
 *
 * Other differences from libSQL, all forced:
 *  - `ver`/`seq` come from explicit SEQUENCEs — no rowid alias, no AUTOINCREMENT, no
 *    IDENTITY. The writer allocates from the manifest high-water marks rather than these
 *    at commit time (sequences are non-transactional), but the DEFAULT keeps ad-hoc SQL
 *    and the test suite working.
 *  - Temporal columns are `BIGINT`: DuckDB's INTEGER is 32-bit and FOREVER is 8.64e15.
 *  - `node_embeddings.emb` is `FLOAT[]`, not a fixed-size `FLOAT[dim]`. Parquet cannot
 *    preserve `FLOAT[N]` — even a pyarrow fixed_size_list reads back as a variable-length
 *    list — so the storage type is the one that survives a round trip. `list_cosine_distance`
 *    accepts it directly and measured faster than casting. The width is enforced by graphx
 *    before any INSERT, against the value recorded in `graph_meta`.
 *  - No partial index: DuckDB has no partial indexes, so unlike libSQL/Postgres this
 *    schema does NOT enforce "at most one live row per id" — that invariant is upheld by
 *    the serialized writer (Task 16) and application-level checks (Task 12) instead. See
 *    duck-schema.test.ts's "two live rows... are NOT rejected" test, which pins that this
 *    schema gives no backstop so nobody later mistakes silence here for enforcement.
 *  - No full-text objects and no ANN index: DuckDB has no triggers, its FTS extension
 *    cannot index a view, and its HNSW index cannot be partial, cannot index Parquet, and
 *    silently returns fewer rows than LIMIT under a WHERE filter. Both are built at commit
 *    time and shipped as Parquet instead (spec §10).
 */
export function duckdbSchema(): string {
	const nodeCols = `
  ver          BIGINT NOT NULL DEFAULT nextval('seq_ver'),
  id           TEXT NOT NULL REFERENCES node_identity(id),
  type         TEXT NOT NULL,
  body         TEXT,
  uri          TEXT,
  content_hash TEXT,
  content_type TEXT,
  data         TEXT NOT NULL DEFAULT '{}',
  valid_from   BIGINT NOT NULL,
  valid_to     BIGINT NOT NULL DEFAULT ${FOREVER_LIT}`;
	const edgeCols = `
  ver        BIGINT NOT NULL DEFAULT nextval('seq_ver'),
  id         TEXT NOT NULL REFERENCES edge_identity(id),
  src        TEXT NOT NULL REFERENCES node_identity(id),
  dst        TEXT NOT NULL REFERENCES node_identity(id),
  rel        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  data       TEXT NOT NULL DEFAULT '{}',
  source     TEXT,
  valid_from BIGINT NOT NULL,
  valid_to   BIGINT NOT NULL DEFAULT ${FOREVER_LIT}`;
	// The declared width is not enforceable on a FLOAT[] column, so `node_embeddings` is
	// static here and the width is recorded in graph_meta (and the manifest) by `init`.
	return `
CREATE SEQUENCE IF NOT EXISTS seq_ver START 1;
CREATE SEQUENCE IF NOT EXISTS seq_outbox START 1;

CREATE TABLE IF NOT EXISTS node_identity (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS edge_identity (id TEXT PRIMARY KEY);

CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
${embeddingsTableDDL('duckdb', 0)}

CREATE TABLE IF NOT EXISTS node_versions (${nodeCols},
  PRIMARY KEY (ver)
);
CREATE INDEX IF NOT EXISTS nv_asof ON node_versions(id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS nv_type ON node_versions(type);

CREATE TABLE IF NOT EXISTS edge_versions (${edgeCols},
  PRIMARY KEY (ver)
);
CREATE INDEX IF NOT EXISTS ev_src_asof ON edge_versions(src, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ev_dst_asof ON edge_versions(dst, valid_from, valid_to);

CREATE OR REPLACE VIEW nodes AS
  SELECT id, type, body, uri, content_hash, content_type, data
  FROM node_versions WHERE valid_to = ${FOREVER_LIT};
CREATE OR REPLACE VIEW edges AS
  SELECT id, src, dst, rel, weight, data, source
  FROM edge_versions WHERE valid_to = ${FOREVER_LIT};

CREATE TABLE IF NOT EXISTS archival_state (
  table_name TEXT PRIMARY KEY, watermark BIGINT NOT NULL, updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_outbox (
  seq    BIGINT PRIMARY KEY DEFAULT nextval('seq_outbox'),
  op     TEXT NOT NULL,
  entity TEXT NOT NULL,
  id     TEXT NOT NULL,
  label  TEXT,
  src    TEXT,
  dst    TEXT,
  shape  TEXT NOT NULL,
  ts     BIGINT NOT NULL,
  source TEXT
);

CREATE TABLE IF NOT EXISTS trigger_cursors (
  name TEXT PRIMARY KEY, seq BIGINT NOT NULL, updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS trigger_dead_letters (
  id           TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  seq          BIGINT NOT NULL,
  event        TEXT NOT NULL,
  error        TEXT NOT NULL,
  attempts     BIGINT NOT NULL,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON trigger_dead_letters(subscription, created_at DESC);

CREATE TABLE IF NOT EXISTS node_analytics (
  id          TEXT PRIMARY KEY,
  pagerank    REAL,
  community   BIGINT,
  degree      BIGINT,
  computed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS na_pagerank ON node_analytics(pagerank);
CREATE INDEX IF NOT EXISTS na_community ON node_analytics(community);
CREATE INDEX IF NOT EXISTS na_degree ON node_analytics(degree);
${FTS_DDL}
`;
}

function notYet(fragment: string, dialect: Dialect): never {
	throw new Error(`dialect-sql: ${fragment}(${dialect}) not implemented yet`);
}

/**
 * The vector side table + its ANN index. Created by `init` once an embedder is known (libSQL and
 * Postgres bake the width into the column type; DuckDB's `FLOAT[]` is width-free, so its table
 * is part of the base schema and `dim` is ignored). SQLite stores JSON text with
 * an array-length constraint and no ANN index. One row per `(id, chunk)`; `text` is the
 * chunk's text, or NULL when the row is the node's whole embedding input.
 */
export function embeddingsTableDDL(dialect: Dialect, dim: number): string {
	switch (dialect) {
		case 'sqlite':
			return `CREATE TABLE IF NOT EXISTS node_embeddings (
  id         TEXT NOT NULL REFERENCES node_identity(id),
  chunk      INTEGER NOT NULL DEFAULT 0,
  text       TEXT,
  emb        TEXT NOT NULL CHECK (json_valid(emb) AND json_type(emb) = 'array' AND json_array_length(emb) = ${dim}),
  embed_hash TEXT NOT NULL,
  PRIMARY KEY (id, chunk)
);`;
		case 'libsql':
			return `CREATE TABLE IF NOT EXISTS node_embeddings (
  id         TEXT NOT NULL REFERENCES node_identity(id),
  chunk      INTEGER NOT NULL DEFAULT 0,
  text       TEXT,
  emb        F32_BLOB(${dim}) NOT NULL,
  embed_hash TEXT NOT NULL,
  PRIMARY KEY (id, chunk)
);
${embeddingsIndexDDL('libsql')}`;
		case 'postgres':
			return `CREATE TABLE IF NOT EXISTS node_embeddings (
  id         text NOT NULL REFERENCES node_identity(id),
  chunk      integer NOT NULL DEFAULT 0,
  text       text,
  emb        vector(${dim}) NOT NULL,
  embed_hash text NOT NULL,
  PRIMARY KEY (id, chunk)
);
${embeddingsIndexDDL('postgres')}`;
		case 'duckdb':
			return `CREATE TABLE IF NOT EXISTS node_embeddings (
  id         TEXT NOT NULL,
  chunk      INTEGER NOT NULL DEFAULT 0,
  text       TEXT,
  emb        FLOAT[] NOT NULL,
  embed_hash TEXT NOT NULL,
  PRIMARY KEY (id, chunk)
);`;
		default:
			return assertNever(dialect, 'embeddingsTableDDL');
	}
}

/**
 * The ANN index over `node_embeddings`. libSQL: a `libsql_vector_idx` (DiskANN) function
 * index; Postgres: pgvector HNSW over `vector_cosine_ops`. Neither is partial any more — every
 * row in the side table is a live vector, so the whole table is the live set. DuckDB has no
 * ANN index (brute-force `list_cosine_distance` scan). Exported so `bulkLoad` / `reembed` can
 * drop it before a large load and recreate it afterwards.
 */
export function embeddingsIndexDDL(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
			return '';
		case 'libsql':
			return `CREATE INDEX IF NOT EXISTS ne_emb_idx ON node_embeddings(libsql_vector_idx(emb, 'metric=cosine'));`;
		case 'postgres':
			return `CREATE INDEX IF NOT EXISTS ne_emb_idx ON node_embeddings USING hnsw (emb vector_cosine_ops);`;
		case 'duckdb':
			return '';
		default:
			return assertNever(dialect, 'embeddingsIndexDDL');
	}
}

/**
 * Value expression for binding a vector as a JSON-array string (`[1,2,3]`). libSQL parses it
 * with `vector(?)`; pgvector casts the same text with `?::vector`; DuckDB parses it with
 * `from_json`.
 */
export function embValueExpr(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
			return '?';
		case 'libsql':
			return 'vector(?)';
		case 'postgres':
			return '?::vector';
		case 'duckdb':
			return `from_json(?, '["FLOAT"]')`;
		default:
			return assertNever(dialect, 'embValueExpr');
	}
}

/** Read `emb` back as a JSON-array string. libSQL `vector_extract`; pgvector's text form IS `[..]`. */
export function embReadExpr(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
			return 'emb';
		case 'libsql':
			return 'vector_extract(emb)';
		case 'postgres':
			return 'emb';
		// to_json renders a parseable array. A bare ::VARCHAR cast would emit `nan`/`inf`
		// for non-finite floats and break JSON.parse.
		case 'duckdb':
			return 'to_json(emb)';
		default:
			return assertNever(dialect, 'embReadExpr');
	}
}

/**
 * The nearest `k` vector rows to a query embedding, best first, with their cosine DISTANCE.
 * Rows are chunks; the caller groups them to nodes. `bind(qJson, k)` supplies the bound args in
 * the order the dialect's SQL consumes them.
 *
 * libSQL: `vector_top_k` over the DiskANN index, joined by rowid, re-scored with
 * `vector_distance_cos` so the ORDER is by true distance (the function's row order is a
 * candidate order, and the rowid it returns is not a rank). Postgres: HNSW-backed
 * `ORDER BY emb <=> q`. DuckDB: brute-force scan.
 */
export function annSeeds(dialect: Dialect): {
	sql: string;
	bind: (qJson: string, k: number) => (string | number)[];
} {
	switch (dialect) {
		case 'sqlite':
			throw new Error('annSeeds: SQLite uses portable exact ranking; call vectorSeedRows instead');
		case 'libsql':
			return {
				sql: `SELECT e.id AS id, e.chunk AS chunk, e.text AS text, vector_distance_cos(e.emb, vector(?)) AS dist
FROM vector_top_k('ne_emb_idx', vector(?), ?) v
JOIN node_embeddings e ON e.rowid = v.id
ORDER BY dist, e.id, e.chunk
LIMIT ?`,
				bind: (q, k) => [q, q, k, k],
			};
		case 'postgres':
			return {
				sql: `SELECT id, chunk, text, (emb <=> ?::vector) AS dist
FROM node_embeddings
ORDER BY dist, id, chunk
LIMIT ?`,
				bind: (q, k) => [q, k],
			};
		case 'duckdb':
			return {
				sql: `SELECT id, chunk, text, list_cosine_distance(emb, from_json(?, '["FLOAT"]')) AS dist
FROM node_embeddings
ORDER BY dist, id, chunk
LIMIT ?`,
				bind: (q, k) => [q, k],
			};
		default:
			return assertNever(dialect, 'annSeeds');
	}
}

/** `INSERT ... ON CONFLICT DO UPDATE` upsert for one `graph_meta` row. Portable across all three. */
export const META_UPSERT_SQL: string =
	'INSERT INTO graph_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';

/**
 * A Postgres `tsquery` that ORs the query's terms. Consumes ONE bound arg: the raw query text.
 *
 * `websearch_to_tsquery` — the obvious choice, and what this used to be — ANDs its terms, while
 * libSQL's {@link sanitizeMatch} joins them with `OR`. Same API, opposite recall: a multi-term
 * query only matched on Postgres if a SINGLE document contained every stem, so the lexical leg
 * usually returned nothing and hybrid retrieval silently degraded to vector-only. Measured on the
 * evaluation corpus before this fix: lexical recall@6 of 0.236 on Postgres against 0.778 on
 * libSQL. The two backends are documented as interchangeable, so `OR` (the higher-recall reading,
 * and the one the fusion step is designed around) is now what both do.
 *
 * Every fragment is a `tsquery` that Postgres itself produced and rendered back to text, so the
 * lexemes are already quoted and escaped — no user input ever reaches `tsquery` syntax, which is
 * what `sanitizeMatch` buys on the libSQL side. Terms the dictionary drops entirely (stopwords)
 * render as `''` and are filtered out; a query of nothing but stopwords aggregates to NULL, and
 * `body_tsv @@ NULL` matches no rows.
 */
function tsQueryOr(): string {
	return `(SELECT NULLIF(string_agg(t.pq, ' | '), '')::tsquery
	FROM (
		SELECT plainto_tsquery('english', tok)::text AS pq
		FROM unnest(string_to_array(?, ' ')) AS tok
	) t
	WHERE t.pq <> '')`;
}

/**
 * Full-text WHERE predicate on a `node_versions` alias. libSQL joins the external-content
 * FTS5 table by rowid (`ver IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)`, bound
 * arg = a sanitized FTS5 expression); Postgres matches the generated `body_tsv` column against
 * {@link tsQueryOr} (bound arg = the RAW query text). Callers gate both on "has usable tokens"
 * before binding.
 */
export function ftsWhere(dialect: Dialect, alias: string): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `${alias}.ver IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)`;
		case 'postgres':
			return `${alias}.body_tsv @@ ${tsQueryOr()}`;
		// Membership only — no scoring. This is a filter on a scan the caller already
		// orders, so computing BM25 here would be work whose result is discarded.
		case 'duckdb':
			return `${alias}.ver IN (
				SELECT t.ver FROM fts_terms t
				WHERE t.term IN (SELECT unnest(from_json(?, '["VARCHAR"]')))
			)`;
		default:
			return assertNever(dialect, 'ftsWhere');
	}
}

/**
 * Live full-text seed list (id only, best-first). Bound args: ftsArg, k — where ftsArg is a
 * sanitized FTS5 expression (libSQL) or the raw query text (Postgres). Postgres binds the
 * `tsquery` once via a CTE so the arg count matches libSQL's.
 */
export function ftsSeedLive(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `SELECT n.id AS id
FROM nodes_fts
JOIN node_versions n ON n.ver = nodes_fts.rowid
WHERE nodes_fts MATCH ? AND n.valid_to = ${FOREVER_LIT}
ORDER BY rank
LIMIT ?`;
		case 'postgres':
			return `WITH q AS (SELECT ${tsQueryOr()} AS tq)
SELECT n.id AS id
FROM node_versions n, q
WHERE n.body_tsv @@ q.tq AND n.valid_to = ${FOREVER_LIT}
ORDER BY ts_rank_cd(n.body_tsv, q.tq) DESC
LIMIT ?`;
		// BM25 over the live index, joined back to logical ids. Args: terms JSON, k.
		case 'duckdb':
			return `WITH scored AS (${bm25Cte('live')})
SELECT n.id AS id
FROM scored
JOIN node_versions n ON n.ver = scored.ver
WHERE n.valid_to = ${FOREVER_LIT}
ORDER BY scored.score DESC, n.id
LIMIT ?`;
		default:
			return assertNever(dialect, 'ftsSeedLive');
	}
}

/** As-of full-text seed list. Bound args: ftsArg, t, t, k (Postgres binds tsquery once via CTE). */
export function ftsSeedAsOf(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `SELECT n.id AS id
FROM nodes_fts
JOIN node_versions n ON n.ver = nodes_fts.rowid
WHERE nodes_fts MATCH ? AND n.valid_from <= ? AND ? < n.valid_to
ORDER BY rank
LIMIT ?`;
		case 'postgres':
			return `WITH q AS (SELECT ${tsQueryOr()} AS tq)
SELECT n.id AS id
FROM node_versions n, q
WHERE n.body_tsv @@ q.tq AND n.valid_from <= ? AND ? < n.valid_to
ORDER BY ts_rank_cd(n.body_tsv, q.tq) DESC
LIMIT ?`;
		// The index covers every version, so the as-of match is exact rather than the
		// over-fetch-and-filter the live-only ANN index forces. Args: terms JSON, t, t, k.
		case 'duckdb':
			return `WITH scored AS (${bm25Cte('all')})
SELECT n.id AS id
FROM scored
JOIN node_versions n ON n.ver = scored.ver
WHERE n.valid_from <= ? AND ? < n.valid_to
ORDER BY scored.score DESC, n.id
LIMIT ?`;
		default:
			return assertNever(dialect, 'ftsSeedAsOf');
	}
}

/**
 * Build an idempotent INSERT. libSQL uses the `INSERT OR IGNORE` prefix; Postgres appends
 * `ON CONFLICT DO NOTHING`. `values` is the full VALUES clause body, e.g. `(?)` or `(?,?,?)`.
 */
export function insertOrIgnore(
	dialect: Dialect,
	table: string,
	columns: string,
	values: string,
): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `INSERT OR IGNORE INTO ${table} (${columns}) VALUES ${values}`;
		case 'postgres':
			return `INSERT INTO ${table} (${columns}) VALUES ${values} ON CONFLICT DO NOTHING`;
		// DuckDB accepts SQLite's OR IGNORE prefix verbatim.
		case 'duckdb':
			return `INSERT OR IGNORE INTO ${table} (${columns}) VALUES ${values}`;
		default:
			return assertNever(dialect, 'insertOrIgnore');
	}
}

/** Expand a JSON-array string param into a single `id` column of rows. libSQL `json_each`, PG `jsonb_array_elements_text`. */
export function jsonArrayRows(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `SELECT value AS id FROM json_each(?)`;
		case 'postgres':
			return `SELECT jsonb_array_elements_text(?::jsonb) AS id`;
		// No json_each and no jsonb_array_elements_text. from_json with an explicit VARCHAR
		// element type is what keeps the ids unquoted.
		case 'duckdb':
			return `SELECT unnest(from_json(?, '["VARCHAR"]')) AS id`;
		default:
			return assertNever(dialect, 'jsonArrayRows');
	}
}

/**
 * The full-text index object(s). libSQL: an external-content FTS5 virtual table over
 * `node_versions` (`content_rowid='ver'`). Postgres: a generated `tsvector` column +
 * GIN index (no virtual table), added when the Postgres adapter lands.
 */
export function ftsTableDDL(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(body, content='node_versions', content_rowid='ver');`;
		case 'postgres':
			return notYet('ftsTableDDL', dialect);
		// No FTS objects: no triggers, and the FTS extension cannot index a view. Built at
		// commit time and shipped as Parquet (spec §10).
		case 'duckdb':
			return '';
		default:
			return assertNever(dialect, 'ftsTableDDL');
	}
}

/**
 * The FTS sync trigger. libSQL external-content FTS5 does NOT auto-sync, so an
 * `AFTER INSERT` trigger mirrors every new `node_versions` row (rowid = `ver`) into
 * `nodes_fts`. Postgres needs no trigger (a generated `tsvector` column self-maintains),
 * so this becomes an empty string there when the adapter lands.
 */
export function ftsTriggerDDL(dialect: Dialect): string {
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			return `CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON node_versions BEGIN
  INSERT INTO nodes_fts(rowid, body) VALUES (new.ver, new.body);
END;`;
		case 'postgres':
			return notYet('ftsTriggerDDL', dialect);
		// No triggers in DuckDB. See ftsTableDDL.
		case 'duckdb':
			return '';
		default:
			return assertNever(dialect, 'ftsTriggerDDL');
	}
}
