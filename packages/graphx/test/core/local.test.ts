import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { openLocalDb, openMemoryDb } from '../../src/core/local.ts';
import { applyConnPragmas } from '../../src/core/runtime.ts';
import { Graph, defineGraphSchema, hashEmbed, init, history } from '../../src/core/portable.ts';
import type { DbClient, SqlStatement } from '../../src/core/dialect.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function filename() {
	const dir = mkdtempSync(join(tmpdir(), 'graphx-local-'));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, 'vault # peach.db');
}
async function open(path = filename()) {
	const client = await openLocalDb(path);
	cleanup.push(() => client.close());
	return client;
}
const schema = defineGraphSchema({ nodes: { note: z.object({ path: z.string() }) }, edges: {} });

test('native memory opener retains Graphx state across commits on one RAM-only connection', async () => {
	const client = await openMemoryDb();
	cleanup.push(() => client.close());
	await init(client);
	expect(client.dialect).toBe('libsql');
	expect(
		(await client.execute('PRAGMA database_list')).rows.find((row) => row.name === 'main')?.file,
	).toBe('');
	expect((await client.execute('PRAGMA journal_mode')).rows[0]?.journal_mode).toBe('memory');
	expect((await client.execute('PRAGMA temp_store')).rows[0]?.temp_store).toBe(2);
	expect((await client.execute('PRAGMA synchronous')).rows[0]?.synchronous).toBe(2);
	expect((await client.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys).toBe(1);
	expect((await client.execute('PRAGMA busy_timeout')).rows[0]?.timeout).toBe(0);
	const graph = new Graph(client, schema);
	const first = await graph.atomic((scope) =>
		scope.addNode({ type: 'note', data: { path: 'A.md' }, body: 'original' }),
	);
	await graph.atomic((scope) =>
		scope.updateNode(first.id, { body: 'retained orchard' }, { expectedRevision: first.revision }),
	);
	expect((await graph.getNodeVersion(first.id))?.body).toBe('retained orchard');
	expect(await history(client, first.id)).toHaveLength(2);
	expect((await graph.listNodes({ q: 'orchard' })).nodes[0]?.id).toBe(first.id);
	await expect(
		graph.atomic(async (scope) => {
			await scope.addNode({ type: 'note', data: { path: 'rollback.md' }, body: 'temporary' });
			throw new Error('rollback');
		}),
	).rejects.toThrow('rollback');
	expect((await graph.listNodes()).nodes).toHaveLength(1);
});

test('native memory namespaces are isolated and disappear on close', async () => {
	const first = await openMemoryDb();
	cleanup.push(() => first.close());
	await first.execute('CREATE TABLE private_content (body TEXT)');
	await first.execute("INSERT INTO private_content VALUES ('retained until close')");
	const second = await openMemoryDb();
	cleanup.push(() => second.close());
	expect(
		(await second.execute("SELECT name FROM sqlite_master WHERE name='private_content'")).rows,
	).toEqual([]);
	await first.close();
	await expect(first.execute('SELECT * FROM private_content')).rejects.toThrow('closed');
	const reopened = await openMemoryDb();
	cleanup.push(() => reopened.close());
	expect(
		(await reopened.execute("SELECT name FROM sqlite_master WHERE name='private_content'")).rows,
	).toEqual([]);
});

test('native memory rollback releases failed statements and queues unrelated reads', async () => {
	const client = await openMemoryDb();
	cleanup.push(() => client.close());
	await client.execute('CREATE TABLE items (id PRIMARY KEY)');
	await client.execute("INSERT INTO items VALUES ('kept')");
	const tx = await client.transaction();
	await tx.execute("INSERT INTO items VALUES ('rollback')");
	await expect(tx.execute("INSERT INTO items VALUES ('kept')")).rejects.toThrow();
	let completed = false;
	const outside = client.execute('SELECT * FROM items').then((result) => {
		completed = true;
		return result;
	});
	await Promise.resolve();
	expect(completed).toBe(false);
	await tx.rollback();
	expect((await outside).rows).toEqual([{ id: 'kept' }]);
	const next = await client.transaction();
	await next.execute("INSERT INTO items VALUES ('committed')");
	await next.commit();
	expect((await client.execute('SELECT * FROM items ORDER BY id')).rows).toEqual([
		{ id: 'committed' },
		{ id: 'kept' },
	]);
});

test('a failed standalone native memory step closes its owner and rejects queued work', async () => {
	const client = await openMemoryDb();
	cleanup.push(() => client.close());
	await client.execute('CREATE TABLE items (id PRIMARY KEY)');
	await client.execute("INSERT INTO items VALUES ('duplicate')");
	const failed = client.execute("INSERT INTO items VALUES ('duplicate')");
	const queued = client.execute('SELECT * FROM items');
	const results = await Promise.allSettled([failed, queued]);
	expect(results[0].status).toBe('rejected');
	expect(results[1]).toMatchObject({
		status: 'rejected',
		reason: { message: 'SQL connection client is closed' },
	});
});

test('native local opener persists content, history, FTS and native vectors after reopen', async () => {
	const path = filename();
	const embedder = hashEmbed(8);
	const client = await open(path);
	await init(client, embedder);
	expect(client.dialect).toBe('libsql');
	expect(client.busyTimeoutMs).toBe(0);
	expect((await client.execute('PRAGMA busy_timeout')).rows[0]?.timeout).toBe(0);
	expect((await client.execute('PRAGMA journal_mode')).rows[0]?.journal_mode).toBe('wal');
	expect((await client.execute('PRAGMA synchronous')).rows[0]?.synchronous).toBe(2);
	expect((await client.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys).toBe(1);
	const graph = new Graph(client, schema, { embedder });
	const note = await graph.addNode({ type: 'note', data: { path: 'A.md' }, body: 'first orchard' });
	await graph.updateNode(note.id, { body: 'peach harvest' });
	await client.close();
	const reopened = await open(path);
	await init(reopened, embedder);
	const read = new Graph(reopened, schema, { embedder });
	expect((await read.retrieve({ query: 'peach harvest', k: 1 }))[0]?.id).toBe(note.id);
	expect((await read.listNodes({ q: 'harvest' })).nodes[0]?.id).toBe(note.id);
	expect(await history(reopened, note.id)).toHaveLength(2);
	expect(
		(await reopened.execute("SELECT vector_extract(vector('[1,2]')) AS vector")).rows[0]?.vector,
	).toBe('[1,2]');
});

test('native local results preserve safe integers, exact binary lengths, named values and RETURNING metadata', async () => {
	const client = await open();
	await client.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, data BLOB)');
	for (const length of [0, 1, 7, 8193]) {
		const source = new Uint8Array(length + 4).fill(99);
		source.fill(42, 2, length + 2);
		const result = await client.execute({
			sql: 'INSERT INTO items(data) VALUES (?) RETURNING id,data',
			args: [source.subarray(2, length + 2)],
		});
		expect(result.rowsAffected).toBe(1);
		expect(result.lastInsertRowid).toBe(BigInt(result.rows[0]!.id as number));
		expect(new Uint8Array(result.rows[0]!.data as ArrayBuffer)).toEqual(
			new Uint8Array(length).fill(42),
		);
	}
	const named = await client.execute({
		sql: 'SELECT :date AS date, @flag AS flag, $integer AS integer',
		args: { date: new Date(1234), flag: true, integer: 9007199254740991n },
	});
	expect(named.rows).toEqual([{ date: 1234, flag: 1, integer: Number.MAX_SAFE_INTEGER }]);
	const returned = await client.execute(
		'INSERT INTO items(id) VALUES (2147483648),(2147483649) RETURNING id',
	);
	expect(returned.rowsAffected).toBe(2);
	expect(returned.lastInsertRowid).toBe(2147483649n);
});

test('native local driver rejects lossy values and reports native SQL errors', async () => {
	const client = await open();
	for (const value of [
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		9007199254740993n,
		new Date(NaN),
		undefined,
		{},
	]) {
		await expect(
			client.execute({ sql: 'SELECT ?', args: [value] } as SqlStatement),
		).rejects.toThrow();
	}
	await expect(client.execute('SELECT 9223372036854775807 AS unsafe')).rejects.toThrow('safely');
	await expect(client.execute('SELECT * FROM missing_table')).rejects.toThrow('missing_table');
});

test('native local transaction holds the same connection and queues unrelated scripts', async () => {
	const client = await open();
	await client.execute('CREATE TABLE items (id PRIMARY KEY)');
	const tx = await client.transaction();
	await tx.execute("INSERT INTO items VALUES ('inside')");
	let ran = false;
	const outside = client.executeMultiple("INSERT INTO items VALUES ('outside');").then(() => {
		ran = true;
	});
	await Promise.resolve();
	expect(ran).toBe(false);
	await tx.rollback();
	await outside;
	expect((await client.execute('SELECT * FROM items')).rows).toEqual([{ id: 'outside' }]);
	await expect(
		client.batch(["INSERT INTO items VALUES ('batch')", "INSERT INTO items VALUES ('outside')"]),
	).rejects.toThrow();
	expect((await client.execute('SELECT * FROM items')).rows).toEqual([{ id: 'outside' }]);
});

test('failed native BEGIN releases its statement before no-op DDL and a later retry', async () => {
	const path = filename();
	const a = await open(path),
		b = await open(path);
	await a.execute('CREATE TABLE items (id PRIMARY KEY)');
	await b.execute('SELECT * FROM items');
	const writer = await a.transaction();
	await expect(b.transaction()).rejects.toThrow('locked');
	await b.execute('CREATE TABLE IF NOT EXISTS items (id PRIMARY KEY)');
	await expect(b.transaction()).rejects.toThrow('locked');
	await writer.execute({ sql: 'INSERT INTO items VALUES (?)', args: ['committed'] });
	await writer.commit();
	expect((await b.execute('SELECT * FROM items')).rows).toEqual([{ id: 'committed' }]);
	const retry = await b.transaction();
	await retry.execute({ sql: 'INSERT INTO items VALUES (?)', args: ['retry'] });
	await retry.commit();
	expect((await a.execute('SELECT * FROM items ORDER BY id')).rows).toEqual([
		{ id: 'committed' },
		{ id: 'retry' },
	]);
});

test('a failed standalone native step closes its connection instead of retaining a stale snapshot', async () => {
	const path = filename();
	const a = await open(path),
		b = await open(path);
	await a.execute('CREATE TABLE items (id PRIMARY KEY)');
	await b.execute('SELECT * FROM items');
	const writer = await a.transaction();
	const failed = b.execute({ sql: 'INSERT INTO items VALUES (?)', args: ['blocked'] });
	const queued = b.execute('SELECT * FROM items');
	const results = await Promise.allSettled([failed, queued]);
	expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'SQLITE_BUSY' } });
	expect(results[1]).toMatchObject({
		status: 'rejected',
		reason: { message: 'SQL connection client is closed' },
	});
	await writer.execute({ sql: 'INSERT INTO items VALUES (?)', args: ['committed'] });
	await writer.commit();
	await expect(b.execute('SELECT * FROM items')).rejects.toThrow('closed');
	await b.close();
	const reopened = await open(path);
	expect((await reopened.execute('SELECT * FROM items')).rows).toEqual([{ id: 'committed' }]);
});

