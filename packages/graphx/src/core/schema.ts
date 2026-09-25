import { applyConnPragmas } from './runtime.ts';
import { assertNever, type DbClient, type Dialect, dialectOf } from './dialect.ts';
import {
	duckdbSchema,
	embeddingsIndexDDL,
	embeddingsTableDDL,
	ftsTableDDL,
	ftsTriggerDDL,
	META_UPSERT_SQL,
	postgresSchema,
} from './dialect-sql.ts';
import { type Embedder, EmbeddingError } from './embedder.ts';

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
 * Full P1 DDL (§4 corrected + D1/B9). Every `CREATE` is `IF NOT EXISTS` so `init()` re-runs as
 * a no-op. `executeMultiple` runs the whole script (no `;`-splitting).
 *
 * Vectors are NOT here: `node_embeddings` is created by {@link init} once an embedder is known,
 * because its column width is the embedder's (see `dialect-sql.ts`'s `embeddingsTableDDL`).
 *
 * P13 (M2, §19.3): `nodes_fts` is an external-content FTS5 index over `node_versions`
 * (`content_rowid='ver'`) kept in sync by `nodes_fts_ai`; both are additive and join
 * the lexical seed list into hybrid retrieval.
 */
export function schema(dialect: Extract<Dialect, 'libsql' | 'sqlite'> = 'libsql'): string {
	return `
CREATE TABLE IF NOT EXISTS node_identity (id TEXT PRIMARY KEY);   -- ULID
CREATE TABLE IF NOT EXISTS edge_identity (id TEXT PRIMARY KEY);   -- ULID

CREATE TABLE IF NOT EXISTS node_versions (
  ver          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL REFERENCES node_identity(id),
  type         TEXT NOT NULL,
  body         TEXT,
  uri          TEXT,
  content_hash TEXT,
  content_type TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  valid_from   INTEGER NOT NULL,
  valid_to     INTEGER NOT NULL DEFAULT 8640000000000000
);
CREATE INDEX IF NOT EXISTS nv_asof ON node_versions(id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS nv_type ON node_versions(type);

-- Namespace-level facts: the embedding model + width, and the declared constraints.
CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- P13 (M2/§19.3): external-content FTS5 over node_versions, synced by the trigger below.
${ftsTableDDL(dialect)}
${ftsTriggerDDL(dialect)}

CREATE TABLE IF NOT EXISTS edge_versions (
  ver        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL REFERENCES edge_identity(id),
  src        TEXT NOT NULL REFERENCES node_identity(id),
  dst        TEXT NOT NULL REFERENCES node_identity(id),
  rel        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0),
  data      TEXT NOT NULL DEFAULT '{}',
  source     TEXT,
  valid_from INTEGER NOT NULL,
  valid_to   INTEGER NOT NULL DEFAULT 8640000000000000
);
CREATE INDEX IF NOT EXISTS ev_src_asof ON edge_versions(src, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ev_dst_asof ON edge_versions(dst, valid_from, valid_to);

CREATE VIEW IF NOT EXISTS nodes AS
  SELECT id, type, body, uri, content_hash, content_type, data
  FROM node_versions WHERE valid_to = 8640000000000000;
CREATE VIEW IF NOT EXISTS edges AS
  SELECT id, src, dst, rel, weight, data, source
  FROM edge_versions WHERE valid_to = 8640000000000000;

CREATE TABLE IF NOT EXISTS archival_state (
  table_name TEXT PRIMARY KEY, watermark INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- Eventing (Layer 2): durable, totally-ordered, delete-inclusive event log co-written into
-- each mutation's own transaction and tailed by outboxTail. AUTOINCREMENT is load-bearing —
-- a bare rowid is REUSED after a prune drain, which would strand client cursors on stale seqs.
-- \`source\` is provenance: NULL for a user write, 'trigger:<name>' for one made by a trigger
-- action. The trigger matcher excludes non-NULL sources by default, which is what stops a
-- trigger from consuming its own output and cascading without bound.
CREATE TABLE IF NOT EXISTS graph_outbox (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  op     TEXT NOT NULL,
  entity TEXT NOT NULL,
  id     TEXT NOT NULL,
  label  TEXT,
  src    TEXT,
  dst    TEXT,
  shape  TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  source TEXT
);

-- Eventing (Layer 3): trigger runner state. One cursor row per subscription name — the runner
-- resumes from it after a restart, which is the whole reason triggers ride the durable outbox
-- rather than the best-effort in-proc bus.
CREATE TABLE IF NOT EXISTS trigger_cursors (
  name       TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Events whose action exhausted its retries. Written so a poison event can be inspected instead
-- of wedging its subscription forever. \`trigger_name\` rather than \`trigger\` — the latter is a
-- reserved word in Postgres.
CREATE TABLE IF NOT EXISTS trigger_dead_letters (
  id           TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  event        TEXT NOT NULL,
  error        TEXT NOT NULL,
  attempts     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON trigger_dead_letters(subscription, created_at DESC);

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
CREATE TABLE IF NOT EXISTS node_scores (
  id          TEXT NOT NULL REFERENCES node_identity(id),
  metric      TEXT NOT NULL,
  score       REAL NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (id, metric)
);
CREATE INDEX IF NOT EXISTS ns_metric_score ON node_scores(metric, score);
CREATE INDEX IF NOT EXISTS na_degree ON node_analytics(degree);
`;
}

