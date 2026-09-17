import { afterEach, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
	createExpoClient,
	openExpoDb,
	type ExpoDatabase,
	type ExpoSqliteModule,
} from '../../src/core/expo.ts';
import { Graph, hashEmbed, init, defineGraphSchema } from '../../src/core/portable.ts';
import type { SqlStatement } from '../../src/core/dialect.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

// Actual Bun SQLite behind Expo 57's prepared-statement shape. This verifies the
// adapter contract, not the native bridge, mobile filesystem or app relaunch.
function physical(path = ':memory:') {
	const db = new Database(path);
	let closed = false;
	const state = {
		prepared: 0,
		finalized: 0,
		closes: 0,
		fault: (_phase: string, _sql: string): void => {},
		rows: (_sql: string, rows: Record<string, unknown>[]) => rows,
	};
	const connection: ExpoDatabase = {
		async prepareAsync(sql) {
			state.fault('prepare', sql);
			const statement = db.query(sql);
			state.prepared++;
			return {
				async executeAsync(params) {
					state.fault('execute', sql);
					const iterator = Array.isArray(params)
						? statement.iterate(...(params as SQLQueryBindings[]))
						: statement.iterate(params as SQLQueryBindings);
					const first = iterator.next();
					const meta = db.query('SELECT changes() AS n, last_insert_rowid() AS id').get() as {
						n: number;
						id: number;
					};
					return {
						changes: meta.n,
						// SDK57 Android narrows this metadata to Int; row columns remain numbers.
						lastInsertRowId: meta.id | 0,
						async getAllAsync() {
							state.fault('rows', sql);
							const rows = first.done ? [] : [first.value, ...iterator];
							return state.rows(sql, rows as Record<string, unknown>[]);
						},
					};
				},
				async getColumnNamesAsync() {
					return statement.columnNames;
				},
				async finalizeAsync() {
					statement.finalize();
					state.finalized++;
					state.fault('finalize', sql);
				},
			};
		},
		async execAsync(sql) {
			state.fault('script', sql);
			db.exec(sql);
		},
		closeSync() {
			if (!closed) {
				db.close();
				closed = true;
				state.closes++;
			}
			state.fault('close', '');
		},
	};
	cleanup.push(() => {
		if (!closed) db.close();
	});
	return { connection, state };
}
function wrapped() {
	const harness = physical();
	const client = createExpoClient(harness.connection);
	cleanup.push(() => client.close());
	return { ...harness, client };
}
function nativeModule() {
	const dir = mkdtempSync(join(tmpdir(), 'graphx-expo-'));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const opened: ReturnType<typeof physical>[] = [];
	const calls: unknown[][] = [];
	const module: ExpoSqliteModule = {
		defaultDatabaseDirectory: dir,
		async openDatabaseAsync(name, options, directory) {
			calls.push([name, options, directory]);
			const harness = physical(join(directory ?? dir, name));
			opened.push(harness);
			return harness.connection;
		},
	};
	return { module, dir, opened, calls };
}

test('Expo prepared statements round-trip bindings, rows, blobs and RETURNING metadata', async () => {
	const { client, state } = wrapped();
	await client.execute(
		'CREATE TABLE values_test (id INTEGER PRIMARY KEY, flag, stamp, bytes, integer_value, text_value)',
	);
	const buffer = new Uint8Array([99, 1, 2, 99]);
	const inserted = await client.execute({
		sql: 'INSERT INTO values_test VALUES (NULL, ?, ?, ?, ?, ?) RETURNING id, bytes',
		args: [true, new Date(1234), buffer.subarray(1, 3), 42n, 'peach'],
	});
	expect(inserted.rowsAffected).toBe(1);
	expect(inserted.lastInsertRowid).toBe(1n);
	expect(inserted.rows[0]?.bytes).toEqual(new Uint8Array([1, 2]));
	expect(inserted.columns).toEqual(['id', 'bytes']);
	const read = await client.execute({
		sql: 'SELECT * FROM values_test WHERE text_value = $text',
		args: { $text: 'peach' },
	});
	expect(read.rows[0]).toEqual({
		id: 1,
		flag: 1,
		stamp: 1234,
		bytes: new Uint8Array([1, 2]),
		integer_value: 42,
		text_value: 'peach',
	});
	for (const binary of [
		buffer.buffer,
		new DataView(buffer.buffer, 1, 2),
		new Uint16Array(buffer.buffer, 0, 1),
	]) {
		const r = await client.execute({ sql: 'SELECT ? AS value', args: [binary] } as SqlStatement);
		expect(r.rows[0]?.value).toEqual(
			binary instanceof ArrayBuffer
				? buffer
				: new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength),
		);
	}
	expect(state.finalized).toBe(state.prepared);
});

test('Expo rejects unsupported or lossy bindings before preparing a statement', async () => {
	const { client, state } = wrapped();
	for (const value of [
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		9007199254740993n,
		new Date(NaN),
		undefined,
		{},
		Symbol('bad'),
	]) {
		await expect(
			client.execute({ sql: 'SELECT ?', args: [value] } as SqlStatement),
		).rejects.toThrow();
	}
	expect(state.prepared).toBe(0);
});