test('execute keeps native single-statement semantics for unbound SQL', async () => {
	const client = await open();
	await client.execute('CREATE TABLE first (id); CREATE TABLE second (id);');
	expect((await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows).toEqual([
		{ name: 'first' },
	]);
});

test('two native local clients compete for one revision without blocking JavaScript', async () => {
	const path = filename();
	const a = await open(path);
	const b = await open(path);
	await init(a);
	await init(b);
	const ga = new Graph(a, schema);
	const gb = new Graph(b, schema);
	const node = await ga.addNode({ type: 'note', data: { path: 'A.md' }, body: 'before' });
	const version = (await ga.getNodeVersion(node.id))!;
	const calls = [0, 0];
	const started = performance.now();
	const saves = await Promise.allSettled(
		[ga, gb].map((g, i) =>
			g.atomic(async (scope) => {
				calls[i]++;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return scope.updateNode(
					node.id,
					{ body: `save${i}` },
					{ expectedRevision: version.revision },
				);
			}),
		),
	);
	expect(performance.now() - started).toBeLessThan(2000);
	expect(calls).toEqual([1, 1]);
	expect(saves.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
	expect(saves.find((result) => result.status === 'rejected')).toMatchObject({
		reason: { name: 'RevisionConflict' },
	});
	expect(await history(a, node.id)).toHaveLength(2);
});

test('connection pragmas retain their default, honor driver timeout, and reject invalid values', async () => {
	for (const [configured, expected] of [
		[undefined, 5000],
		[0, 0],
		[25, 25],
	] as const) {
		const calls: string[] = [];
		const client = {
			dialect: 'libsql',
			busyTimeoutMs: configured,
			async execute(sql: string) {
				calls.push(sql);
				return { rows: [], rowsAffected: 0 };
			},
		} as unknown as DbClient;
		await applyConnPragmas(client);
		expect(calls).toEqual(['PRAGMA foreign_keys = ON', `PRAGMA busy_timeout = ${expected}`]);
	}
	for (const busyTimeoutMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		const client = {
			dialect: 'libsql',
			busyTimeoutMs,
			async execute() {
				throw new Error('must validate before SQL');
			},
		} as unknown as DbClient;
		await expect(applyConnPragmas(client)).rejects.toThrow('busyTimeoutMs');
	}
});

test('native local opener rejects relative, memory, URI and unavailable paths without fallback', async () => {
	for (const path of ['', ':memory:', 'relative.db', 'file:/tmp/vault.db', '/tmp/invalid\0.db']) {
		await expect(openLocalDb(path)).rejects.toThrow();
	}
	await expect(openLocalDb(join(filename(), 'missing', 'vault.db'))).rejects.toThrow();
});
