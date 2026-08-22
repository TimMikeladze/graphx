import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Root for scratch database files and DuckDB spill.
 *
 * Bare namespaces used to become plain relative paths, which DuckDB resolves against the
 * PROCESS CWD — so every `bun test` run, dev server, and git worktree accumulated its own
 * strand of `ns_*.duckdb` / `test_*.duckdb` files plus `duckdb_temp_storage_*.tmp` spill at
 * whatever directory the process started in. All gitignored, so thousands of files
 * (gigabytes) piled up silently. Anchoring them under one directory makes the whole set
 * discoverable and removable in a single `rm -rf`. Override with `GRAPHX_DATA_DIR`.
 */
export function duckDataDir(): string {
	return process.env.GRAPHX_DATA_DIR ?? join(process.cwd(), '.graphx-data');
}

/** Absolute path for a namespace's database file, creating the containing directory. */
export function duckPathFor(namespace: string): string {
	const dir = duckDataDir();
	mkdirSync(dir, { recursive: true });
	return join(dir, `${namespace}.duckdb`);
}

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
	/**
	 * Parked callers, served by DIRECT HANDOFF. `checkin` passes a live connection straight
	 * to the head of this queue rather than pushing it to `idle` and waking someone to go
	 * find it — a wake only schedules a microtask, so a fresh `acquire()` in the same tick
	 * would win the race to `idle.pop()` and could starve a queued waiter indefinitely.
	 * Resolving with `null` means "a slot freed but there is nothing to hand you" (a
	 * stale-generation discard, or a failed `connect()`), which grants the turn to create.
	 */
	private readonly waiting: Array<(c: TaggedConnection | null) => void> = [];
	/** Live connections of the CURRENT generation. Reset when the instance is replaced. */
	private open = 0;
	private generation = 0;
	private readonly max: number;
	private closed = false;

	/** Where DuckDB spills to disk. Sibling of the database file; see {@link getInstance}. */
	private readonly tempDir: string;

	constructor(
		private readonly path: string,
		opts: { max?: number } = {},
	) {
		this.max = opts.max ?? 4;
		// `:memory:` has no directory to sit beside, so its spill goes under the data dir.
		this.tempDir = this.path === ':memory:' ? join(duckDataDir(), 'tmp') : `${this.path}.tmp`;
	}

	private getInstance(): Promise<DuckDBInstance> {
		// `temp_directory` is pinned rather than left at DuckDB's default, which spills into
		// the PROCESS CWD. A query that outgrows memory then strands multi-gigabyte
		// `duckdb_temp_storage_*.tmp` files at whatever directory the process happened to
		// start in — and DuckDB does NOT remove them when it is killed mid-query, which is
		// the usual way a big query ends. Anchoring the spill next to the database keeps it
		// in one known, removable place; `max_temp_directory_size` caps a runaway query at a
		// failed query instead of a full disk.
		this.instance ??= DuckDBInstance.create(this.path, {
			temp_directory: this.tempDir,
			max_temp_directory_size: process.env.GRAPHX_DUCK_MAX_TEMP ?? '16GB',
		});
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
			// Only a caller with nobody ahead of it may help itself. A queued waiter is
			// served by direct handoff, so a fresh arrival must not be able to take what
			// was freed for someone already in line.
			if (this.waiting.length === 0) {
				const spare = this.idle.pop();
				if (spare) return spare;
				if (this.open < this.max) return this.create();
			}
			const handed = await new Promise<TaggedConnection | null>((resolve) =>
				this.waiting.push(resolve),
			);
			// A connection handed straight over — no window in which anyone could take it.
			if (handed) return handed;
			if (this.closed) throw new Error('duck pool: closed');
			// Woken because a slot freed with nothing to pass on. We hold the turn, so we
			// may create even though callers are queued behind us; deferring to them here
			// would park us again with nobody left to act, and the pool would hang.
			if (this.open < this.max) return this.create();
		}
	}

	private async create(): Promise<TaggedConnection> {
		this.open++;
		const generation = this.generation;
		try {
			return { raw: await (await this.getInstance()).connect(), generation };
		} catch (e) {
			this.open--;
			// The slot we claimed is free again — pass the turn on rather than leaving the
			// queue parked behind a connection that never opened.
			this.grantTurn();
			throw e;
		}
	}

	/** Wake the longest-waiting caller with no connection: a slot is free, go make one. */
	private grantTurn(): void {
		this.waiting.shift()?.(null);
	}

	private checkin(c: TaggedConnection): void {
		// A connection from a superseded generation is dead — the FATAL that replaced the
		// instance killed it. Returning it to `idle` would hand a corpse to the next
		// caller, and counting it would let the pool exceed `max`.
		if (c.generation !== this.generation || this.closed) {
			closeQuietly(c.raw);
			this.grantTurn();
			return;
		}
		// Direct handoff: give it to whoever has been waiting longest. Going through
		// `idle` would open a window for a same-tick arrival to take it first.
		const next = this.waiting.shift();
		if (next) {
			next(c);
			return;
		}
		this.idle.push(c);
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
		while (this.waiting.length > 0) this.grantTurn();
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
