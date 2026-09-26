import process from 'node:process';
import { createClient } from '@libsql/client';
import { type DbClient, type Dialect } from './dialect.ts';

// Preserve the existing native entry's helper imports; ownership lives in runtime.ts.
export {
	FOREVER,
	applyConnPragmas,
	managedWriter,
	ftsIndexOwner,
	type ManagedWriter,
	type FtsIndexOwner,
} from './runtime.ts';

/**
 * Which backend implementation {@link getDb} builds.
 *
 * A superset of {@link Dialect}, and deliberately a SEPARATE type: `bunql` is a driver, not a
 * dialect. BunQL is a plain libsqlite3, so its clients speak the `sqlite` dialect graphx already
 * has — widening `Dialect` instead would turn every exhaustive `switch (dialect)` in the codebase
 * into a compile error for a backend that needs no new SQL at all.
 */
export type Driver = Dialect | 'bunql';

/**
 * Connection config for {@link getDb}. The `driver` discriminator selects the backend
 * (default `libsql`); the libSQL fields apply when `driver === 'libsql'`, the Postgres
 * fields when `driver === 'postgres'`. Omitting `driver` falls back to the
 * `GRAPHX_DB_DRIVER` env var, then libSQL — so existing callers are unaffected.
 */
export interface DbConfig {
	/** Backend selector. Default: `GRAPHX_DB_DRIVER` env, else `'libsql'`. */
	driver?: Driver;
	// Postgres
	/** libpq connection string (or `GRAPHX_PG_URL` env). The namespace becomes a PG schema. */
	connectionString?: string;
	ssl?: boolean | import('node:tls').ConnectionOptions;
	poolMax?: number;
	/**
	 * `'auto'` (default) detects a transaction pooler (PgBouncer and friends) in front of Postgres
	 * and applies the tenant `search_path` per transaction instead of at connect time;
	 * `'transaction'` assumes one; `'none'` never switches. See `PgPoolerMode` in `graphx/pg`.
	 */
	pooler?: 'auto' | 'transaction' | 'none';
	// libSQL
	authToken?: string;
	syncUrl?: string;
	syncInterval?: number;
	// BunQL
	/** A BunQL server's ORIGIN (or `GRAPHX_BUNQL_URL`); the namespace becomes the database name.
	 *  `authToken` is the BunQL admin key or a minted token (or `GRAPHX_BUNQL_TOKEN`). */
	bunqlUrl?: string;
	// DuckDB
	/** Local database path. Defaults to `<namespace>.duckdb`, or `:memory:` when `bucket`
	 *  is set — a bucket-backed local database is a disposable materialization. */
	duckPath?: string;
	/** Object-storage bucket. When set, the namespace becomes a key prefix beneath it. */
	bucket?: string;
	prefix?: string;
	cacheDir?: string;
	endpoint?: string;
	region?: string;
	/** Pin reads to one snapshot instead of following head. */
	snapshot?: number;
}

/** Builds a Postgres {@link DbClient} for a namespace. Registered by `core/pg` on import. */
export type PgDriverFactory = (namespace: string, cfg: DbConfig) => DbClient;
let pgFactory: PgDriverFactory | undefined;

/**
 * Register the Postgres adapter factory. Called as a side effect of importing the
 * `core/pg` subpath (or `./pg.ts`), so `pg` stays an OPTIONAL peer — never loaded for
 * libSQL-only consumers, who never import that subpath.
 */
export function registerPgDriver(factory: PgDriverFactory): void {
	pgFactory = factory;
}

/** Builds a DuckDB {@link DbClient} for a namespace. Registered by `core/duck` on import. */
export type DuckDriverFactory = (namespace: string, cfg: DbConfig) => DbClient;
let duckFactory: DuckDriverFactory | undefined;

/**
 * Register the DuckDB adapter factory. Called as a side effect of importing the
 * `core/duck` subpath, so `@duckdb/node-api` stays an OPTIONAL peer — it is ~123MB
 * installed and is never loaded for consumers who do not opt in.
 */
export function registerDuckDriver(factory: DuckDriverFactory): void {
	duckFactory = factory;
}

