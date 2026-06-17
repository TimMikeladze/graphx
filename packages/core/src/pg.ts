import { Pool, type PoolClient, type QueryResult } from 'pg';
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
	private readonly pool: Pool;
	private ended = false;
	/** One-shot extension/schema bootstrap; every method awaits it before its first query. */
	private readonly ready: Promise<void>;

	constructor(opts: PgClientOptions) {
		const pool = new Pool({
			connectionString: opts.connectionString,
			max: opts.max ?? 10,
			...(opts.ssl !== undefined ? { ssl: opts.ssl } : {}),
			// search_path applies to every pooled connection, isolating the tenant schema
			// while leaving the SQL itself unqualified (schema-per-tenant, §2.9 analog).
			// `public` stays on the path so the shared `vector` type/extension resolves.
			...(opts.schema ? { options: `-c search_path="${opts.schema}",public` } : {}),
		});
		this.pool = pool;
		this.ready = (async () => {
			if (opts.ensureExtension) await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
			if (opts.ensureSchema && opts.schema) {
				await pool.query(`CREATE SCHEMA IF NOT EXISTS "${opts.schema}"`);
			}
		})();
	}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		await this.ready;
		const { sql, args } = normalize(stmt);
		return toResult(await this.pool.query(toPgPlaceholders(sql), args));
	}

	/** Atomic batch — all statements in one transaction (mirrors libSQL `batch(_, 'write')`). */
	async batch(stmts: SqlStatement[], _mode?: TransactionMode): Promise<SqlResult[]> {
		await this.ready;
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');
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
	}

	async transaction(_mode?: TransactionMode): Promise<DbTransaction> {
		await this.ready;
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');
		} catch (e) {
			client.release();
			throw e;
		}
		return new PgTransaction(client, () => client.release());
	}

	/** Run a multi-statement script (DDL) on one connection via the simple-query protocol. */
	async executeMultiple(sql: string): Promise<void> {
		await this.ready;
		const client = await this.pool.connect();
		try {
			await client.query(sql);
		} finally {
			client.release();
		}
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