test('Expo copies result bytes before finalization and rejects unsafe numeric results', async () => {
	const { client, state } = wrapped();
	const backing = new Uint8Array([4, 5]);
	state.rows = (sql, rows) => (sql === 'SELECT 1' ? [{ blob: backing }] : rows);
	state.fault = (phase) => {
		if (phase === 'finalize') backing.fill(0);
	};
	expect((await client.execute('SELECT 1')).rows[0]?.blob).toEqual(new Uint8Array([4, 5]));
	state.rows = (sql, rows) =>
		sql === 'SELECT 1' ? [{ unsafe: Number.MAX_SAFE_INTEGER + 1 }] : rows;
	await expect(client.execute('SELECT 1')).rejects.toThrow('safe');
	expect(state.finalized).toBe(state.prepared);
});

for (const phase of ['execute', 'rows', 'finalize']) {
	test(`Expo propagates ${phase} failures and finalizes prepared statements`, async () => {
		const { client, state } = wrapped();
		state.fault = (current) => {
			if (current === phase) throw new Error(`injected ${phase}`);
		};
		await expect(client.execute('SELECT 1')).rejects.toThrow(`injected ${phase}`);
		expect(state.finalized).toBe(1);
	});
}

test('Expo retains both execution and cleanup errors', async () => {
	const { client, state } = wrapped();
	state.fault = (phase) => {
		if (phase === 'execute' || phase === 'finalize') throw new Error(phase);
	};
	await expect(client.execute('SELECT 1')).rejects.toBeInstanceOf(AggregateError);
});

test('Expo connection owner isolates rollback from outside writes and rolls back failed batches', async () => {
	const { client } = wrapped();
	await client.execute('CREATE TABLE items (id PRIMARY KEY)');
	const tx = await client.transaction();
	await tx.execute("INSERT INTO items VALUES ('inside')");
	let finished = false;
	const outside = client.execute("INSERT INTO items VALUES ('outside')").then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	await tx.rollback();
	await outside;
	await expect(
		client.batch(["INSERT INTO items VALUES ('batch')", "INSERT INTO items VALUES ('outside')"]),
	).rejects.toThrow();
	expect((await client.execute('SELECT * FROM items')).rows).toEqual([{ id: 'outside' }]);
});

