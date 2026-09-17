import type { DbClient, DbTransaction, Dialect } from './dialect.ts';

/** Private transaction view. SQL batches join the owned transaction; all public
 * scoped operations are queued as whole operations, not interleaved statements. */
export function createAtomicSession(
	tx: DbTransaction,
	dialect: Dialect,
): {
	client: DbClient;
	run: <T>(fn: () => Promise<T>) => Promise<T>;
	finish: () => Promise<void>;
} {
	let open = true;
	let tail = Promise.resolve();
	let failure: { error: unknown } | undefined;
	return {
		client: {
			dialect,
			execute: (stmt) => tx.execute(stmt),
			async batch(stmts) {
				const results = [];
				for (const stmt of stmts) results.push(await tx.execute(stmt));
				return results;
			},
			async transaction() {
				throw new Error('Nested atomic transactions are not supported');
			},
			async executeMultiple() {
				throw new Error('Schema changes are not supported in atomic scopes');
			},
			close() {
				throw new Error('An atomic scope does not own the connection');
			},
		},
		run<T>(fn: () => Promise<T>): Promise<T> {
			if (!open) return Promise.reject(new Error('Atomic graph scope is closed'));
			const result = tail.then(() => {
				if (failure) throw failure.error;
				return fn();
			});
			tail = result.then(
				() => {},
				(error) => {
					failure ??= { error };
				},
			);
			return result;
		},
		async finish() {
			open = false;
			await tail;
			if (failure) throw failure.error;
		},
	};
}
