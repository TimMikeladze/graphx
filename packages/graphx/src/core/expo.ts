import { createConnectionClient, type ConnectionClient } from './connection.ts';
import type { SqlResult, SqlRow } from './dialect.ts';

/** Structural subset of Expo SDK 57. Importing this driver never loads React Native. */
export type ExpoBindValue = string | number | null | Uint8Array;
export type ExpoBindParams = ExpoBindValue[] | Record<string, ExpoBindValue>;

export interface ExpoExecuteResult {
	readonly changes: number;
	readonly lastInsertRowId: number;
	getAllAsync(): Promise<unknown[]>;
}

export interface ExpoStatement {
	executeAsync(params: ExpoBindParams): Promise<ExpoExecuteResult>;
	getColumnNamesAsync(): Promise<string[]>;
	finalizeAsync(): Promise<void>;
}

/** An exclusively owned handle; no SQLiteProvider or other caller may share it. */
export interface ExpoDatabase {
	prepareAsync(sql: string): Promise<ExpoStatement>;
	execAsync(sql: string): Promise<void>;
	closeSync(): void;
}

export interface ExpoSqliteModule {
	readonly defaultDatabaseDirectory: string | null;
	openDatabaseAsync(
		name: string,
		options: { useNewConnection: true; finalizeUnusedStatementsBeforeClosing: false },
		directory?: string,
	): Promise<ExpoDatabase>;
}

export interface ExpoOpenOptions {
	/** Persistent native app directory, absolute path or file:/// URL. Defaults to Expo's app directory. */
	directory?: string;
}

function checkedNumber(value: number, context: string): number {
	if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
		throw new TypeError(`${context}: expected a finite number with safe integer precision`);
	}
	return value;
}

function bytes(value: unknown): Uint8Array | undefined {
	if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	}
	return undefined;
}

function bindValue(value: unknown): ExpoBindValue {
	if (value === null || typeof value === 'string') return value;
	if (typeof value === 'boolean') return Number(value);
	if (typeof value === 'number') return checkedNumber(value, 'Expo SQLite binding');
	if (typeof value === 'bigint') {
		// Expo's native bridge accepts numbers, not bigint. Never round a 64-bit integer.
		return checkedNumber(Number(value), 'Expo SQLite bigint binding');
	}
	if (value instanceof Date) return checkedNumber(value.getTime(), 'Expo SQLite date binding');
	const binary = bytes(value);
	if (binary) return binary;
	throw new TypeError('Expo SQLite binding: unsupported value');
}

function bindParams(args: unknown): ExpoBindParams {
	if (Array.isArray(args)) return args.map(bindValue);
	if (!args || typeof args !== 'object') throw new TypeError('Expo SQLite: invalid bindings');
	return Object.fromEntries(
		Object.entries(args).map(([key, value]) => {
			// SDK57 exposes no parameter-name introspection. Guessing a prefix would
			// silently disagree for :name, @name and $name; require the exact SQL name.
			if (!/^[:@$].+/.test(key))
				throw new TypeError(
					'Expo SQLite: named bindings require their exact SQL :name, @name or $name prefix',
				);
			return [key, bindValue(value)];
		}),
	);
}

function copyRows(rows: unknown[]): SqlRow[] {
	return rows.map((row) => {
		if (!row || typeof row !== 'object' || Array.isArray(row))
			throw new TypeError('Expo SQLite: invalid result row');
		return Object.fromEntries(
			Object.entries(row).map(([key, value]) => {
				if (value === null || typeof value === 'string') return [key, value];
				if (typeof value === 'number') return [key, checkedNumber(value, 'Expo SQLite result')];
				const binary = bytes(value);
				if (binary) return [key, binary];
				throw new TypeError(`Expo SQLite: unsupported result value for ${key}`);
			}),
		);
	});
}

/** Drain and finalize one native statement before releasing its results. */
async function executePrepared(
	database: ExpoDatabase,
	sql: string,
	args: ExpoBindParams,
): Promise<{ rows: SqlRow[]; columns: string[] }> {
	const statement = await database.prepareAsync(sql);
	let failure: { error: unknown } | undefined;
	let output: { rows: SqlRow[]; columns: string[] } | undefined;
	try {
		const result = await statement.executeAsync(args);
		const rows = copyRows(await result.getAllAsync());
		const columns = await statement.getColumnNamesAsync();
		output = { rows, columns };
	} catch (error) {
		failure = { error };
	}
	try {
		await statement.finalizeAsync();
	} catch (error) {
		if (failure)
			throw new AggregateError(
				[failure.error, error],
				'Expo SQLite execution and finalization failed',
			);
		throw error;
	}
	if (failure) throw failure.error;
	return output!;
}

