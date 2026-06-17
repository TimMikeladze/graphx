import { rmSync } from 'node:fs';
import process from 'node:process';
import { createClient } from '@libsql/client';
import { ulid } from 'ulidx';
import { type DbClient, dialectOf } from '../src/dialect.ts';
import { embExtract, embFreshExpr, jsonField } from '../src/dialect-sql.ts';
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

/** Selected backend. `libsql` (default) preserves current behavior; `postgres` opt-in via env. */
const DRIVER = process.env.GRAPHX_TEST_DRIVER ?? 'libsql';

/** The active test backend — for `test.skipIf(TEST_DRIVER === 'postgres')` on libSQL-only probes. */
export const TEST_DRIVER = DRIVER;

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

/** Postgres test connection string; override via env for CI / a different host. */
const PG_URL =
	process.env.GRAPHX_TEST_PG_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5455/graphx_test';

/** Provision a fresh, isolated test database + its teardown. */
export function makeTestDb(opts: MakeTestDbOpts = {}): TestDb {
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
