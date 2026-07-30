import process from 'node:process';
import { createClient } from '@libsql/client';
import { type DbClient, type Dialect, dialectOf } from './dialect.ts';

/** Max JS Date ms — the open-interval sentinel for `valid_to` (§4). */
export const FOREVER = 8640000000000000;

/**
 * Per-connection pragmas (libSQL). `foreign_keys` & `busy_timeout` do NOT persist in
 * the file — they must run on every fresh client/connection, not only at init (§2.5,
 * §4.1). On Postgres these are inherent (FKs always enforced, MVCC, `lock_timeout`),
 * so this is a no-op there.
 */
export async function applyConnPragmas(client: DbClient): Promise<void> {
	// libSQL only. Postgres has these inherently (FKs always enforced, MVCC,
	// lock_timeout). DuckDB has no equivalent knobs and no lock-based contention —
	// its writer is serialized in-process by the adapter's mutex instead.
	if (dialectOf(client) !== 'libsql') return;
	await client.execute('PRAGMA foreign_keys = ON');
	await client.execute('PRAGMA busy_timeout = 5000');
}

/**
 * Connection config for {@link getDb}. The `driver` discriminator selects the backend
 * (default `libsql`); the libSQL fields apply when `driver === 'libsql'`, the Postgres
 * fields when `driver === 'postgres'`. Omitting `driver` falls back to the
 * `GRAPHX_DB_DRIVER` env var, then libSQL — so existing callers are unaffected.
 */
export interface DbConfig {
	/** Backend selector. Default: `GRAPHX_DB_DRIVER` env, else `'libsql'`. */
	driver?: Dialect;
	// Postgres
	/** libpq connection string (or `GRAPHX_PG_URL` env). The namespace becomes a PG schema. */
	connectionString?: string;
	ssl?: boolean | import('node:tls').ConnectionOptions;
	poolMax?: number;
	// libSQL
	authToken?: string;
	syncUrl?: string;
	syncInterval?: number;
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

/**
 * A client that manages its own writer serialization, and whose durable state may live
 * outside the local database. Only the DuckDB adapter implements it.
 *
 * Declared here and probed structurally so that `graph.ts` and `bulk.ts` — which both have
 * to honor it — never import `duck.ts`, keeping `@duckdb/node-api` (~123MB) off the import
 * path of every consumer who did not opt into that backend.
 */
export interface ManagedWriter {
	/** True when `commit` publishes to a snapshot chain. False for a plain local DuckDB. */
	readonly durable: boolean;
	/** Run `fn` with every other write on this client held back. */
	serializeWrite<T>(fn: () => Promise<T>): Promise<T>;
	/** Publish the local state as the next snapshot. `dirty` names the tables that changed. */
	commit(dirty: Set<string>): Promise<unknown>;
	/** Discard local state and re-materialize the current snapshot — the rollback path. */
	reload(): Promise<void>;
}

/** `raw` as a {@link ManagedWriter}, or null when the backend manages neither concern. */
export function managedWriter(raw: DbClient): ManagedWriter | null {
	const c = raw as Partial<ManagedWriter>;
	return typeof c.serializeWrite === 'function' ? (c as ManagedWriter) : null;
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

function resolveDriver(cfg: DbConfig): Dialect {
	if (cfg.driver) return cfg.driver;
	const env = process.env.GRAPHX_DB_DRIVER;
	if (env === 'postgres' || env === 'duckdb') return env;
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
 */
export function getDb(namespace: string, cfg: DbConfig = {}): DbClient {
	const existing = clients.get(namespace);
	if (existing) return existing;
	const driver = resolveDriver(cfg);
	let client: DbClient;
	if (driver === 'postgres') {
		if (!pgFactory) {
			throw new Error(
				"getDb: postgres driver selected but the pg adapter is not registered — import '@graphx/core/pg'",
			);
		}
		client = pgFactory(namespace, cfg);
	} else if (driver === 'duckdb') {
		if (!duckFactory) {
			throw new Error(
				"getDb: duckdb driver selected but the duck adapter is not registered — import '@graphx/core/duck'",
			);
		}
		client = duckFactory(namespace, cfg);
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
