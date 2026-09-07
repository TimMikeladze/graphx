import process from 'node:process';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { type DbConfig, registerPgDriver } from './db.ts';
import type {
	DbClient,
	DbTransaction,
	SqlResult,
	SqlRow,
	SqlStatement,
	TransactionMode,
} from './dialect.ts';

/**
 * Postgres adapter — implements the driver-neutral {@link DbClient} over a `pg.Pool`.
 * graphx's SQL is written with libSQL `?` positional placeholders; this adapter owns
 * the single `?`→`$n` rewrite chokepoint (skipping string literals) and maps `pg`'s
 * result shape onto {@link SqlResult}. Dialect-specific *SQL* (pgvector, tsvector,
 * jsonb access, ON CONFLICT, etc.) lives in `dialect-sql.ts`, selected by dialect at
 * the call sites — this adapter is purely the wire/driver layer.
 */

export interface PgClientOptions {
	/** A libpq connection string, e.g. `postgresql://user:pw@host:5432/db`. */
	connectionString: string;
	/** Postgres schema that unqualified SQL resolves against (search_path); tenant isolation. */
	schema?: string;
	/** `CREATE SCHEMA IF NOT EXISTS <schema>` once on startup (the schema-per-tenant lazy init). */
	ensureSchema?: boolean;
	/** `CREATE EXTENSION IF NOT EXISTS vector` once on startup (needs privilege; tests/dev only). */
	ensureExtension?: boolean;
	/** Max pooled connections (default 10). */
	max?: number;
	/**
	 * TLS config passed straight to `pg`. `true` uses the system trust store with full
	 * verification; pass a `ConnectionOptions` object for custom CAs. Never silently
	 * disables verification.
	 */
	ssl?: boolean | import('node:tls').ConnectionOptions;
	/**
	 * How the tenant `search_path` is applied — see {@link PgPoolerMode}. Default `'auto'`.
	 */
	pooler?: PgPoolerMode;
}

/**
 * Whether the connection string points at a transaction-pooling proxy (PgBouncer, pgcat, Supavisor)
 * rather than Postgres itself.
 *
 * Direct connections get the tenant schema as a libpq startup option
 * (`-c search_path=…`), which every pooled connection then carries for its whole life — zero
 * per-query cost. A transaction pooler hands each transaction to whichever server connection is
 * free, so session state cannot be trusted and PgBouncer rejects the startup option outright
 * (`unsupported startup parameter in options`). In pooled mode the adapter drops the startup
 * option and instead runs every statement inside a transaction that begins with
 * `SET LOCAL search_path` — one extra round trip per statement, correct under any pooler.
 *
 * - `'auto'` (default): start direct; on PgBouncer's startup rejection, switch to pooled and retry.
 * - `'transaction'`: pooled from the first query (skips the failed handshake).
 * - `'none'`: direct only; a pooler's rejection propagates as an error.
 */
export type PgPoolerMode = 'auto' | 'transaction' | 'none';

/** PgBouncer's answer to a libpq `options` startup parameter it does not pass through. */
function isStartupOptionsRejection(e: unknown): boolean {
	return e instanceof Error && /unsupported startup parameter in options/i.test(e.message);
}

/**
 * Rewrite libSQL-style `?` positional placeholders to Postgres `$1, $2, …`, leaving
 * `?` inside single-quoted string literals untouched (`''` is an escaped quote).
 */
export function toPgPlaceholders(sql: string): string {
	let out = '';
	let n = 0;
	let inStr = false;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (inStr) {
			out += ch;
			if (ch === "'") {
				// A doubled '' is an escaped quote — stay in the string.
				if (sql[i + 1] === "'") {
					out += "'";
					i++;
				} else {
					inStr = false;
				}
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			out += ch;
		} else if (ch === '?') {
			n++;
			out += `$${n}`;
		} else {
			out += ch;
		}
	}
	return out;
}

function normalize(stmt: SqlStatement): { sql: string; args: unknown[] } {
	if (typeof stmt === 'string') return { sql: stmt, args: [] };
	const args = stmt.args;
	if (args === undefined) return { sql: stmt.sql, args: [] };
	if (!Array.isArray(args)) {
		throw new Error('pg adapter: named statement args are not supported (use positional ?)');
	}
	return { sql: stmt.sql, args: args as unknown[] };
}

