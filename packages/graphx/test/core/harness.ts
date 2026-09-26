import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createClient } from '@libsql/client';
import { test } from 'bun:test';
import { ulid } from 'ulidx';
import { createBqlRemoteClient } from '../../src/core/bql.ts';
import type { Driver } from '../../src/core/db.ts';
import { type DbClient, dialectOf } from '../../src/core/dialect.ts';
import {
	embReadExpr,
	embValueExpr,
	insertOrIgnore,
	jsonField,
} from '../../src/core/dialect-sql.ts';
import { defineEmbedder, type Embedder } from '../../src/core/embedder.ts';
import { createDuckClient, type DuckClient } from '../../src/core/duck.ts';
import { duckDataDir } from '../../src/core/duck-pool.ts';
import { createPgClient, type PgClient } from '../../src/core/pg.ts';

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

/**
 * Directory holding every scratch database this process creates.
 *
 * These names used to be bare relative paths, resolved by the driver against the process
 * CWD — so a suite run from the repo root left its databases IN the repo root, and each
 * git worktree grew its own pile. Per-test `teardown()` removes them on the happy path,
 * but a thrown assertion, a `bun test` cancelled with Ctrl-C, or a crashed child skips it
 * entirely; the files are gitignored, so the strand grew silently to thousands of files.
 *
 * One per-process directory makes the whole strand removable at once, which the exit hook
 * below does even when individual teardowns were skipped.
 */
const SCRATCH_DIR = join(duckDataDir(), `run_${process.pid}`);

/** Absolute path for a scratch database file, creating {@link SCRATCH_DIR} on first use. */
function scratchPath(name: string): string {
	mkdirSync(SCRATCH_DIR, { recursive: true });
	return join(SCRATCH_DIR, name);
}

/**
 * Last-resort sweep: drop this run's whole scratch directory when the process ends,
 * regardless of how individual tests finished. `exit` fires for normal completion and for
 * a failing suite; the signal handlers cover Ctrl-C and a killed runner, which is how the
 * largest strands accumulated. Best-effort — a failure here must not fail the suite.
 */
let sweptScratch = false;
function sweepScratch(): void {
	if (sweptScratch) return;
	sweptScratch = true;
	try {
		rmSync(SCRATCH_DIR, { force: true, recursive: true });
	} catch {
		// Nothing useful to do at exit; the start-of-run sweep below is the real guarantee.
	}
}
process.once('exit', sweepScratch);
// Exit code is the shell's 128 + signal number, so a CI runner that reads the code still
// sees which signal ended the suite rather than a flat 130 for all three.
for (const [sig, num] of [
	['SIGINT', 2],
	['SIGTERM', 15],
	['SIGHUP', 1],
] as const) {
	process.once(sig, () => {
		sweepScratch();
		process.exit(128 + num);
	});
}

/**
 * Sweep scratch directories left by runs that are no longer alive.
 *
 * The exit hook above is best-effort: a `SIGKILL`, an OOM, or a runner that terminates
 * without draining Node's exit handlers all skip it, and those are exactly the runs that
 * leave the biggest strands behind. Reclaiming at STARTUP instead of relying on shutdown
 * makes the cleanup self-healing — a crashed run's files survive only until the next one.
 *
 * Liveness is probed with `kill(pid, 0)`, which signals nothing and merely tests whether
 * the process exists; a directory whose PID is still running belongs to a CONCURRENT run
 * and must be left alone.
 */
function sweepStaleScratchDirs(): void {
	const root = duckDataDir();
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return; // No data dir yet — nothing to reclaim.
	}
	for (const name of entries) {
		const pid = Number(name.startsWith('run_') ? name.slice(4) : Number.NaN);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		try {
			process.kill(pid, 0);
			continue; // Still running: a concurrent suite owns this directory.
		} catch {
			// ESRCH — the owner is gone, so its scratch is unreachable and safe to remove.
		}
		try {
			rmSync(join(root, name), { force: true, recursive: true });
		} catch {
			// Another runner may be reclaiming the same directory; losing the race is fine.
		}
	}
}
sweepStaleScratchDirs();

/** Selected backend. `libsql` (default) preserves current behavior; others opt in via env. */
const DRIVER = (process.env.GRAPHX_TEST_DRIVER ?? 'libsql') as Driver;

/** The active test backend. */
export const TEST_DRIVER: Driver = DRIVER;

/**
 * Gate for probes that assert libSQL INTERNALS — PRAGMA output, `sqlite_master` rows,
 * `EXPLAIN QUERY PLAN` index selection, `vector_top_k`, FTS5 virtual-table mechanics.
 * An ALLOWLIST, not a postgres denylist: the old `TEST_DRIVER === 'postgres' ? skip : test`
 * form ran all 18 of these under any third driver, where they cannot pass. The
 * user-facing contracts they cover are exercised by cross-backend tests.
 */
export const libsqlOnly = DRIVER === 'libsql' ? test : test.skip;

/**
 * Gate for probes that need a LOCAL connection: `PRAGMA` in its setting form, `journal_mode`,
 * an ATTACH, a second connection to a file this process owns.
 *
 * Under the `bql` driver the database lives in a bql.sh server, whose authorizer answers
 * `SQLITE_DENY` to a pragma that sets anything — the server states every connection setting
 * itself, which is what `DbClient.managedPragmas` records. Nothing here is a gap in the backend;
 * the setting is simply not the tenant's to make.
 */
