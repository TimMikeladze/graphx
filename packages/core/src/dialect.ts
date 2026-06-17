import type { InStatement, InValue } from '@libsql/client';

/**
 * Backend dialect seam. graphx speaks SQL to one of two backends; this module is the
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
export type Dialect = 'libsql' | 'postgres';

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
}

/** Resolve a client's dialect; an untagged client is libSQL (the original backend). */
export function dialectOf(client: { dialect?: Dialect }): Dialect {
	return client.dialect ?? 'libsql';
}