function toResult(r: QueryResult): SqlResult {
	return {
		rows: r.rows as SqlRow[],
		rowsAffected: r.rowCount ?? 0,
		columns: r.fields?.map((f) => f.name),
	};
}

class PgTransaction implements DbTransaction {
	closed = false;
	constructor(
		private readonly client: PoolClient,
		private readonly onDone: () => void,
	) {}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		const { sql, args } = normalize(stmt);
		return toResult(await this.client.query(toPgPlaceholders(sql), args));
	}

	async commit(): Promise<void> {
		await this.client.query('COMMIT');
		this.finish();
	}

	async rollback(): Promise<void> {
		await this.client.query('ROLLBACK');
		this.finish();
	}

	private finish(): void {
		if (!this.closed) {
			this.closed = true;
			this.onDone();
		}
	}
}

export class PgClient implements DbClient {
	readonly dialect = 'postgres' as const;
	private pool: Pool;
	private ended = false;
	/** True once the adapter applies `search_path` per transaction instead of at connect time. */
	private pooled: boolean;
	/** In-flight switch to pooled mode, so concurrent first queries share one pool rebuild. */
	private switching: Promise<void> | undefined;
	private readonly opts: PgClientOptions;
	/** One-shot extension/schema bootstrap; every method awaits it before its first query. */
	private readonly ready: Promise<void>;

	constructor(opts: PgClientOptions) {
		this.opts = opts;
		this.pooled = opts.pooler === 'transaction';
		this.pool = this.makePool();
		this.ready = this.run(async () => {
			if (opts.ensureExtension) await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
			if (opts.ensureSchema && opts.schema) {
				await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
			}
		});
	}

	private makePool(): Pool {
		const { opts } = this;
		return new Pool({
			connectionString: opts.connectionString,
			max: opts.max ?? 10,
			...(opts.ssl !== undefined ? { ssl: opts.ssl } : {}),
			// Direct mode: search_path applies to every pooled connection, isolating the tenant
			// schema while leaving the SQL itself unqualified (schema-per-tenant, §2.9 analog).
			// `public` stays on the path so the shared `vector` type/extension resolves. Pooled
			// mode sets it per transaction instead (see PgPoolerMode).
			...(opts.schema && !this.pooled ? { options: `-c search_path="${opts.schema}",public` } : {}),
		});
	}

	/** The per-transaction `search_path`, or `null` when direct mode already carries it. */
	private pathStmt(): string | null {
		return this.pooled && this.opts.schema
			? `SET LOCAL search_path TO "${this.opts.schema}", public`
			: null;
	}

