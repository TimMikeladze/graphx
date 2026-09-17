import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createConnectionClient } from '../../src/core/connection.ts';
import type { DbClient, DbTransaction } from '../../src/core/dialect.ts';
import { createLocalBlobStore } from '../../src/core/local-blobs.ts';
import { init } from '../../src/core/schema.ts';
import { makeTestDb, TEST_DRIVER } from './harness.ts';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

// Real ordinary SQLite returns Uint8Array; libSQL returns ArrayBuffer. Exercise
// both driver boundaries, without importing another test suite's private fixture.
function sqlite(): DbClient {
	const db = new Database(':memory:');
	const client = createConnectionClient(
		{
			async execute(stmt) {
				const sql = typeof stmt === 'string' ? stmt : stmt.sql;
				const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
				const query = db.query(sql);
				try {
					const rows = Array.isArray(args)
						? query.all(...(args as SQLQueryBindings[]))
						: query.all(args as SQLQueryBindings);
					return { rows: rows as Record<string, unknown>[], rowsAffected: 0 };
				} finally {
					query.finalize();
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
	disposers.push(() => client.close());
	return client;
}

function selectedDriver(): DbClient {
	const db = makeTestDb({ file: true });
	disposers.push(db.teardown);
	return db.client;
}

async function reference(
	executor: Pick<DbClient, 'execute'>,
	id: string,
	hash: string | null,
	validTo = 8640000000000000,
) {
	await executor.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	await executor.execute({
		sql: 'INSERT INTO node_versions (id, type, content_hash, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)',
		args: [id, 'attachment', hash, 1, validTo],
	});
}

test('rejects unsupported dialects before creating local blob storage', async () => {
	const client = sqlite();
	await init(client);
	for (const dialect of ['postgres', 'duckdb'] as const) {
		await expect(createLocalBlobStore({ ...client, dialect })).rejects.toThrow(dialect);
	}
	expect(
		(await client.execute("SELECT name FROM sqlite_master WHERE name = 'graphx_blobs'")).rows,
	).toEqual([]);
});

for (const [driver, open] of [
	[TEST_DRIVER, selectedDriver],
	['sqlite', sqlite],
] as const) {
	if (driver !== 'libsql' && driver !== 'sqlite') continue;
	describe(`local blobs (${driver})`, () => {
		async function setup() {
			const client = open();
			await init(client);
			return { client, blobs: await createLocalBlobStore(client) };
		}

		test('round trips empty, non-UTF-8, sliced, and multi-megabyte bytes exactly', async () => {
			const { blobs } = await setup();
			const large = Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251);
			for (const bytes of [
				new Uint8Array(),
				new Uint8Array([0, 255, 128, 192, 13, 10]),
				new Uint8Array([99, 0, 255, 88]).subarray(1, 3),
				large,
			]) {
				const ref = await blobs.put(bytes);
				expect(ref.size).toBe(bytes.length);
				expect(ref.uri).toBe(`graphx:blob:${ref.hash}`);
				expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
				expect(await blobs.get(ref.uri)).toEqual(bytes);
			}
		});

		test('uses standard SHA-256 addresses and stores duplicate bytes once', async () => {
			const { client, blobs } = await setup();
			const first = await blobs.put(new Uint8Array());
			expect(first.hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
			expect(await blobs.put(new Uint8Array())).toEqual(first);
			expect(
				Number((await client.execute('SELECT COUNT(*) AS n FROM graphx_blobs')).rows[0]!.n),
			).toBe(1);
			expect(await (await createLocalBlobStore(client)).get(first.uri)).toEqual(new Uint8Array());
		});

		test('snapshots input immediately and isolates returned bytes from storage', async () => {
			const { blobs } = await setup();
			const input = new Uint8Array([0, 255, 128]);
			const putting = blobs.put(input);
			input.fill(42);
			const ref = await putting;
			const first = (await blobs.get(ref.uri))!;
			expect(first).toEqual(new Uint8Array([0, 255, 128]));
			first.fill(19);
			expect(await blobs.get(ref.uri)).toEqual(new Uint8Array([0, 255, 128]));
		});

		test('rejects noncanonical URIs and returns null only for valid absent addresses', async () => {
			const { blobs } = await setup();
			const ref = await blobs.put(new Uint8Array());
			for (const uri of [
				'',
				ref.hash,
				ref.uri.toUpperCase(),
				`${ref.uri}\n`,
				` ${ref.uri}`,
				`${ref.uri}?download`,
				ref.uri.slice(0, -1),
				`${ref.uri}0`,
				`graphx:blob:${'g'.repeat(64)}`,
			]) {
				await expect(blobs.get(uri)).rejects.toThrow('URI');
			}
			expect(await blobs.get(`graphx:blob:${'0'.repeat(64)}`)).toBeNull();
		});

		test('rejects stored bytes that no longer match their content address', async () => {
			const { client, blobs } = await setup();
			const ref = await blobs.put(new Uint8Array([1, 2, 3]));
			await client.execute({
				sql: 'UPDATE graphx_blobs SET bytes = ? WHERE hash = ?',
				args: [new Uint8Array([1, 2, 4]), ref.hash],
			});
			await expect(blobs.get(ref.uri)).rejects.toThrow('integrity');
		});

		test('rejects nonbinary values instead of converting corrupt storage to content', async () => {
			// SQLite affinity permits a TEXT value in a BLOB column.
			const { client, blobs } = await setup();
			const ref = await blobs.put(new Uint8Array([1, 2, 3]));
			await client.execute({
				sql: 'UPDATE graphx_blobs SET bytes = ? WHERE hash = ?',
				args: ['text corruption', ref.hash],
			});
			await expect(blobs.get(ref.uri)).rejects.toThrow('binary');
		});

		test('bound puts and graph references roll back together or commit together', async () => {
			const { client, blobs } = await setup();
			let tx = await client.transaction('write');
			try {
				let bound = blobs.inTransaction(tx);
				const rolledBack = await bound.put(new Uint8Array([1, 2]));
				await reference(tx, 'rolled-back', rolledBack.hash);
				expect(await bound.get(rolledBack.uri)).toEqual(new Uint8Array([1, 2]));
				await tx.rollback();
				expect(await blobs.get(rolledBack.uri)).toBeNull();
				expect(
					(await client.execute("SELECT * FROM node_versions WHERE id = 'rolled-back'")).rows,
				).toEqual([]);
				tx = await client.transaction('write');
				bound = blobs.inTransaction(tx);
				const committed = await bound.put(new Uint8Array([3, 4]));
				await reference(tx, 'committed', committed.hash);
				await tx.commit();
				expect(await blobs.get(committed.uri)).toEqual(new Uint8Array([3, 4]));
				expect(
					(await client.execute("SELECT content_hash FROM node_versions WHERE id = 'committed'"))
						.rows[0]!.content_hash,
				).toBe(committed.hash);
			} finally {
				if (!tx.closed) await tx.rollback();
			}
		});

		test('rejects rebinding and rejects operations after a transaction closes', async () => {
			const { client, blobs } = await setup();
			const tx = await client.transaction('write');
			let next: DbTransaction | undefined;
			try {
				const bound = blobs.inTransaction(tx);
				expect(bound.inTransaction(tx)).toBe(bound);
				const ref = await bound.put(new Uint8Array([1]));
				await tx.commit();
				await expect(bound.put(new Uint8Array([2]))).rejects.toThrow();
				await expect(bound.get(ref.uri)).rejects.toThrow();
				await expect(bound.gc()).rejects.toThrow();
				next = await client.transaction('write');
				expect(() => bound.inTransaction(next!)).toThrow('transaction');
				await next.rollback();
				expect(await blobs.get(ref.uri)).toEqual(new Uint8Array([1]));
			} finally {
				if (!tx.closed) await tx.rollback();
				if (next && !next.closed) await next.rollback();
			}
		});

		test('GC preserves current and historical references and counts only removed blobs', async () => {
			const { client, blobs } = await setup();
			expect(await blobs.gc()).toBe(0);
			const current = await blobs.put(new Uint8Array([1]));
			const historical = await blobs.put(new Uint8Array([2]));
			const orphan = await blobs.put(new Uint8Array([3]));
			await reference(client, 'current', current.hash);
			await reference(client, 'history', historical.hash, 10);
			await reference(client, 'no-attachment', null);
			// Staging remains readable until explicit GC; puts and gets never collect.
			expect(await blobs.get(orphan.uri)).toEqual(new Uint8Array([3]));
			expect(await blobs.gc()).toBe(1);
			expect(await blobs.get(current.uri)).toEqual(new Uint8Array([1]));
			expect(await blobs.get(historical.uri)).toEqual(new Uint8Array([2]));
			expect(await blobs.get(orphan.uri)).toBeNull();
			expect(await blobs.gc()).toBe(0);
			await client.execute('DELETE FROM node_versions');
			expect(await blobs.gc()).toBe(2);
		});

		test('bound GC sees reference changes in its transaction and rolls back deletion', async () => {
			const { client, blobs } = await setup();
			const retained = await blobs.put(new Uint8Array([1]));
			const released = await blobs.put(new Uint8Array([2]));
			await reference(client, 'released', released.hash);
			const tx = await client.transaction('write');
			try {
				const bound = blobs.inTransaction(tx);
				await reference(tx, 'retained', retained.hash);
				await tx.execute("DELETE FROM node_versions WHERE id = 'released'");
				expect(await bound.gc()).toBe(1);
				expect(await bound.get(released.uri)).toBeNull();
				expect(await bound.get(retained.uri)).toEqual(new Uint8Array([1]));
				await tx.rollback();
				expect(await blobs.get(released.uri)).toEqual(new Uint8Array([2]));
				expect(await blobs.gc()).toBe(1);
				expect(await blobs.get(retained.uri)).toBeNull();
			} finally {
				if (!tx.closed) await tx.rollback();
			}
		});
	});
}