export const localConnectionOnly = DRIVER === 'bql' ? test.skip : test;

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

/**
 * Gate for probes that assert a constraint is enforced by a DATABASE INDEX — a raw INSERT that
 * bypasses `Graph.addNode`/`addEdge` must still be rejected.
 *
 * libSQL and Postgres back `declareUniqueNodeProp` / `declareSingleValuedRel` with a partial
 * UNIQUE index, so the engine rejects the raw write. DuckDB has no partial unique index at all;
 * `duck-constraints.ts` enforces the same rules in application code on the `Graph` write path
 * instead. That is a deliberate difference, not a gap — the user-facing contract (a duplicate
 * through the SDK is rejected) is covered by cross-backend tests. Only the raw-SQL backstop is
 * absent, so only these probes are gated.
 */
export const indexBackedConstraints = DRIVER === 'duckdb' ? test.skip : test;

/** Runs only under DuckDB — the object-storage writer path. */
export const duckdbOnly = DRIVER === 'duckdb' ? test : test.skip;

/**
 * Dialect-correct embedding value expression for raw-SQL test fixtures that bind a JSON
 * embedding (e.g. `INSERT ... VALUES (..., ${embSql(client)}, ...)`). libSQL → `vector(?)`,
 * Postgres → `?::vector`.
 */
export function embSql(client: DbClient): string {
	return embValueExpr(dialectOf(client));
}

/** Dialect-correct expression for READING an embedding back as a JSON-array string in raw fixtures. */
export function embReadSql(client: DbClient): string {
	return embReadExpr(dialectOf(client));
}

/**
 * A deterministic test embedder from a per-text function. `dim` is inferred from the first
 * vector when omitted. The id defaults to `'stub'`, so every stub in one test agrees with the
 * namespace it initialised.
 */
export function stubEmbedder(
	fn: (text: string) => number[] | Promise<number[]>,
	opts: { id?: string; dim?: number } = {},
): Embedder {
	return defineEmbedder({
		id: opts.id ?? 'stub',
		dim: opts.dim,
		embed: (texts) => Promise.all(texts.map((t) => fn(t))),
	});
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

/** A running bql.sh server for `GRAPHX_TEST_DRIVER=bql`: its ORIGIN, and an admin key. */
const BQL_URL = process.env.GRAPHX_BQL_URL ?? 'http://127.0.0.1:4321';
const BQL_TOKEN = process.env.GRAPHX_BQL_TOKEN;

/** `DELETE /v1/db/:db` on teardown — creation is the driver's own job (`ensureDatabase`). An
 *  admin route, so the token must be an admin key. */
async function bqlAdmin(path: string, init: RequestInit): Promise<void> {
	const response = await fetch(`${BQL_URL}${path}`, {
		...init,
		headers: {
			'content-type': 'application/json',
			...(BQL_TOKEN ? { authorization: `Bearer ${BQL_TOKEN}` } : {}),
		},
	});
	if (!response.ok) {
		throw new Error(
			`bql.sh ${init.method} ${path} failed: ${response.status} ${await response.text()}`,
		);
	}
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
// getDb() (multi-tenant project DBs) goes to the same bql.sh server, one database per namespace.
if (DRIVER === 'bql') {
	process.env.GRAPHX_DB_DRIVER = 'bql';
	process.env.GRAPHX_BQL_URL = BQL_URL;
}

/** Provision a fresh, isolated test database + its teardown. */
export function makeTestDb(opts: MakeTestDbOpts = {}): TestDb {
	if (DRIVER === 'duckdb') {
		// A temp file rather than :memory:, so `sibling()` can open a second connection to
		// the same database — the concurrency suite needs two genuine connections, and an
		// in-memory DuckDB is private to its instance.
		const path = scratchPath(`test_${ulid()}.duckdb`);
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
				// `.tmp` is a DIRECTORY (DuckDB's spill for this database), so it needs
				// `recursive` — a plain unlink leaves gigabytes behind.
				for (const sfx of ['', '.wal']) rmSync(`${path}${sfx}`, { force: true });
				rmSync(`${path}.tmp`, { force: true, recursive: true });
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
	if (DRIVER === 'bql') {
		// One bql.sh database per test, which is the isolation model bql.sh is built for — the
		// analog of a fresh libSQL file or a fresh PG schema. Lower case: bql.sh's name rule is
		// `[a-z0-9][a-z0-9_-]{0,63}`.
		const database = `t${ulid().toLowerCase()}`;
		const client = (): DbClient =>
			createBqlRemoteClient({ url: BQL_URL, database, authToken: BQL_TOKEN });
		const clients = [client()];
		return {
			client: clients[0]!,
			// A second client on the same bql.sh database: two genuine writers, serialized by the
			// server's own single-writer lease rather than by SQLite's file lock.
			sibling: () => {
				const next = client();
				clients.push(next);
				return next;
			},
			teardown: async () => {
				for (const entry of clients) entry.close();
				// A database the driver never provisioned answers 404, which this ignores.
				await bqlAdmin(`/v1/db/${database}`, { method: 'DELETE' }).catch(() => {});
			},
		};
	}
	if (opts.file) {
		const path = scratchPath(`test_${ulid()}.db`);
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
