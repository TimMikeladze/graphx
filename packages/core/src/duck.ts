import { type DbConfig, registerDuckDriver } from './db.ts';
import type {
	DbClient,
	DbTransaction,
	SqlResult,
	SqlStatement,
	TransactionMode,
} from './dialect.ts';
import { DuckPool, type PooledConnection } from './duck-pool.ts';
import { normalizeRow } from './duck-value.ts';

/**
 * DuckDB adapter — implements the driver-neutral {@link DbClient} over a local DuckDB.
 * The counterpart of `pg.ts`, and deliberately the same shape.
 *
 * graphx's SQL uses `?` positional placeholders, which DuckDB accepts natively — so
 * unlike the Postgres adapter there is no placeholder-rewrite chokepoint here.
 * Dialect-specific SQL lives in `dialect-sql.ts` as always; this file is the wire layer
 * plus the defenses against DuckDB's silent failure modes.
 *
 * In stage 4 this client's durable state becomes a snapshot chain in an object store. At
 * this stage `path` is a local file or `:memory:`, which is what makes the existing test
 * suite runnable against it before any of the storage layer is wired in.
 */

export interface DuckClientOptions {
	/** Database path. Default `:memory:`. */
	path?: string;
	/** Max pooled connections (default 4). */
	poolMax?: number;
}

function normalize(stmt: SqlStatement): { sql: string; args: unknown[] } {
	if (typeof stmt === 'string') return { sql: stmt, args: [] };
	const args = stmt.args;
	if (args === undefined) return { sql: stmt.sql, args: [] };
	if (!Array.isArray(args)) {
		throw new Error('duck adapter: named statement args are not supported (use positional ?)');
	}
	return { sql: stmt.sql, args: args as unknown[] };
}

async function runOne(conn: PooledConnection, stmt: SqlStatement): Promise<SqlResult> {
	const { sql, args } = normalize(stmt);
	const r = args.length === 0 ? await conn.run(sql) : await conn.run(sql, args);
	return {
		rows: r.rows.map(normalizeRow),
		rowsAffected: r.rowsChanged,
		columns: r.columnNames,
	};
}

class DuckTransaction implements DbTransaction {
	closed = false;
	/**
	 * Set by the first statement that throws. DuckDB's `COMMIT` on an aborted transaction
	 * RESOLVES SUCCESSFULLY and discards every write, so a resolved commit proves nothing.
	 * Tracking abort explicitly is the only way this adapter can tell its caller the truth.
	 * (Note that only conversion, constraint, and out-of-range errors actually abort;
	 * parser, catalog, and binder errors leave the transaction live. Treating all of them
	 * as fatal costs a spurious rollback and buys an unambiguous contract.)
	 */
	private aborted = false;

	constructor(private readonly conn: PooledConnection) {}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		if (this.aborted) throw new Error('duck transaction: aborted — roll back and retry');
		try {
			return await runOne(this.conn, stmt);
		} catch (e) {
			this.aborted = true;
			throw e;
		}
	}

	async commit(): Promise<void> {
		if (this.aborted) {
			await this.rollback();
			throw new Error('duck transaction: aborted — commit would silently discard the writes');
		}
		await this.conn.run('COMMIT');
		this.finish();
	}

	async rollback(): Promise<void> {
		try {
			await this.conn.run('ROLLBACK');
		} finally {
			this.finish();
		}
	}

	private finish(): void {
		if (!this.closed) {
			this.closed = true;
			this.conn.release();
		}
	}
}

export class DuckClient implements DbClient {
	readonly dialect = 'duckdb' as const;
	private readonly pool: DuckPool;
	private ended = false;

	constructor(opts: DuckClientOptions = {}) {
		this.pool = new DuckPool(opts.path ?? ':memory:', { max: opts.poolMax ?? 4 });
	}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		return this.pool.withConnection((c) => runOne(c, stmt));
	}

	/** Atomic batch — every statement in one transaction (mirrors libSQL `batch(_, 'write')`). */
	async batch(stmts: SqlStatement[], _mode?: TransactionMode): Promise<SqlResult[]> {
		return this.pool.withConnection(async (c) => {
			await c.run('BEGIN');
			try {
				const out: SqlResult[] = [];
				for (const stmt of stmts) out.push(await runOne(c, stmt));
				await c.run('COMMIT');
				return out;
			} catch (e) {
				await c.run('ROLLBACK').catch(() => {});
				throw e;
			}
		});
	}

	/**
	 * An interactive transaction takes a connection out of the pool for its whole lifetime.
	 * Sharing one would silently merge concurrent transactions — see duck-pool.ts.
	 *
	 * There is no isolation level to raise here, and none is needed: DuckDB writers are
	 * serialized by the write mutex in graph.ts (stage 4), which is what restores the
	 * conditional-close CAS that libSQL gets from BEGIN IMMEDIATE and Postgres from
	 * SERIALIZABLE.
	 */
	async transaction(_mode?: TransactionMode): Promise<DbTransaction> {
		const conn = await this.pool.acquire();
		try {
			await conn.run('BEGIN');
		} catch (e) {
			conn.release();
			throw e;
		}
		return new DuckTransaction(conn);
	}

	/**
	 * Run a multi-statement DDL script. Splitting and running statements one at a time in
	 * lockstep is mandatory: a bare multi-statement `run(script)` executes everything but
	 * returns the FIRST SELECT's result when the script contains one (and the last
	 * statement's otherwise), scrambling `rowsChanged`.
	 */
	async executeMultiple(sql: string): Promise<void> {
		await this.pool.withConnection(async (c) => {
			for (const stmt of splitStatements(sql)) {
				await c.run(stmt);
			}
		});
	}

	/** Fire-and-forget to satisfy the synchronous `DbClient.close()`. */
	close(): void {
		void this.end();
	}

	/** Await a full pool drain (test teardown). Idempotent. */
	async end(): Promise<void> {
		if (this.ended) return;
		this.ended = true;
		await this.pool.close();
	}
}

/**
 * Split a DDL script into statements on semicolons that are not inside a string literal.
 * A `''` is an escaped quote and does not close the literal.
 */
export function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let buf = '';
	let inStr = false;
	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i];
		if (inStr) {
			buf += ch;
			if (ch === "'") {
				if (sql[i + 1] === "'") {
					buf += "'";
					i++;
				} else {
					inStr = false;
				}
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			buf += ch;
		} else if (ch === ';') {
			if (buf.trim()) out.push(buf.trim());
			buf = '';
		} else {
			buf += ch;
		}
	}
	if (buf.trim()) out.push(buf.trim());
	return out;
}

/** Construct a DuckDB {@link DbClient}. */
export function createDuckClient(opts: DuckClientOptions = {}): DuckClient {
	return new DuckClient(opts);
}

/**
 * Register the DuckDB backend with {@link getDb} as a side effect of importing this
 * module (the `core/duck` subpath). One database file per namespace, mirroring the
 * libSQL file-per-namespace model; stage 4 replaces the path with a bucket prefix.
 */
registerDuckDriver(
	(namespace: string, cfg: DbConfig): DbClient =>
		new DuckClient({
			path: cfg.duckPath ?? `${namespace}.duckdb`,
			...(cfg.poolMax !== undefined ? { poolMax: cfg.poolMax } : {}),
		}),
);
