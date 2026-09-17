import type {
	DbClient,
	DbTransaction,
	Dialect,
	SqlResult,
	SqlStatement,
	TransactionMode,
} from './dialect.ts';

/**
 * One exclusively owned SQLite-family connection. No bypass callers may use it.
 * execute runs one statement; executeMultiple runs a script. Both settle only
 * after execution completes. Transaction control is reserved for this owner.
 */
export interface SqlConnection {
	execute(stmt: SqlStatement): Promise<SqlResult>;
	executeMultiple(sql: string): Promise<void>;
	close(): void;
}

export interface ConnectionClient extends DbClient {
	/** Reject new/pending work, roll back held transactions, then close physically.
	 * Await this promise to observe shutdown failures, including failed rollback. */
	close(): Promise<void>;
}

type Release = () => void;
type Waiter = { resolve: (release: Release) => void; reject: (error: unknown) => void };

/**
 * Adapt a physical connection, serializing all ownership in FIFO order. SQL
 * passed by callers must not contain BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE;
 * use transaction/batch for transaction control. The dialect describes SQL
 * support supplied by the driver, not functionality implemented by this owner.
 */
export function createConnectionClient(
	connection: SqlConnection,
	dialect: Extract<Dialect, 'libsql' | 'sqlite'>,
): ConnectionClient {
	const closedError = new Error('SQL connection client is closed');
	const pending: Waiter[] = [];
	let occupied = false;
	let closed = false;
	let poison: Error | undefined;
	let active: DbTransaction | undefined;
	let closing: Promise<void> | undefined;
	let onIdle: (() => void) | undefined;

	function unavailable(): Error | undefined {
		return poison ?? (closed ? closedError : undefined);
	}

	function rejectPending(error: unknown): void {
		for (const waiter of pending.splice(0)) waiter.reject(error);
	}

	function release(): void {
		occupied = false;
		const next = pending.shift();
		if (next) {
			occupied = true;
			next.resolve(release);
		} else {
			onIdle?.();
			onIdle = undefined;
		}
	}

	function acquire(): Promise<Release> {
		const error = unavailable();
		if (error) return Promise.reject(error);
		if (!occupied) {
			occupied = true;
			return Promise.resolve(release);
		}
		return new Promise((resolve, reject) => pending.push({ resolve, reject }));
	}

	async function standalone<T>(run: () => Promise<T>): Promise<T> {
		const unlock = await acquire();
		try {
			const error = unavailable();
			if (error) throw error;
			return await run();
		} finally {
			unlock();
		}
	}

	async function rollbackConnection(): Promise<void> {
		try {
			await connection.execute('ROLLBACK');
		} catch (cause) {
			poison = new Error('SQL connection is unusable after failed rollback', { cause });
			rejectPending(poison);
			throw poison;
		}
	}

	async function transaction(mode: TransactionMode = 'write'): Promise<DbTransaction> {
		const unlock = await acquire();
		try {
			const error = unavailable();
			if (error) throw error;
			// Read/deferred modes defer acquiring SQLite's write lock. Read mode
			// is a scheduling hint here, not a read-only authorization boundary.
			await connection.execute(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
		} catch (error) {
			unlock();
			throw error;
		}
		if (closed) {
			try {
				await rollbackConnection();
			} finally {
				unlock();
			}
			throw closedError;
		}

		let tail = Promise.resolve();
		let failure: { error: unknown } | undefined;
		let termination: Promise<void> | undefined;
		let rollbackFailure: { error: unknown } | undefined;
		let sealed = false;

		async function rollback(): Promise<void> {
			try {
				await rollbackConnection();
			} catch (error) {
				rollbackFailure = { error };
				throw error;
			}
		}

		function finish(commit: boolean): Promise<void> {
			sealed = true;
			termination = tail.then(async () => {
				try {
					if (commit && !failure && !closed) {
						try {
							await connection.execute('COMMIT');
						} catch (error) {
							try {
								await rollback();
							} catch (rollbackError) {
								throw new AggregateError([error, rollbackError], 'Commit and rollback failed');
							}
							throw error;
						}
					} else {
						await rollback();
						if (commit) throw failure ? failure.error : closedError;
					}
				} finally {
					active = undefined;
					unlock();
				}
			});
			return termination;
		}

		const tx: DbTransaction = {
			get closed() {
				return sealed;
			},
			execute(stmt) {
				if (sealed) return Promise.reject(new Error('SQL transaction is closed'));
				const error = unavailable();
				if (error) return Promise.reject(error);
				const result = tail.then(async () => {
					const error = unavailable();
					if (error) throw error;
					if (failure) throw failure.error;
					return connection.execute(stmt);
				});
				tail = result.then(
					() => {},
					(error: unknown) => {
						failure ??= { error };
					},
				);
				return result;
			},
			commit() {
				if (sealed) return Promise.reject(new Error('SQL transaction is closed'));
				return finish(true);
			},
			rollback() {
				if (!termination) return finish(false);
				// A rollback after a completed/failed commit is harmless; a rollback
				// failure remains observable to every rollback caller.
				return termination.then(
					() => {},
					() => {
						if (rollbackFailure) throw rollbackFailure.error;
					},
				);
			},
		};
		active = tx;
		return tx;
	}

	return {
		dialect,
		execute: (stmt) => standalone(() => connection.execute(stmt)),
		executeMultiple: (sql) => standalone(() => connection.executeMultiple(sql)),
		transaction,
		async batch(stmts, mode) {
			const tx = await transaction(mode);
			try {
				const results: SqlResult[] = [];
				for (const stmt of stmts) results.push(await tx.execute(stmt));
				await tx.commit();
				return results;
			} catch (error) {
				try {
					await tx.rollback();
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], 'Batch and rollback failed');
				}
				throw error;
			}
		},
		close() {
			if (closing) return closing;
			closed = true;
			rejectPending(closedError);
			// Terminate even abandoned handles; callers need not release a lease
			// to make shutdown progress. Running SQL must finish before rollback.
			void active?.rollback().catch(() => {});
			closing = (async () => {
				if (occupied)
					await new Promise<void>((resolve) => {
						onIdle = resolve;
					});
				try {
					connection.close();
				} catch (error) {
					if (poison) throw new AggregateError([poison, error], 'Rollback and close failed');
					throw error;
				}
				if (poison) throw poison;
			})();
			// DbClient's legacy void close callers cannot await cleanup. Mark the
			// original promise handled without swallowing failures for awaiters.
			void closing.catch(() => {});
			return closing;
		},
	};
}