/**
 * Transfer exclusive ownership of an already opened Expo database to Graphx.
 * This low-level wrapper does not configure storage or establish persistence; use
 * openExpoDb for a new native persistent connection. Named args must include their
 * exact SQL :/@/$ prefix; Expo provides no parameter-name introspection for bare
 * names. Values above JS's safe integer range are rejected, including bigint.
 * Always await close() to observe rollback/finalization/physical-close failures.
 */
export function createExpoClient(database: ExpoDatabase): ConnectionClient {
	return createConnectionClient(
		{
			async execute(input): Promise<SqlResult> {
				const sql = typeof input === 'string' ? input : input.sql;
				const args = bindParams(typeof input === 'string' ? [] : (input.args ?? []));
				const output = await executePrepared(database, sql, args);
				// SDK57 captures result.changes after the first sqlite3_step, before a
				// RETURNING cursor finishes. Android also narrows lastInsertRowId to Int.
				// Read native SQL metadata after draining, still inside the same lease.
				const metadata = await executePrepared(
					database,
					'SELECT changes() AS changes, last_insert_rowid() AS rowid',
					[],
				);
				const rowsAffected = metadata.rows[0]?.changes;
				const rowid = metadata.rows[0]?.rowid;
				if (
					typeof rowsAffected !== 'number' ||
					!Number.isSafeInteger(rowsAffected) ||
					rowsAffected < 0 ||
					typeof rowid !== 'number' ||
					!Number.isSafeInteger(rowid)
				) {
					throw new TypeError('Expo SQLite: invalid or unsafe result metadata');
				}
				return { ...output, rowsAffected, lastInsertRowid: BigInt(rowid) };
			},
			executeMultiple: (sql) => database.execAsync(sql),
			close: () => database.closeSync(),
		},
		'sqlite',
	);
}

function nativeDirectory(directory: unknown): directory is string {
	return (
		typeof directory === 'string' &&
		/^(\/|file:\/\/\/)/.test(directory) &&
		!directory.includes('\0') &&
		!/[?#]/.test(directory)
	);
}

/**
 * Open an independent persistent Expo native database with WAL and FULL sync.
 * The module and its native app directory are supplied by the host. Expo web's
 * relative default directory is refused; this driver never falls back to memory.
 * Call Graphx init(client, embedder) afterwards to initialize the graph schema.
 * Contract tests on another SQLite runtime do not prove iOS/Android persistence.
 */
export async function openExpoDb(
	sqlite: ExpoSqliteModule,
	name: string,
	opts: ExpoOpenOptions = {},
): Promise<ConnectionClient> {
	if (!name || name === '.' || name === '..' || name.includes('\0') || /[/\\:?#]/.test(name)) {
		throw new TypeError(
			'openExpoDb: expected a persistent database filename, not a path, URI or memory database',
		);
	}
	if (!nativeDirectory(sqlite.defaultDatabaseDirectory)) {
		throw new Error(
			'openExpoDb: a native Expo SQLite module with a persistent app directory is required',
		);
	}
	const directory = opts.directory ?? sqlite.defaultDatabaseDirectory;
	if (!nativeDirectory(directory))
		throw new TypeError('openExpoDb: directory must be an absolute native filesystem location');
	// SDK 57's automatic sqlite3_next_stmt sweep also finalizes FTS5's internal
	// statements, causing a native double-finalize crash during sqlite3_close.
	// This owner drains/finalizes every statement it prepares, so let SQLite
	// dispose of its own virtual-table statements when the connection closes.
	const database = await sqlite.openDatabaseAsync(
		name,
		{ useNewConnection: true, finalizeUnusedStatementsBeforeClosing: false },
		directory,
	);
	const client = createExpoClient(database);
	try {
		const databases = await client.execute('PRAGMA database_list');
		const main = databases.rows.find((row) => row.name === 'main');
		if (!nativeDirectory(main?.file))
			throw new Error('openExpoDb: SQLite did not open a persistent native file');
		await client.execute('PRAGMA journal_mode = WAL');
		await client.execute('PRAGMA synchronous = FULL');
		await client.execute('PRAGMA foreign_keys = ON');
		await client.execute('PRAGMA busy_timeout = 5000');
		for (const [pragma, expected] of [
			['journal_mode', 'wal'],
			['synchronous', 2],
			['foreign_keys', 1],
			['busy_timeout', 5000],
		] as const) {
			const actual = (await client.execute(`PRAGMA ${pragma}`)).rows[0]?.[
				pragma === 'busy_timeout' ? 'timeout' : pragma
			];
			if (actual !== expected)
				throw new Error(
					`openExpoDb: failed to configure ${pragma} (expected ${expected}, received ${String(actual)})`,
				);
		}
		return client;
	} catch (error) {
		try {
			await client.close();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'Expo SQLite initialization and close failed',
			);
		}
		throw error;
	}
}
