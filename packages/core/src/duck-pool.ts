import { DuckDBInstance } from '@duckdb/node-api';

/**
 * DuckDB connection lifecycle.
 *
 * Two verified behaviors shape this module. First, a single connection is serialized but
 * SHARED: two async tasks interleaving on it silently merge their transactions — in the
 * reproduction, an autocommit INSERT on one task was swallowed into another task's
 * ROLLBACK, leaving the table empty with no error raised. So a transaction must own a
 * connection for its whole lifetime, which is what this pool provides.
 *
 * Second, an `INTERNAL Error` escalates to a FATAL that kills EVERY connection on the
 * instance, including ones opened afterward; only a fresh `DuckDBInstance` recovers. So
 * the pool can rebuild itself.
 */

export interface DuckResult {
	rows: Record<string, unknown>[];
	rowsChanged: number;
	columnNames: string[];
}

export interface PooledConnection {
	run(sql: string, values?: unknown[], types?: unknown[]): Promise<DuckResult>;
	release(): void;
}

/** A FATAL that invalidated the whole instance — recoverable only by rebuilding it. */
export function isFatalInstanceError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /database has been invalidated|FATAL Error/i.test(msg);
}

type RawConnection = Awaited<ReturnType<DuckDBInstance['connect']>>;

export class DuckPool {
	private instance?: Promise<DuckDBInstance>;
	private readonly idle: RawConnection[] = [];
	private readonly waiting: Array<(c: RawConnection) => void> = [];
	private open = 0;
	private readonly max: number;
	private closed = false;

	constructor(
		private readonly path: string,
		opts: { max?: number } = {},
	) {
		this.max = opts.max ?? 4;
	}

	private getInstance(): Promise<DuckDBInstance> {
		this.instance ??= DuckDBInstance.create(this.path);
		return this.instance;
	}

	async acquire(): Promise<PooledConnection> {
		if (this.closed) throw new Error('duck pool: closed');
		const raw = await this.checkout();
		let released = false;
		return {
			run: async (sql, values, types) => {
				try {
					// `values === undefined` takes a different code path in the client (a raw
					// duckdb_query rather than prepare+bind), and that path returns the FIRST
					// SELECT's result for a multi-statement script and scrambles rowsChanged.
					// executeMultiple handles scripts; everything here is a single statement.
					const reader =
						values === undefined
							? await raw.runAndReadAll(sql)
							: await raw.runAndReadAll(sql, values as never, types as never);
					return {
						// getRowObjectsJS gives plain JS values for LIST/BLOB/DATE while leaving
						// BIGINT as bigint. graphx has no DECIMAL columns, which is the one type
						// this accessor renders lossily.
						rows: reader.getRowObjectsJS() as Record<string, unknown>[],
						rowsChanged: reader.rowsChanged,
						columnNames: reader.columnNames(),
					};
				} catch (e) {
					if (isFatalInstanceError(e)) await this.rebuild();
					throw e;
				}
			},
			release: () => {
				if (released) return;
				released = true;
				this.checkin(raw);
			},
		};
	}

	/** Acquire, run, release — release happens even when `fn` throws. */
	async withConnection<T>(fn: (c: PooledConnection) => Promise<T>): Promise<T> {
		const c = await this.acquire();
		try {
			return await fn(c);
		} finally {
			c.release();
		}
	}

	private async checkout(): Promise<RawConnection> {
		const spare = this.idle.pop();
		if (spare) return spare;
		if (this.open < this.max) {
			this.open++;
			try {
				return await (await this.getInstance()).connect();
			} catch (e) {
				this.open--;
				throw e;
			}
		}
		return new Promise<RawConnection>((resolve) => this.waiting.push(resolve));
	}

	private checkin(raw: RawConnection): void {
		const next = this.waiting.shift();
		if (next) {
			next(raw);
			return;
		}
		this.idle.push(raw);
	}

	/**
	 * Discard the instance and every connection on it. The only recovery from a FATAL —
	 * a brand-new connection on the same instance is dead too.
	 */
	private async rebuild(): Promise<void> {
		for (const c of this.idle.splice(0)) {
			try {
				c.closeSync();
			} catch {
				/* the instance is already dead; closing is best-effort */
			}
		}
		this.open = 0;
		this.instance = undefined;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const c of this.idle.splice(0)) {
			try {
				c.closeSync();
			} catch {
				/* ignore */
			}
		}
		this.open = 0;
		const inst = this.instance;
		this.instance = undefined;
		if (inst) (await inst).closeSync();
	}
}
