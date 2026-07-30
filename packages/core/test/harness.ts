import { rmSync } from 'node:fs';
import process from 'node:process';
import { createClient } from '@libsql/client';
import { test } from 'bun:test';
import { ulid } from 'ulidx';
import { type DbClient, type Dialect, dialectOf } from '../src/dialect.ts';
import { embExtract, embFreshExpr, insertOrIgnore, jsonField } from '../src/dialect-sql.ts';
import { createDuckClient, type DuckClient } from '../src/duck.ts';
import { createPgClient, type PgClient } from '../src/pg.ts';

/**
 * Test DB harness — the ONE place tests obtain a database connection, so the whole
 * suite can run against either backend by flipping `GRAPHX_TEST_DRIVER`. Tests must not
 * call `createClient` directly; they call {@link makeTestDb} and then their own
 * `init(client, dim)` (the harness stays dim-agnostic). The libSQL path is the default
 * and preserves today's behavior exactly (`:memory:`, or a temp `file:` DB for the
 * interactive-transaction tests). The `postgres` path is wired in a later phase.
 */

export interface TestDb {
	client: DbClient;
	/**
	 * On a `file: true` libSQL DB, a sibling-connection factory pointing at the SAME
	 * underlying database — for the few tests that need genuine multi-connection write-lock
	 * contention. `undefined` for `:memory:` (no shareable path) and on Postgres.
	 */
	sibling?: () => DbClient;
	/** Close the connection and remove any temp files (or drop the schema, on Postgres). */
	teardown: () => Promise<void>;
}

export interface MakeTestDbOpts {
	/**
	 * The test uses interactive `transaction('write')` (updateNode / deleteEdge /
	 * single-valued addEdge). On libSQL a `:memory:` connection is detached by
	 * `transaction()`, so those tests need a real `file:` DB; Postgres ignores this.
	 */
	file?: boolean;
}

/** Selected backend. `libsql` (default) preserves current behavior; others opt in via env. */
const DRIVER = (process.env.GRAPHX_TEST_DRIVER ?? 'libsql') as Dialect;

/** The active test backend. */
export const TEST_DRIVER: Dialect = DRIVER;

/**
 * Gate for probes that assert libSQL INTERNALS — PRAGMA output, `sqlite_master` rows,
 * `EXPLAIN QUERY PLAN` index selection, `vector_top_k`, FTS5 virtual-table mechanics.
 * An ALLOWLIST, not a postgres denylist: the old `TEST_DRIVER === 'postgres' ? skip : test`
 * form ran all 18 of these under any third driver, where they cannot pass. The
 * user-facing contracts they cover are exercised by cross-backend tests.
 */
export const libsqlOnly = DRIVER === 'libsql' ? test : test.skip;

/**
 * Gate for probes that need TWO genuine writers against ONE database — write-lock
 * contention, `SQLITE_BUSY`, a held transaction blocking another connection.
 *
 * DuckDB has no such configuration: `sibling()` opens a second `DuckDBInstance` on the same
 * file, which does not share the first one's state, so a "concurrent writer" there writes
 * into a database nobody else can see. Its writers are serialized in-process by the
 * adapter's mutex and across processes by the manifest CAS, and the same invariants are
 * asserted through those mechanisms instead — see the duckdb block in p14-concurrency.
 */
export const sharedWriterOnly = DRIVER === 'duckdb' ? test.skip : test;

/** Runs only under DuckDB — the object-storage writer path. */
export const duckdbOnly = DRIVER === 'duckdb' ? test : test.skip;

/**
 * Dialect-correct embedding value expression for raw-SQL test fixtures that bind a JSON
 * embedding (e.g. `INSERT ... VALUES (..., ${embSql(client)}, ...)`). libSQL → `vector(?)`,
 * Postgres → `?::vector`.
 */
export function embSql(client: DbClient): string {
	return embFreshExpr(dialectOf(client));
}

/** Dialect-correct expression for READING an embedding back as a JSON-array string in raw fixtures. */
export function embReadSql(client: DbClient): string {
	return embExtract(dialectOf(client));
}

/** Dialect-correct `col ->> 'key'` JSON text extraction for raw-SQL test assertions. */
export function jsonFieldSql(client: DbClient, col: string, key: string): string {
	return jsonField(dialectOf(client), col, key);
}

