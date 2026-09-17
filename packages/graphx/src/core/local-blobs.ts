import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertNever, dialectOf, type DbClient, type DbTransaction } from './dialect.ts';

export interface LocalBlobRef {
	/** Canonical graphx:blob:<lowercase SHA-256 hex> address. */
	uri: string;
	hash: string;
	size: number;
}

/** Content-addressed bytes in a SQLite/libSQL graph database. MIME type belongs
 * on each graph node reference, so identical content is stored only once. */
export interface LocalBlobStore {
	/** Copies input before any database I/O; never triggers garbage collection. */
	put(bytes: Uint8Array): Promise<LocalBlobRef>;
	/** Returns an independent byte copy; malformed addresses and corrupt bytes throw. */
	get(uri: string): Promise<Uint8Array | null>;
	/** Removes only blobs unreferenced by every current AND historical node version. */
	gc(): Promise<number>;
	/** Borrows a transaction from the same namespace. Does not commit, roll back,
	 * create schema, or extend its lifetime. Cannot rebind to another transaction. */
	inTransaction(tx: DbTransaction): LocalBlobStore;
}

/**
 * Initialize blob storage after the graph schema has been initialized. Supports
 * SQLite and libSQL; the database determines the namespace, just like graph tables.
 *
 * When GC can run, attachment bytes and graph reference mutations must share one
 * transaction using inTransaction(tx). Staging with put() and writing a reference
 * in a later transaction can race GC. Collection is always explicit.
 */
export async function createLocalBlobStore(client: DbClient): Promise<LocalBlobStore> {
	const dialect = dialectOf(client);
	switch (dialect) {
		case 'sqlite':
		case 'libsql':
			break;
		case 'postgres':
		case 'duckdb':
			throw new Error(`Local blob storage does not support ${dialect}; use SQLite or libSQL`);
		default:
			return assertNever(dialect, 'createLocalBlobStore');
	}
	await client.execute(
		'CREATE TABLE IF NOT EXISTS graphx_blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)',
	);
	return store(client);
}

function store(client: DbClient, tx?: DbTransaction): LocalBlobStore {
	const executor = tx ?? client;
	function assertOpen(): void {
		if (tx?.closed) throw new Error('Local blob transaction is closed');
	}
	const bound: LocalBlobStore = {
		async put(input) {
			assertOpen();
			const bytes = new Uint8Array(input);
			const hash = bytesToHex(sha256(bytes));
			await executor.execute({
				sql: 'INSERT INTO graphx_blobs (hash, bytes) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING',
				args: [hash, bytes],
			});
			return { uri: `graphx:blob:${hash}`, hash, size: bytes.byteLength };
		},
		async get(uri) {
			assertOpen();
			if (uri.length !== 76 || !/^graphx:blob:[0-9a-f]{64}$/.test(uri)) {
				throw new Error('Invalid local blob URI');
			}
			const hash = uri.slice(12);
			const result = await executor.execute({
				sql: 'SELECT bytes FROM graphx_blobs WHERE hash = ?',
				args: [hash],
			});
			if (!result.rows.length) return null;
			const value = result.rows[0]!.bytes;
			let bytes: Uint8Array;
			if (value instanceof Uint8Array) bytes = new Uint8Array(value);
			else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
			else throw new Error('Local blob has invalid binary content');
			if (bytesToHex(sha256(bytes)) !== hash)
				throw new Error(`Local blob integrity check failed: ${uri}`);
			return bytes;
		},
		async gc() {
			assertOpen();
			const result = await executor.execute(`DELETE FROM graphx_blobs
WHERE NOT EXISTS (SELECT 1 FROM node_versions WHERE node_versions.content_hash = graphx_blobs.hash)
RETURNING hash`);
			return result.rows.length;
		},
		inTransaction(next) {
			if (tx && tx !== next)
				throw new Error('Cannot rebind local blob store to a different transaction');
			return tx ? bound : store(client, next);
		},
	};
	return bound;
}