	/**
	 * Run `fn`; if a transaction pooler rejects the startup option, flip to pooled mode (a fresh
	 * pool without the option) and run `fn` once more. Only `'auto'` switches.
	 */
	private async run<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			if (this.pooled || this.opts.pooler === 'none' || !isStartupOptionsRejection(e)) throw e;
			this.switching ??= (async () => {
				const old = this.pool;
				this.pooled = true;
				this.pool = this.makePool();
				await old.end().catch(() => {});
			})();
			await this.switching;
			return fn();
		}
	}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		await this.ready;
		const { sql, args } = normalize(stmt);
		return this.run(async () => {
			const path = this.pathStmt();
			if (!path) return toResult(await this.pool.query(toPgPlaceholders(sql), args));
			// Pooled: the SET LOCAL and the statement must reach the same server connection,
			// which only a transaction guarantees under a transaction pooler. Round trips are
			// what pooled mode costs, so they are minimised: a parameterless statement rides in
			// ONE simple query with its BEGIN/SET/COMMIT; a parameterised one (extended protocol,
			// which cannot carry several statements) takes three.
			const client = await this.pool.connect();
			try {
				if (args.length === 0) {
					const results = await client.query(`BEGIN; ${path}; ${sql}; COMMIT`);
					// pg returns one result per statement for a multi-statement simple query.
					const all = Array.isArray(results) ? results : [results];
					return toResult(all[all.length - 2] as QueryResult);
				}
				await client.query(`BEGIN; ${path}`);
				const r = toResult(await client.query(toPgPlaceholders(sql), args));
				await client.query('COMMIT');
				return r;
			} catch (e) {
				await client.query('ROLLBACK').catch(() => {});
				throw e;
			} finally {
				client.release();
			}
		});
	}

	/** Atomic batch — all statements in one transaction (mirrors libSQL `batch(_, 'write')`). */
	async batch(stmts: SqlStatement[], _mode?: TransactionMode): Promise<SqlResult[]> {
		await this.ready;
		return this.run(async () => {
			const client = await this.pool.connect();
			try {
				const path = this.pathStmt();
				await client.query(path ? `BEGIN; ${path}` : 'BEGIN');
				const out: SqlResult[] = [];
				for (const stmt of stmts) {
					const { sql, args } = normalize(stmt);
					out.push(toResult(await client.query(toPgPlaceholders(sql), args)));
				}
				await client.query('COMMIT');
				return out;
			} catch (e) {
				await client.query('ROLLBACK').catch(() => {});
				throw e;
			} finally {
				client.release();
			}
		});
	}

	async transaction(mode?: TransactionMode): Promise<DbTransaction> {
		await this.ready;
		return this.run(async () => {
			const client = await this.pool.connect();
			try {
				// SERIALIZABLE for write transactions: graphx's conditional-close reads
				// (SELECT MAX(valid_from)) then writes, and relies on full writer serialization
				// (libSQL's BEGIN IMMEDIATE). Under READ COMMITTED a racing writer would read a
				// stale snapshot and close a successor at an inverted timestamp; SERIALIZABLE
				// raises 40001 on the conflict instead, which the caller's retry envelope handles.
				const begin = mode === 'read' ? 'BEGIN' : 'BEGIN ISOLATION LEVEL SERIALIZABLE';
				const path = this.pathStmt();
				await client.query(path ? `${begin}; ${path}` : begin);
			} catch (e) {
				client.release();
				throw e;
			}
			return new PgTransaction(client, () => client.release());
		});
	}

	/** Run a multi-statement script (DDL) on one connection via the simple-query protocol. */
	async executeMultiple(sql: string): Promise<void> {
		await this.ready;
		await this.run(async () => {
			const client = await this.pool.connect();
			try {
				const path = this.pathStmt();
				// A multi-statement simple query is already one implicit transaction; the explicit
				// BEGIN only exists to give SET LOCAL something to be local to.
				await client.query(path ? `BEGIN; ${path}; ${sql}; COMMIT` : sql);
			} catch (e) {
				if (this.pathStmt()) await client.query('ROLLBACK').catch(() => {});
				throw e;
			} finally {
				client.release();
			}
		});
	}

	/** Drain the pool. Fire-and-forget to satisfy the synchronous `DbClient.close()`. */
	close(): void {
		void this.end();
	}

	/** Await full pool drain (test teardown). Idempotent — a double close/end is a no-op. */
	async end(): Promise<void> {
		if (this.ended) return;
		this.ended = true;
		await this.pool.end();
	}
}

/** Construct a Postgres {@link DbClient}. */
export function createPgClient(opts: PgClientOptions): PgClient {
	return new PgClient(opts);
}

/**
 * Register the Postgres backend with {@link getDb} as a side effect of importing this
 * module (the `core/pg` subpath). Schema-per-tenant: `getDb(namespace)` maps the
 * namespace to a PG schema, lazily created. Connection comes from `cfg.connectionString`
 * or the `GRAPHX_PG_URL` env. The `vector` extension is expected to exist in `public`.
 */
registerPgDriver(
	(namespace: string, cfg: DbConfig): DbClient =>
		new PgClient({
			connectionString: cfg.connectionString ?? process.env.GRAPHX_PG_URL ?? '',
			schema: namespace,
			ensureSchema: true,
			...(cfg.ssl !== undefined ? { ssl: cfg.ssl } : {}),
			...(cfg.poolMax !== undefined ? { max: cfg.poolMax } : {}),
			...(cfg.pooler !== undefined ? { pooler: cfg.pooler } : {}),
		}),
);
