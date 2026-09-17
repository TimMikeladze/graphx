import { afterEach, beforeAll, expect, test } from 'bun:test';
import init, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { createWasmClient, openBrowserDb } from '../../src/core/browser.ts';
import { Graph, defineGraphSchema, init as initGraph, history } from '../../src/core/portable.ts';
import { z } from 'zod';
import type { ConnectionClient } from '../../src/core/connection.ts';

let sqlite: Sqlite3Static;
const clients: ConnectionClient[] = [];
beforeAll(async () => {
	sqlite = await init();
});
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
});
function memory() {
	const db = new sqlite.oo1.DB();
	const client = createWasmClient(db);
	clients.push(client);
	return { db, client };
}

test('WASM values retain binary offsets, dates, boolean and 64-bit integers', async () => {
	const { client } = memory();
	const bytes = new Uint8Array([9, 0, 255, 8]);
	const result = await client.execute({
		sql: 'SELECT ? AS bytes, ? AS date, ? AS flag, ? AS id',
		args: [bytes.subarray(1, 3), new Date(123456789), true, 9223372036854775807n],
	});
	expect(result.rows[0]).toEqual({
		bytes: new Uint8Array([0, 255]),
		date: 123456789,
		flag: 1,
		id: 9223372036854775807n,
	});
	expect(result.columns).toEqual(['bytes', 'date', 'flag', 'id']);
	expect(
		(await client.execute({ sql: 'SELECT :name AS name', args: { name: 'hello' } })).rows[0],
	).toEqual({ name: 'hello' });
	expect(
		(await client.execute({ sql: 'SELECT ? AS empty', args: [new Uint8Array()] })).rows[0],
	).toEqual({ empty: new Uint8Array() });
});

test('WASM errors finalize statements and failed batches roll back', async () => {
	const { db, client } = memory();
	await client.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)');
	await expect(
		client.batch([
			{ sql: 'INSERT INTO t VALUES(?, ?)', args: [1, 'kept?'] },
			"INSERT INTO t VALUES(1, 'duplicate')",
		]),
	).rejects.toThrow();
	expect((await client.execute('SELECT * FROM t')).rows).toEqual([]);
	await expect(client.execute({ sql: 'SELECT ?', args: [NaN] })).rejects.toThrow();
	await expect(client.execute({ sql: 'SELECT ?', args: [new Date(NaN)] })).rejects.toThrow();
	expect(db.openStatementCount()).toBe(0);
	await expect(
		client.executeMultiple('CREATE TABLE a(id); SELECT * FROM missing; CREATE TABLE b(id);'),
	).rejects.toThrow();
	expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'b'")).rows).toEqual(
		[],
	);
});

test('WASM resolves bare named bindings against every actual parameter prefix', async () => {
	const { db, client } = memory();
	for (const prefix of [':', '@', '$']) {
		expect(
			(await client.execute({ sql: `SELECT ${prefix}name AS value`, args: { name: 'ok' } })).rows,
		).toEqual([{ value: 'ok' }]);
	}
	expect(
		(
			await client.execute({
				sql: 'SELECT :name AS a, @name AS b, $name AS c',
				args: { name: 'ok' },
			})
		).rows,
	).toEqual([{ a: 'ok', b: 'ok', c: 'ok' }]);
	expect(
		(await client.execute({ sql: 'SELECT @name AS value', args: { '@name': 'explicit' } })).rows,
	).toEqual([{ value: 'explicit' }]);
	await expect(
		client.execute({ sql: "SELECT ':name' AS value /* @name */", args: { name: 'unknown' } }),
	).rejects.toThrow(/parameter/i);
	expect(db.openStatementCount()).toBe(0);
});

test('WASM graph supports FTS, history and transaction ownership', async () => {
	const { client } = memory();
	await initGraph(client);
	const graph = new Graph(client, defineGraphSchema({ nodes: { note: z.object({}) }, edges: {} }));
	const note = await graph.addNode({ type: 'note', data: {}, body: 'peach orchard' });
	expect(note.id).toBeTruthy();
	expect((await graph.listNodes({ q: 'orchard' })).nodes.map((n) => n.id)).toEqual([note.id]);
	await graph.updateNode(note.id, { body: 'peach harvest' });
	expect(await history(client, note.id)).toHaveLength(2);
	const tx = await client.transaction();
	await tx.execute('CREATE TABLE rolled_back(id)');
	let outsideDone = false;
	const outside = client.execute('SELECT 1 AS ready').then((r) => {
		outsideDone = true;
		return r;
	});
	await Promise.resolve();
	expect(outsideDone).toBe(false);
	await tx.rollback();
	expect((await outside).rows).toEqual([{ ready: 1 }]);
	expect(
		(await client.execute("SELECT name FROM sqlite_master WHERE name='rolled_back'")).rows,
	).toEqual([]);
});

test('browser opener rejects unavailable OPFS and invalid persistent filenames', async () => {
	await expect(openBrowserDb(sqlite, '/graphx-test.db')).rejects.toThrow(/OPFS|worker/i);
	for (const name of ['', ':memory:', 'file:x?mode=memory', '/a/../b', '/']) {
		await expect(openBrowserDb(sqlite, name)).rejects.toThrow(/filename/i);
	}
});
