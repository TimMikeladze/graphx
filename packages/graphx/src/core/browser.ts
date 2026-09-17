import type { Database, Sqlite3Static, SqlValue as WasmValue } from '@sqlite.org/sqlite-wasm';
import { createConnectionClient, type ConnectionClient } from './connection.ts';
import type { SqlRow, SqlValue } from './dialect.ts';

function value(input: SqlValue): WasmValue {
	if (input instanceof Date) return value(input.getTime());
	if (typeof input === 'boolean') return input ? 1 : 0;
	if (
		typeof input === 'number' &&
		(!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input)))
	) {
		throw new TypeError(
			'SQLite numbers must be finite; use bigint for integers outside the safe range',
		);
	}
	if (typeof input === 'bigint' && (input < -(1n << 63n) || input >= 1n << 63n)) {
		throw new RangeError('SQLite integers must fit signed 64 bits');
	}
	if (input instanceof Uint8Array) return input.slice();
	if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
	if (
		input === null ||
		typeof input === 'string' ||
		typeof input === 'number' ||
		typeof input === 'bigint'
	)
		return input;
	throw new TypeError('Unsupported SQLite binding');
}

/** Own an oo1 SQLite WASM connection exclusively. Persistence is determined by
 * the supplied connection; use openBrowserDb for a required persistent OPFS DB.
 * Run inside the host's dedicated worker, with domain RPC at the host boundary. */
export function createWasmClient(db: Database): ConnectionClient {
	return createConnectionClient(
		{
			async execute(input) {
				const sql = typeof input === 'string' ? input : input.sql;
				const args = typeof input === 'string' ? undefined : input.args;
				const before = db.changes(true);
				const statement = db.prepare(sql);
				try {
					if (Array.isArray(args)) statement.bind(args.map(value));
					else if (args) {
						for (const [key, arg] of Object.entries(args)) {
							const names = /^[:@$]/.test(key)
								? [key]
								: [':', '@', '$'].map((prefix) => prefix + key);
							const indices = names
								.map((name) => statement.getParamIndex(name))
								.filter((index): index is number => index !== undefined && index > 0);
							if (!indices.length) throw new Error(`Unknown SQLite parameter: ${key}`);
							const normalized = value(arg);
							for (const index of indices) statement.bind(index, normalized);
						}
					}
					const columns = statement.columnCount ? statement.getColumnNames() : [];
					const rows: SqlRow[] = [];
					while (statement.step()) rows.push(statement.get({}));
					const rowsAffected = db.changes(true) === before ? 0 : db.changes();
					const lastInsertRowid = BigInt(
						db.selectValue('SELECT last_insert_rowid()') as number | bigint,
					);
					return { rows, columns, rowsAffected, lastInsertRowid };
				} finally {
					statement.finalize();
				}
			},
			async executeMultiple(sql) {
				db.exec(sql);
			},
			close() {
				db.close();
			},
		},
		'sqlite',
	);
}

/** Open standard OPFS SQLite from an initialized SQLite WASM module in a worker.
 * The host supplies local WASM/proxy-worker assets and COOP/COEP headers. Missing
 * capabilities fail explicitly. Uses rollback journaling for multi-tab access;
 * competing writers can fail with SQLITE_BUSY and must retry their whole operation. */
export async function openBrowserDb(
	sqlite: Sqlite3Static,
	filename: string,
): Promise<ConnectionClient> {
	if (!/^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(filename) || filename.includes('..')) {
		throw new TypeError(
			'OPFS database filename must be a single absolute filename, for example /vault.sqlite3',
		);
	}
	if (
		typeof window !== 'undefined' ||
		!sqlite.oo1.OpfsDb ||
		!sqlite.capi.sqlite3_vfs_find('opfs')
	) {
		throw new Error(
			'Persistent OPFS SQLite requires a dedicated worker, OPFS support, and COOP/COEP isolation headers',
		);
	}
	const db = new sqlite.oo1.OpfsDb(filename, 'c');
	try {
		db.exec(
			'PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
		);
		if (
			db.selectValue('PRAGMA journal_mode') !== 'delete' ||
			db.selectValue('PRAGMA synchronous') !== 2
		) {
			throw new Error('OPFS SQLite could not enable durable rollback journaling');
		}
		return createWasmClient(db);
	} catch (error) {
		db.close();
		throw error;
	}
}