/** Builds a BunQL {@link DbClient} for a namespace. Registered by `core/bunql` on import. */
export type BunqlDriverFactory = (namespace: string, cfg: DbConfig) => DbClient;
let bunqlFactory: BunqlDriverFactory | undefined;

/**
 * Register the BunQL adapter factory. Called as a side effect of importing the `core/bunql`
 * subpath, so `@bunql/db` stays an OPTIONAL peer — the remote driver needs only
 * `@libsql/client`, and the embedded one is typed structurally.
 */
export function registerBunqlDriver(factory: BunqlDriverFactory): void {
	bunqlFactory = factory;
}

function resolveDriver(cfg: DbConfig): Driver {
	if (cfg.driver) return cfg.driver;
	const env = process.env.GRAPHX_DB_DRIVER;
	if (env === 'postgres' || env === 'duckdb' || env === 'sqlite' || env === 'bunql') return env;
	return 'libsql';
}

const clients = new Map<string, DbClient>();

/**
 * One cached client per project namespace (B7/§3.2). NEVER a global singleton —
 * that would collapse every tenant into one DB and destroy the §2.9 isolation
 * guarantee. `namespace` is the control-plane `db_namespace` (e.g. `acme__alpha`).
 *
 * libSQL: a file/replica per namespace (addressed off `SQLD_URL` in replica mode).
 * Postgres: schema-per-tenant — the namespace becomes a PG schema on a shared pool
 * (requires importing `core/pg` to register the adapter).
 * BunQL: one BunQL database per namespace on a server that holds thousands of them
 * (requires importing `core/bunql`; the client speaks the `sqlite` dialect).
 */
export function getDb(namespace: string, cfg: DbConfig = {}): DbClient {
	const driver = resolveDriver(cfg);
	if (driver === 'sqlite') {
		throw new Error(
			"getDb: sqlite requires a platform connection; use createConnectionClient(connection, 'sqlite') from 'graphx/core'",
		);
	}
	if (driver !== 'libsql' && driver !== 'postgres' && driver !== 'duckdb' && driver !== 'bunql') {
		throw new Error(`getDb: unsupported driver ${String(driver)}`);
	}
	const existing = clients.get(namespace);
	if (existing) return existing;
	let client: DbClient;
	if (driver === 'postgres') {
		if (!pgFactory) {
			throw new Error(
				"getDb: postgres driver selected but the pg adapter is not registered — import 'graphx/pg'",
			);
		}
		client = pgFactory(namespace, cfg);
	} else if (driver === 'duckdb') {
		if (!duckFactory) {
			throw new Error(
				"getDb: duckdb driver selected but the duck adapter is not registered — import 'graphx/duck'",
			);
		}
		client = duckFactory(namespace, cfg);
	} else if (driver === 'bunql') {
		if (!bunqlFactory) {
			throw new Error(
				"getDb: bunql driver selected but the BunQL adapter is not registered — import 'graphx/bunql'",
			);
		}
		client = bunqlFactory(namespace, cfg);
	} else {
		const base = cfg.syncUrl ?? process.env.SQLD_URL;
		const syncUrl = base ? `${base}/${namespace}` : undefined;
		client = createClient({
			url: `file:${namespace}.db`,
			authToken: cfg.authToken ?? process.env.SQLD_TOKEN,
			...(syncUrl ? { syncUrl, syncInterval: cfg.syncInterval ?? 60 } : {}),
		});
	}
	clients.set(namespace, client);
	return client;
}

/** Pull the latest schema/rows before serving when running as an embedded replica. */
export async function syncIfReplica(namespace: string): Promise<void> {
	if (process.env.SQLD_URL) await getDb(namespace).sync?.();
}

/** Drop a cached client (test teardown / namespace eviction). */
export function evict(namespace: string): void {
	const c = clients.get(namespace);
	if (c) {
		c.close();
		clients.delete(namespace);
	}
}

/** Close and clear all cached clients (test teardown). */
export function closeAll(): void {
	for (const c of clients.values()) c.close();
	clients.clear();
}