/** Query that returns one row iff `table` exists in the client's schema (sqlite_master / information_schema). */
export function tableExistsSql(client: DbClient, table: string): string {
	switch (dialectOf(client)) {
		case 'postgres':
			return `SELECT table_name AS name FROM information_schema.tables WHERE table_name = '${table}' AND table_schema = current_schema()`;
		case 'duckdb':
			return `SELECT table_name AS name FROM duckdb_tables() WHERE table_name = '${table}'
			        UNION ALL SELECT view_name AS name FROM duckdb_views() WHERE view_name = '${table}'`;
		default:
			return `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`;
	}
}

/** Dialect-correct idempotent INSERT for raw-SQL fixtures (libSQL OR IGNORE / PG ON CONFLICT). */
export function insertOrIgnoreSql(
	client: DbClient,
	table: string,
	columns: string,
	values: string,
): string {
	return insertOrIgnore(dialectOf(client), table, columns, values);
}

/** Postgres test connection string; override via env for CI / a different host. */
const PG_URL =
	process.env.GRAPHX_TEST_PG_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5455/graphx_test';

// Importing the harness under the postgres driver wires getDb() (multi-tenant project DBs)
// to the same Postgres — schema-per-tenant — and registers the pg adapter (via the pg.ts import).
if (DRIVER === 'postgres') {
	process.env.GRAPHX_DB_DRIVER = 'postgres';
	process.env.GRAPHX_PG_URL = PG_URL;
}
if (DRIVER === 'duckdb') {
	process.env.GRAPHX_DB_DRIVER = 'duckdb';
}

/** Provision a fresh, isolated test database + its teardown. */
export function makeTestDb(opts: MakeTestDbOpts = {}): TestDb {
	if (DRIVER === 'duckdb') {
		// A temp file rather than :memory:, so `sibling()` can open a second connection to
		// the same database — the concurrency suite needs two genuine connections, and an
		// in-memory DuckDB is private to its instance.
		const path = `test_${ulid()}.duckdb`;
		const main = createDuckClient({ path });
		const siblings: DuckClient[] = [];
		return {
			client: main,
			sibling: () => {
				const s = createDuckClient({ path });
				siblings.push(s);
				return s;
			},
			teardown: async () => {
				for (const s of siblings) await s.end().catch(() => {});
				await main.end().catch(() => {});
				for (const sfx of ['', '.wal']) rmSync(`${path}${sfx}`, { force: true });
			},
		};
	}
	if (DRIVER === 'postgres') {
		// Each test gets its own Postgres schema (the schema-per-tenant isolation model),
		// dropped on teardown — the analog of a fresh libSQL file. `file` is irrelevant on
		// PG (interactive transactions work on any pooled connection).
		const schema = `test_${ulid().toLowerCase()}`;
		const main = createPgClient({
			connectionString: PG_URL,
			schema,
			ensureSchema: true,
			ensureExtension: true,
		});
		const siblings: PgClient[] = [];
		return {
			client: main,
			sibling: () => {
				const s = createPgClient({ connectionString: PG_URL, schema });
				siblings.push(s);
				return s;
			},
			teardown: async () => {
				// Drop the schema via a FRESH connection — a test may have already closed
				// `main` (e.g. per-test client.close()), which would dead-pool a drop on it.
				for (const s of siblings) await s.end().catch(() => {});
				await main.end().catch(() => {});
				const admin = createPgClient({ connectionString: PG_URL });
				try {
					await admin.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
				} finally {
					await admin.end();
				}
			},
		};
	}
	if (opts.file) {
		const path = `test_${ulid()}.db`;
		const client = createClient({ url: `file:${path}` });
		const siblings: DbClient[] = [];
		return {
			client,
			sibling: () => {
				const s = createClient({ url: `file:${path}` });
				siblings.push(s);
				return s;
			},
			teardown: async () => {
				client.close();
				for (const s of siblings) s.close();
				for (const sfx of ['', '-wal', '-shm']) rmSync(`${path}${sfx}`, { force: true });
			},
		};
	}
	const client = createClient({ url: ':memory:' });
	return { client, teardown: async () => client.close() };
}
