import { isAbsolute } from 'node:path';
import Database from 'libsql';
import { createConnectionClient, type ConnectionClient } from './connection.ts';
import type { SqlStatement, SqlValue } from './dialect.ts';
import { applyConnPragmas } from './runtime.ts';

/** An owned native libSQL connection whose lock contention never blocks the JS thread. */
export interface LocalDbClient extends ConnectionClient {
	readonly busyTimeoutMs: 0;
}

function inputValue(value: unknown): SqlValue {
	if (value === null || typeof value === 'string') return value;
	if (typeof value === 'boolean') return Number(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new TypeError(
				'Local SQLite binding requires a finite number with safe integer precision',
			);
		}
		return value;
	}
	if (typeof value === 'bigint') {
		if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new TypeError('Local SQLite bigint binding exceeds safe integer precision');
		}
		return value;
	}
	if (value instanceof Date) return inputValue(value.getTime());
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	}
	throw new TypeError('Unsupported local SQLite binding');
}

function outputValue(value: unknown): unknown {
	if (typeof value === 'bigint') {
		if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER))
			throw new RangeError(
				'Received integer which cannot be safely represented as a JavaScript number',
			);
		return Number(value);
	}
	if (ArrayBuffer.isView(value))
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
	return value;
}

function statement(input: SqlStatement): SqlStatement {
	if (typeof input === 'string') return input;
	const args = input.args ?? [];
	return {
		sql: input.sql,
		args: Array.isArray(args)
			? args.map(inputValue)
			: Object.fromEntries(
					Object.entries(args).map(([key, value]) => [
						/^[:@$]/.test(key) ? key.slice(1) : key,
						inputValue(value),
					]),
				),
	};
}

/**
 * Open one exclusively owned native libSQL file. WAL/FULL sync are verified;
 * busy_timeout stays zero, including through Graphx init. Graph.atomic retries
 * lock acquisition asynchronously, allowing another callback to finish its write.
 * Uses one native Database handle; transactions retain this physical connection.
 * A failed native statement outside a transaction closes the client, because the
 * native library cannot finalize failed prepared statements. Reopen after such
 * errors; use Graph.atomic for asynchronous lock acquisition and safe retries.
 * Call init(client, embedder?) to initialize Graphx after opening, and await close.
 */
export async function openLocalDb(filename: string): Promise<LocalDbClient> {
	if (!isAbsolute(filename) || filename.includes('\0')) {
		throw new TypeError('openLocalDb requires an absolute persistent filesystem path');
	}
	return openNativeDb(filename, true);
}

/**
 * Open one private, RAM-only native libSQL namespace. All transactions use the
 * same physical handle, so commits retain state until close or process exit.
 * No file or shared-cache name is created. Other openMemoryDb calls are isolated.
 * Call init(client) before Graphx operations and await close when finished.
 */
export async function openMemoryDb(): Promise<LocalDbClient> {
	return openNativeDb(':memory:', false);
}

async function openNativeDb(filename: string, persistent: boolean): Promise<LocalDbClient> {
	const raw = new Database(filename, { timeout: 0 });
	const client = createConnectionClient(
		{
			async execute(input) {
				const normalized = statement(input);
				const sql = typeof normalized === 'string' ? normalized : normalized.sql;
				const args = typeof normalized === 'string' ? [] : (normalized.args ?? []);
				let columns: string[] = [];
				let rows: Record<string, unknown>[] = [];
				// Only these exact, unbound statements are emitted by the connection owner.
				// libsql 0.5.29 leaves a failed prepared BEGIN in progress; subsequent
				// no-op DDL can pin a stale snapshot. exec finalizes even on failure.
				if (
					typeof normalized === 'string' &&
					['BEGIN IMMEDIATE', 'BEGIN DEFERRED', 'COMMIT', 'ROLLBACK'].includes(sql)
				) {
					raw.exec(sql);
				} else {
					const prepared = raw.prepare(sql).safeIntegers(true);
					function step<T>(run: () => T): T {
						try {
							return run();
						} catch (error) {
							// Native libsql exposes no reset/finalize for failed statements.
							// The owner rolls back a held transaction; an autocommit failure
							// must instead reject pending work and close before serving reads.
							if (!raw.inTransaction) void client.close();
							throw error;
						}
					}
					if (prepared.reader) {
						columns = prepared.columns().map((column) => column.name);
						rows = (step(() => prepared.all(args)) as Record<string, unknown>[]).map((row) =>
							Object.fromEntries(
								Object.entries(row).map(([key, value]) => [key, outputValue(value)]),
							),
						);
					} else step(() => prepared.run(args));
				}
				// Drain RETURNING before reading metadata (driver reader results omit it).
				const metadata = raw
					.prepare('SELECT changes() AS changes, last_insert_rowid() AS rowid')
					.safeIntegers(true)
					.all()[0] as { changes: bigint; rowid: bigint };
				return {
					rows,
					columns,
					rowsAffected: outputValue(metadata.changes) as number,
					lastInsertRowid: metadata.rowid,
				};
			},
			executeMultiple: async (sql) => {
				raw.exec(sql);
			},
			close: () => {
				raw.close();
			},
		},
		'libsql',
	) as LocalDbClient;
	Object.defineProperty(client, 'busyTimeoutMs', { value: 0, enumerable: true });
	try {
		// Set before journal initialization so a held lock fails immediately.
		await applyConnPragmas(client);
		await client.execute(`PRAGMA journal_mode = ${persistent ? 'WAL' : 'MEMORY'}`);
		if (!persistent) {
			// Keep temporary query structures in RAM as well as the main database.
			await client.execute('PRAGMA temp_store = MEMORY');
			if ((await client.execute('PRAGMA temp_store')).rows[0]?.temp_store !== 2)
				throw new Error('openMemoryDb failed to configure memory-only temporary storage');
		}
		await client.execute('PRAGMA synchronous = FULL');
		const file = (await client.execute('PRAGMA database_list')).rows.find(
			(row) => row.name === 'main',
		)?.file;
		if (persistent ? typeof file !== 'string' || !isAbsolute(file) : file !== '')
			throw new Error(
				persistent
					? 'openLocalDb did not open a persistent file'
					: 'openMemoryDb did not open a RAM-only namespace',
			);
		for (const [pragma, column, expected] of [
			['journal_mode', 'journal_mode', persistent ? 'wal' : 'memory'],
			['synchronous', 'synchronous', 2],
			['foreign_keys', 'foreign_keys', 1],
			['busy_timeout', 'timeout', 0],
		] as const) {
			const actual = (await client.execute(`PRAGMA ${pragma}`)).rows[0]?.[column];
			if (actual !== expected) throw new Error(`Native SQLite failed to configure ${pragma}`);
		}
		return client;
	} catch (error) {
		try {
			await client.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], 'Local SQLite initialization and close failed');
		}
		throw error;
	}
}