test('Expo opener requests a new persistent connection, verifies durability and reopens graph data', async () => {
	const { module, dir, calls } = nativeModule();
	let client = await openExpoDb(module, 'vault.db');
	cleanup.push(() => client.close());
	expect(calls[0]).toEqual([
		'vault.db',
		{ useNewConnection: true, finalizeUnusedStatementsBeforeClosing: false },
		dir,
	]);
	expect((await client.execute('PRAGMA journal_mode')).rows[0]?.journal_mode).toBe('wal');
	expect((await client.execute('PRAGMA synchronous')).rows[0]?.synchronous).toBe(2);
	expect((await client.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys).toBe(1);
	const embedder = hashEmbed(8);
	await init(client, embedder);
	const schema = defineGraphSchema({ nodes: { note: z.object({ path: z.string() }) }, edges: {} });
	const graph = new Graph(client, schema, { embedder });
	const note = await graph.addNode({ type: 'note', data: { path: 'A.md' }, body: 'peach orchard' });
	await client.close();
	client = await openExpoDb(module, 'vault.db');
	await init(client, embedder);
	const reopened = new Graph(client, schema, { embedder });
	expect((await reopened.retrieve({ query: 'peach orchard', k: 1 }))[0]?.id).toBe(note.id);
	expect((await reopened.listNodes({ q: 'orchard' })).nodes[0]?.id).toBe(note.id);
});

test('Expo opener rejects temporary names and non-native module locations without opening', async () => {
	const { module, calls } = nativeModule();
	for (const name of [
		'',
		':memory:',
		'../vault',
		'file:vault?mode=memory',
		'a/b',
		'a\\b',
		'.',
		'..',
		'a\0b',
	]) {
		await expect(openExpoDb(module, name)).rejects.toThrow();
	}
	await expect(
		openExpoDb({ ...module, defaultDatabaseDirectory: '.' }, 'vault.db'),
	).rejects.toThrow('native');
	expect(calls).toHaveLength(0);
});

test('Expo opener closes failed durability initialization without a memory fallback', async () => {
	const { module, opened } = nativeModule();
	const open = module.openDatabaseAsync;
	module.openDatabaseAsync = async (...args) => {
		const db = await open(...args);
		opened.at(-1)!.state.rows = (sql, rows) =>
			sql === 'PRAGMA synchronous' ? [{ synchronous: 0 }] : rows;
		return db;
	};
	await expect(openExpoDb(module, 'vault.db')).rejects.toThrow('synchronous');
	expect(opened).toHaveLength(1);
	expect(opened[0]?.state.closes).toBe(1);
});

test('Expo script and physical close errors remain observable', async () => {
	const { client, state } = wrapped();
	state.fault = (phase) => {
		if (phase === 'script') throw new Error('script failed');
	};
	await expect(client.executeMultiple('CREATE TABLE items(id)')).rejects.toThrow('script failed');
	state.fault = (phase) => {
		if (phase === 'close') throw new Error('close failed');
	};
	await expect(client.close()).rejects.toThrow('close failed');
	state.fault = () => {};
	// Avoid awaiting the same intentionally failed close again in global cleanup.
	cleanup.pop();
});

test('Expo prepare errors allocate no statement and named parameters retain their prefix', async () => {
	const { client, state } = wrapped();
	await expect(client.execute('SELECT * FROM absent_table')).rejects.toThrow('absent_table');
	expect(state.prepared).toBe(0);
	for (const prefix of [':', '@', '$']) {
		await expect(client.execute({ sql: `SELECT ${prefix}v`, args: { v: 1 } })).rejects.toThrow(
			'prefix',
		);
	}
	expect(state.prepared).toBe(0);
	for (const prefix of [':', '@', '$']) {
		expect(
			(
				await client.execute({
					sql: `SELECT ${prefix}value AS result`,
					args: { [`${prefix}value`]: false },
				})
			).rows,
		).toEqual([{ result: 0 }]);
	}
	expect(state.finalized).toBe(6);
});

test('Expo initialization failures preserve both original and close errors', async () => {
	const { module, opened } = nativeModule();
	const open = module.openDatabaseAsync;
	module.openDatabaseAsync = async (...args) => {
		const db = await open(...args);
		opened.at(-1)!.state.fault = (phase, sql) => {
			if (phase === 'execute' && sql === 'PRAGMA synchronous = FULL')
				throw new Error('durability failure');
			if (phase === 'close') throw new Error('close failure');
		};
		return db;
	};
	const error = await openExpoDb(module, 'vault.db').catch((error) => error);
	expect(error).toBeInstanceOf(AggregateError);
	expect(error.errors.map((error: Error) => error.message)).toEqual([
		'durability failure',
		'close failure',
	]);
	expect(opened[0]?.state.closes).toBe(1);
});

test('Expo opener refuses an in-memory connection even if the module returns it for a file name', async () => {
	const { module } = nativeModule();
	const harness = physical();
	module.openDatabaseAsync = async () => harness.connection;
	await expect(openExpoDb(module, 'vault.db')).rejects.toThrow('persistent native file');
	expect(harness.state.closes).toBe(1);
});

test('Expo failed native open is propagated without retry or fallback', async () => {
	let attempts = 0;
	const module: ExpoSqliteModule = {
		defaultDatabaseDirectory: '/app/documents/SQLite',
		async openDatabaseAsync() {
			attempts++;
			throw new Error('disk full');
		},
	};
	await expect(openExpoDb(module, 'vault.db')).rejects.toThrow('disk full');
	expect(attempts).toBe(1);
});

test('Expo failed commit rolls back before outside work can proceed', async () => {
	const { client, state } = wrapped();
	await client.execute('CREATE TABLE items (id PRIMARY KEY)');
	const tx = await client.transaction();
	await tx.execute("INSERT INTO items VALUES ('uncommitted')");
	state.fault = (phase, sql) => {
		if (phase === 'execute' && sql === 'COMMIT') throw new Error('commit failed');
	};
	const outside = client.execute('SELECT * FROM items');
	await expect(tx.commit()).rejects.toThrow('commit failed');
	expect((await outside).rows).toEqual([]);
	expect(state.finalized).toBe(state.prepared);
});

test('Expo close rolls back abandoned transactions before closing the native handle', async () => {
	const { client, state } = wrapped();
	const tx = await client.transaction();
	await tx.execute('CREATE TABLE abandoned (id)');
	const pending = client.execute('SELECT 1');
	const rejected = pending.catch((error: Error) => error);
	await client.close();
	expect(await rejected).toBeInstanceOf(Error);
	expect(tx.closed).toBe(true);
	expect(state.closes).toBe(1);
	expect(state.prepared).toBe(state.finalized);
});

test('Expo returns completed mutation counts for multi-row RETURNING statements', async () => {
	const { client } = wrapped();
	await client.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
	const inserted = await client.execute(
		"INSERT INTO items(value) VALUES ('a'), ('b'), ('c') RETURNING id",
	);
	expect(inserted.rows).toHaveLength(3);
	expect(inserted.rowsAffected).toBe(3);
	const updated = await client.execute(
		"UPDATE items SET value = 'updated' WHERE id < 3 RETURNING id",
	);
	expect(updated.rows).toHaveLength(2);
	expect(updated.rowsAffected).toBe(2);
});

test('Expo preserves row IDs above Android Int range by reading SQLite metadata', async () => {
	const { client } = wrapped();
	await client.execute('CREATE TABLE items (id INTEGER PRIMARY KEY)');
	const inserted = await client.execute('INSERT INTO items VALUES (2147483648) RETURNING id');
	expect(inserted.rows).toEqual([{ id: 2147483648 }]);
	expect(inserted.lastInsertRowid).toBe(2147483648n);
});
