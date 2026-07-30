import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type DbConfig, registerDuckDriver } from './db.ts';
import type {
	DbClient,
	DbTransaction,
	SqlResult,
	SqlStatement,
	TransactionMode,
} from './dialect.ts';
import { commitSnapshot, type ExportSource } from './duck-commit.ts';
import { type LoadTarget, materialize } from './duck-materialize.ts';
import { DuckPool, type PooledConnection } from './duck-pool.ts';
import { normalizeRow } from './duck-value.ts';
import { FileCache } from './objstore/cache.ts';
import type { Manifest } from './objstore/manifest.ts';
import { SnapshotStore } from './objstore/snapshot.ts';
import type { ObjectStore } from './objstore/store.ts';

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
	/** Database path. Default `:memory:` — the whole point is that it is disposable. */
	path?: string;
	/** Max pooled connections (default 4). */
	poolMax?: number;
	/**
	 * Durable backing. Without it the client is a plain local DuckDB (stage 3 behavior).
	 * A promise is accepted so the registered factory can construct an `S3ObjectStore` by
	 * dynamic import, keeping `@aws-sdk/client-s3` off the `core/duck` import path for
	 * consumers who only want a local database.
	 */
	store?: ObjectStore | Promise<ObjectStore>;
	/** Where cached data objects live. Required when `store` is set. */
	cacheDir?: string;
	/** Pin to a specific snapshot instead of following head. */
	snapshot?: number;
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
			// Swallow a rollback failure: the caller needs to hear "aborted", which is the
			// actionable fact, not whatever went wrong while cleaning up after it.
			await this.rollback().catch(() => undefined);
			throw new Error('duck transaction: aborted — commit would silently discard the writes');
		}
		try {
			await this.conn.run('COMMIT');
		} finally {
			// Release even if COMMIT itself throws, or the connection leaks from the pool.
			this.finish();
		}
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
	/**
	 * The one-shot bootstrap, started in the constructor when the client is bucket-backed.
	 * `getDb` is synchronous and cannot await an open, so every entry point awaits this
	 * instead — the same pattern as `PgClient.ready`. Undefined for a local-only client,
	 * which is usable immediately.
	 */
	private readonly opened?: Promise<void>;
	private snapshots?: SnapshotStore;
	private cache?: FileCache;
	private current: Manifest | null = null;
	private tmpDir?: string;

	constructor(opts: DuckClientOptions = {}) {
		this.pool = new DuckPool(opts.path ?? ':memory:', { max: opts.poolMax ?? 4 });
		if (opts.store) {
			if (!opts.cacheDir) {
				throw new Error('duck client: a store needs a cacheDir to hold its data objects');
			}
			this.tmpDir = join(opts.cacheDir, 'tmp');
			mkdirSync(this.tmpDir, { recursive: true });
			this.opened = this.load(opts.store, opts.cacheDir, opts.snapshot);
		}
	}

	/**
	 * Resolve the snapshot this client reads and materialize it locally.
	 *
	 * Runs against {@link raw}, not `this`: it IS the bootstrap, so going through the
	 * gated entry points would await the promise it is in the middle of resolving.
	 */
	private async load(
		store: ObjectStore | Promise<ObjectStore>,
		cacheDir: string,
		pinned?: number,
	): Promise<void> {
		const resolved = await store;
		this.snapshots = new SnapshotStore(resolved);
		this.cache = new FileCache(resolved, cacheDir);
		this.current =
			pinned === undefined ? await this.snapshots.resolveHead() : await this.snapshots.read(pinned);
		await materialize(this.raw, this.current, this.cache);
	}

	/** An ungated view of this client, for the bootstrap and the commit path. */
	private get raw(): LoadTarget & ExportSource {
		return {
			execute: (stmt) => this.pool.withConnection((c) => runOne(c, stmt)),
			executeMultiple: (sql) => this.runScript(sql),
		};
	}

	/**
	 * Await the snapshot load. Every entry point calls this first, so a caller that never
	 * awaits `open()` still cannot observe an unmaterialized database.
	 */
	async open(): Promise<void> {
		if (this.opened) await this.opened;
	}

	/** The snapshot this client is reading, or null on an empty bucket. */
	snapshot(): Manifest | null {
		return this.current;
	}

	/**
	 * Publish the local state as the next snapshot. `dirty` names the tables that changed;
	 * every other table carries its refs forward, so an unchanged graph costs no uploads.
	 */
	async commit(dirty: Set<string>): Promise<Manifest> {
		await this.open();
		if (!this.snapshots || !this.cache || !this.tmpDir) {
			throw new Error('duck client: commit requires a store — construct with { store, cacheDir }');
		}
		this.current = await commitSnapshot(
			this.raw,
			this.snapshots,
			this.cache,
			this.tmpDir,
			this.current,
			dirty,
		);
		return this.current;
	}

	async execute(stmt: SqlStatement): Promise<SqlResult> {
		await this.open();
		return this.pool.withConnection((c) => runOne(c, stmt));
	}

	/** Atomic batch — every statement in one transaction (mirrors libSQL `batch(_, 'write')`). */
	async batch(stmts: SqlStatement[], _mode?: TransactionMode): Promise<SqlResult[]> {
		await this.open();
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
		await this.open();
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
		await this.open();
		await this.runScript(sql);
	}

	private async runScript(sql: string): Promise<void> {
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
 * Split a DDL script into statements on semicolons that are genuinely statement
 * boundaries — not ones inside a string literal or a comment. The client's
 * `extractStatements` would also work, but it needs a live connection to call and this
 * keeps the split testable in isolation.
 *
 * Comments must be skipped, not merely tolerated: the schema DDL this splits is full of
 * them, and a semicolon inside one produces either a parse error (when the comment tail
 * merges into the next statement) or, worse, a silently dropped statement (when the
 * comment forms an isolated fragment between two semicolons).
 */
export function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let buf = '';
	let i = 0;
	const flush = (): void => {
		if (buf.trim()) out.push(buf.trim());
		buf = '';
	};
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl === -1 ? sql.length : nl + 1;
			continue;
		}
		if (ch === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (ch === "'") {
			// Copy the literal verbatim, honouring the doubled '' escape. A semicolon in
			// here is data, not a boundary.
			buf += ch;
			i++;
			while (i < sql.length) {
				buf += sql[i];
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						buf += sql[i + 1];
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		if (ch === ';') {
			flush();
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	flush();
	return out;
}

/** Construct a DuckDB {@link DbClient}. */
export function createDuckClient(opts: DuckClientOptions = {}): DuckClient {
	return new DuckClient(opts);
}

/**
 * Register the DuckDB backend with {@link getDb} as a side effect of importing this
 * module (the `core/duck` subpath).
 *
 * With `bucket`, the namespace becomes a key prefix — the way it becomes a schema on
 * Postgres and a file on libSQL — so one bucket holds every tenant, and the local database
 * is a disposable materialization of that tenant's head snapshot. Without it, the stage-3
 * behavior stands: one local database file per namespace.
 *
 * The `S3ObjectStore` is loaded by dynamic import rather than a top-level one so that
 * `@aws-sdk/client-s3` — an optional peer — stays off the import path of consumers who
 * only want a local DuckDB.
 */
registerDuckDriver((namespace: string, cfg: DbConfig): DbClient => {
	const store = cfg.bucket
		? import('./objstore/s3.ts').then(
				({ S3ObjectStore }) =>
					new S3ObjectStore({
						bucket: cfg.bucket as string,
						prefix: `${cfg.prefix ? `${cfg.prefix}/` : ''}${namespace}`,
						...(cfg.region ? { region: cfg.region } : {}),
						...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
					}),
			)
		: undefined;
	return new DuckClient({
		path: cfg.duckPath ?? (store ? ':memory:' : `${namespace}.duckdb`),
		...(store ? { store, cacheDir: cfg.cacheDir ?? `.graphx-cache/${namespace}` } : {}),
		...(cfg.snapshot !== undefined ? { snapshot: cfg.snapshot } : {}),
		...(cfg.poolMax !== undefined ? { poolMax: cfg.poolMax } : {}),
	});
});