/** The embedding model and width a namespace was initialised with. */
export interface EmbeddingMeta {
	model: string;
	dim: number;
}

const META_MODEL = 'emb_model';
const META_DIM = 'emb_dim';

/**
 * The embedding model + width recorded in `graph_meta`, or `null` when the namespace has never
 * been initialised with an embedder (or does not exist yet).
 */
export async function readEmbeddingMeta(client: DbClient): Promise<EmbeddingMeta | null> {
	const r = await client
		.execute({
			sql: 'SELECT key, value FROM graph_meta WHERE key IN (?, ?)',
			args: [META_MODEL, META_DIM],
		})
		.catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
	let model: string | undefined;
	let dim: number | undefined;
	for (const row of r.rows) {
		if (row.key === META_MODEL) model = String(row.value);
		if (row.key === META_DIM) dim = Number(row.value);
	}
	return model !== undefined && dim !== undefined && Number.isFinite(dim) ? { model, dim } : null;
}

/**
 * Create the base schema on `client`, idempotent, and — when `embedder` is given — the vector
 * side table at its width, recording the model in `graph_meta`.
 *
 * A namespace that was initialised with a DIFFERENT embedder is refused ({@link EmbeddingError}
 * `code: 'model'`) rather than silently kept at the old width: `Graph.reembed` /
 * `graphx reembed` is the sanctioned way to switch models.
 */
export async function init(client: DbClient, embedder?: Embedder): Promise<void> {
	const dialect = dialectOf(client);
	switch (dialect) {
		case 'postgres':
			// Postgres: no per-connection pragmas (FKs always on, MVCC, WAL inherent). The
			// `vector` extension is expected to exist in `public` (on the search_path).
			await client.executeMultiple(postgresSchema());
			break;
		case 'duckdb':
			// No pragmas: FKs are not declared, there is no WAL to set, and there is no
			// lock-based contention to time out — the writer is serialized in-process.
			await client.executeMultiple(duckdbSchema());
			break;
		case 'libsql':
			await client.execute('PRAGMA journal_mode = WAL');
			await applyConnPragmas(client);
			await client.executeMultiple(schema(dialect));
			break;
		case 'sqlite':
			// The platform driver owns journal mode (OPFS may require rollback journaling).
			await applyConnPragmas(client);
			await client.executeMultiple(schema(dialect));
			// Require a working FTS index even if an executor failed to surface a DDL
			// error from its script API. Search must never silently become unavailable.
			await client.execute("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'graphx' LIMIT 0");
			break;
		default:
			assertNever(dialect, 'init');
	}
	if (embedder) await ensureEmbeddings(client, embedder);
}

/**
 * Make `client`'s namespace ready for `embedder`: create `node_embeddings` at its width and
 * record the model, or verify that the recorded model matches. With `replace: true` a
 * mismatch is resolved by DROPPING every stored vector and recreating the table for the new
 * model — the first step of a re-embed.
 */
export async function ensureEmbeddings(
	client: DbClient,
	embedder: Embedder,
	opts: { replace?: boolean } = {},
): Promise<EmbeddingMeta> {
	const dim = await embedder.resolveDim();
	const existing = await readEmbeddingMeta(client);
	if (existing && existing.model === embedder.id && existing.dim === dim) return existing;
	if (existing && !opts.replace) {
		throw new EmbeddingError(
			'model',
			`this namespace is embedded with '${existing.model}' (${existing.dim} dims) but the configured embedder is '${embedder.id}' (${dim} dims). ` +
				`Run \`graphx reembed\` (or Graph.reembed) to switch models, or point at a different namespace.`,
		);
	}
	if (existing) await dropEmbeddings(client);
	const d = dialectOf(client);
	if (d !== 'duckdb') await client.executeMultiple(embeddingsTableDDL(d, dim));
	await client.execute({ sql: META_UPSERT_SQL, args: [META_MODEL, embedder.id] });
	await client.execute({ sql: META_UPSERT_SQL, args: [META_DIM, String(dim)] });
	return { model: embedder.id, dim };
}

/** Remove every stored vector and the model record. DuckDB keeps its width-free table. */
export async function dropEmbeddings(client: DbClient): Promise<void> {
	if (dialectOf(client) === 'duckdb') {
		await client.execute('DELETE FROM node_embeddings');
	} else {
		await client.execute('DROP TABLE IF EXISTS node_embeddings');
	}
	await client.execute({
		sql: 'DELETE FROM graph_meta WHERE key IN (?, ?)',
		args: [META_MODEL, META_DIM],
	});
}

/** The ANN index DDL for `client`'s dialect (empty on DuckDB). For bulk-load bracketing. */
export function embeddingsIndexFor(client: DbClient): string {
	return embeddingsIndexDDL(dialectOf(client));
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
	// DuckDB has ADD COLUMN IF NOT EXISTS, so the probe is unnecessary; PRAGMA table_xinfo
	// does not exist there at all.
	if (dialectOf(client) === 'duckdb') {
		await client.execute(ddl.replace(/ADD COLUMN /i, 'ADD COLUMN IF NOT EXISTS '));
		return;
	}
	const info = await client.execute(`PRAGMA table_xinfo(${table})`);
	if (!info.rows.some((r) => String(r.name) === col)) {
		await client.execute(ddl);
	}
}
