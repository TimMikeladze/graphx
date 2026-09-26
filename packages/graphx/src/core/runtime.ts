import { type DbClient, dialectOf } from './dialect.ts';

/** Max JS Date ms — the open-interval sentinel for `valid_to` (§4). */
export const FOREVER = 8640000000000000;

/**
 * Per-connection pragmas (libSQL and SQLite). `foreign_keys` & `busy_timeout` do NOT persist in
 * the file — they must run on every fresh client/connection, not only at init (§2.5,
 * §4.1). On Postgres these are inherent (FKs always enforced, MVCC, `lock_timeout`),
 * so this is a no-op there.
 */
export async function applyConnPragmas(client: DbClient): Promise<void> {
	// SQLite-family connections only. Postgres has these inherently (FKs always enforced, MVCC,
	// lock_timeout). DuckDB has no equivalent knobs and no lock-based contention —
	// its writer is serialized in-process by the adapter's mutex instead.
	const d = dialectOf(client);
	if (d !== 'libsql' && d !== 'sqlite') return;
	// A driver that owns its connection settings (BunQL: stated by the server, and a pragma in
	// its setting form is DENIED by the authorizer rather than ignored). See `managedPragmas`.
	if (client.managedPragmas) return;
	const busyTimeoutMs = client.busyTimeoutMs ?? 5000;
	if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
		throw new TypeError('busyTimeoutMs must be a nonnegative safe integer');
	}
	await client.execute('PRAGMA foreign_keys = ON');
	await client.execute(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
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

/**
 * A client whose full-text index is a derived artifact it maintains itself.
 *
 * Declared here and probed structurally for the same reason as {@link ManagedWriter}:
 * `graph.ts`, `hybrid.ts`, and `bulk.ts` all have to honor it, and none of them may import
 * `duck.ts` and drag the optional `@duckdb/node-api` peer onto every consumer's path.
 */
export interface FtsIndexOwner {
	/** Note that the indexed corpus changed. Cheap — no work happens here. */
	markFtsStale(): void;
	/** Rebuild if stale, then return. Called before anything reads the index. */
	ensureFtsFresh(): Promise<void>;
}

/** `raw` as an {@link FtsIndexOwner}, or null when the backend maintains no such index. */
export function ftsIndexOwner(raw: DbClient): FtsIndexOwner | null {
	const c = raw as Partial<FtsIndexOwner>;
	return typeof c.ensureFtsFresh === 'function' ? (c as FtsIndexOwner) : null;
}

/** Promise timer shared by graph retries and outbox polling in every host. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
