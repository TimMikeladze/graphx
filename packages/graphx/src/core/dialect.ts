import type { InStatement, InValue } from '@libsql/client';

/**
 * Backend dialect seam. graphx speaks SQL to multiple backends; this module is the
 * single place that names them and defines the driver-neutral DB types every other
 * module programs against. Call sites depend on {@link DbClient}, never on
 * `@libsql/client.Client`, so either driver can be slotted in behind it.
 *
 * {@link DbClient} is a STRUCTURAL interface covering exactly the surface the codebase
 * uses (~6 methods). It is deliberately a subset of what `@libsql/client.Client`
 * provides, so a real libSQL `Client` is assignable to it, while the Postgres adapter
 * (see `pg.ts`) implements the same interface over a `pg.Pool`.
 */

/** Which SQL backend a client speaks. Absent ⇒ libSQL (the original / default). */
export type Dialect = 'libsql' | 'sqlite' | 'postgres' | 'duckdb';

/** Transaction mode for {@link DbClient.batch} / {@link DbClient.transaction}. */
export type TransactionMode = 'write' | 'read' | 'deferred';

/** A bound parameter value (mirrors libSQL's `InValue`). */
export type SqlValue = InValue;
/** A `{ sql, args }` statement, or a bare SQL string. */
export type SqlStatement = InStatement;
/** One result row, keyed by column name. */
export type SqlRow = Record<string, unknown>;

/** The result of a statement — the subset of fields the codebase reads. */
export interface SqlResult {
	rows: SqlRow[];
	rowsAffected: number;
	lastInsertRowid?: bigint;
	columns?: string[];
}

/** An interactive transaction handle. */
export interface DbTransaction {
	execute(stmt: SqlStatement): Promise<SqlResult>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	readonly closed: boolean;
}

/**
 * The driver-neutral DB client every module depends on. A strict subset of the libSQL
 * `Client` surface (so a real `Client` is assignable here), and the contract the
 * Postgres adapter implements. `sync` is optional — libSQL embedded replicas use it;
 * Postgres has no analog (the adapter omits it).
 */
export interface DbClient {
	execute(stmt: SqlStatement): Promise<SqlResult>;
	batch(stmts: SqlStatement[], mode?: TransactionMode): Promise<SqlResult[]>;
	transaction(mode?: TransactionMode): Promise<DbTransaction>;
	executeMultiple(sql: string): Promise<void>;
	sync?(): Promise<unknown>;
	close(): void;
	readonly dialect?: Dialect;
	/** Driver-owned SQLite busy timeout; zero lets synchronous native drivers fail fast. */
	readonly busyTimeoutMs?: number;
	/**
	 * The driver — not graphx — owns connection-level settings, so
	 * {@link import('./runtime.ts').applyConnPragmas} must not issue them.
	 *
	 * Set by a client whose connection is configured somewhere graphx cannot reach, or where
	 * issuing a pragma is an ERROR rather than a no-op. The bql.sh driver is the reason it exists:
	 * a bql.sh server states every connection setting itself (`[sqlite]` in its config) and its
	 * authorizer answers `SQLITE_DENY` to a pragma in its *setting* form, so
	 * `PRAGMA foreign_keys = ON` from a tenant statement throws instead of being ignored.
	 *
	 * A client that sets this is asserting that `foreign_keys` is ON and a busy timeout is in
	 * place — graphx's schema declares foreign keys and relies on them being enforced.
	 */
	readonly managedPragmas?: boolean;
}

/** Resolve a client's dialect; an untagged client is libSQL (the original backend). */
export function dialectOf(client: { dialect?: Dialect }): Dialect {
	return client.dialect ?? 'libsql';
}

/**
 * Exhaustiveness guard for dialect switches. Every `switch (dialect)` in the codebase
 * ends in `default: return assertNever(dialect, '<fragmentName>')`, so adding another
 * backend surfaces as a compile error at every branch that has not been taught about it
 * — rather than as a silent fall-through to the libSQL arm, which is what the two-way
 * ternaries this replaced would have done.
 */
export function assertNever(x: never, ctx: string): never {
	throw new Error(`${ctx}: unhandled dialect ${JSON.stringify(x)}`);
}
