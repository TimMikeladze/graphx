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
	if (dialectOf(client) === 'postgres') return;
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

function resolveDriver(cfg: DbConfig): Dialect {
	if (cfg.driver) return cfg.driver;
	return process.env.GRAPHX_DB_DRIVER === 'postgres' ? 'postgres' : 'libsql';
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
	let client: DbClient;
	if (resolveDriver(cfg) === 'postgres') {
		if (!pgFactory) {
			throw new Error(
				"getDb: postgres driver selected but the pg adapter is not registered — import 'core/pg'",
			);
		}
		client = pgFactory(namespace, cfg);
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
