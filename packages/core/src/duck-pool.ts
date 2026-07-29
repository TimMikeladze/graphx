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

/**
 * A connection tagged with the instance generation it was created against. After a FATAL
 * the instance is replaced, and every connection from the old generation is dead — but a
 * caller may still be holding one and will hand it back through the normal release path.
 * The tag is how `checkin` tells a live connection from a corpse.
 */
interface TaggedConnection {
	raw: RawConnection;
	generation: number;
}

export class DuckPool {
	private instance?: Promise<DuckDBInstance>;
	private readonly idle: TaggedConnection[] = [];
	/** Resumption callbacks, not connection callbacks: a woken waiter re-enters `checkout`
	 *  and takes whatever is available then, which keeps the queue strictly FIFO. */
	private readonly waiting: Array<() => void> = [];
	/** Live connections of the CURRENT generation. Reset when the instance is replaced. */
	private open = 0;
	private generation = 0;
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
		const conn = await this.checkout();
		const raw = conn.raw;
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
					if (isFatalInstanceError(e)) this.rebuild();
					throw e;
				}
			},
			release: () => {
				if (released) return;
				released = true;
				this.checkin(conn);
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

	private async checkout(): Promise<TaggedConnection> {
		for (;;) {
			if (this.closed) throw new Error('duck pool: closed');
			const spare = this.idle.pop();
			if (spare) return spare;
			// Create only when nobody is queued ahead of us. Without that guard a late
			// arrival takes the slot an earlier waiter has been parked on, and under a
			// steady stream of arrivals the earlier waiter is never served.
			if (this.open < this.max && this.waiting.length === 0) {
				this.open++;
				const generation = this.generation;
				try {
					return { raw: await (await this.getInstance()).connect(), generation };
				} catch (e) {
					this.open--;
					// The slot we claimed is free again — offer it to whoever was queued
					// rather than leaving them parked behind a connection that never opened.
					this.wake();
					throw e;
				}
			}
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
	}

	/** Resume the longest-waiting caller, if any. */
	private wake(): void {
		this.waiting.shift()?.();
	}

	private checkin(c: TaggedConnection): void {
		// A connection from a superseded generation is dead — the FATAL that replaced the
		// instance killed it. Returning it to `idle` would hand a corpse to the next
		// caller, and counting it would let the pool exceed `max`.
		if (c.generation !== this.generation || this.closed) {
			closeQuietly(c.raw);
		} else {
			this.idle.push(c);
		}
		this.wake();
	}

	/**
	 * Discard the instance and every connection on it. The only recovery from a FATAL —
	 * a brand-new connection on the same instance is dead too.
	 *
	 * Connections currently checked out cannot be reclaimed here; they are neutralized by
	 * the generation bump, which makes `checkin` close them instead of pooling them.
	 */
	private rebuild(): void {
		for (const c of this.idle.splice(0)) closeQuietly(c.raw);
		this.generation++;
		this.open = 0;
		this.instance = undefined;
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const c of this.idle.splice(0)) closeQuietly(c.raw);
		this.open = 0;
		// Release everyone parked in the queue. Without this a caller waiting beyond `max`
		// when the pool closes is never resumed and its promise never settles.
		while (this.waiting.length > 0) this.wake();
		const inst = this.instance;
		this.instance = undefined;
		if (inst) (await inst).closeSync();
	}
}

function closeQuietly(raw: RawConnection): void {
	try {
		raw.closeSync();
	} catch {
		/* the instance may already be dead; closing is best-effort */
	}
}
