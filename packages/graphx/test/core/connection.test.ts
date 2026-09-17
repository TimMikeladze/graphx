import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createConnectionClient, type SqlConnection } from '../../src/core/connection.ts';
import type { SqlStatement, SqlValue } from '../../src/core/dialect.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Low-level ordinary SQLite conformance fixture; this is not a Graphx Bun driver.
function fixture(before?: (sql: string) => Promise<void> | void, beforeClose?: () => void) {
	const db = new Database(':memory:');
	let physicalClosed = false;
	const didClose = deferred();
	cleanups.push(() => {
		if (!physicalClosed) db.close();
	});
	const bind = (value: SqlValue): SQLQueryBindings => {
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		if (value instanceof Date) return value.toISOString();
		if (typeof value === 'boolean') return Number(value);
		return value;
	};
	const connection: SqlConnection = {
		async execute(stmt) {
			const sql = typeof stmt === 'string' ? stmt : stmt.sql;
			await before?.(sql);
			const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
			const query = db.query(sql);
			const bindings = Array.isArray(args)
				? args.map(bind)
				: [Object.fromEntries(Object.entries(args).map(([key, value]) => [key, bind(value)]))];
			const rows = query.all(...bindings) as Record<string, unknown>[];
			const metadata = db.query('SELECT changes() AS changes, last_insert_rowid() AS id').get() as {
				changes: number;
				id: number;
			};
			return {
				rows,
				rowsAffected: metadata.changes,
				lastInsertRowid: BigInt(metadata.id),
				columns: query.columnNames,
			};
		},
		async executeMultiple(sql) {
			await before?.(sql);
			db.exec(sql);
		},
		close() {
			beforeClose?.();
			db.close();
			physicalClosed = true;
			didClose.resolve();
		},
	};
	// Only SQL connection semantics use this tag; no libSQL vector/graph SQL is tested.
	const client = createConnectionClient(connection, 'libsql');
	return {
		client,
		db,
		didClose,
		get physicalClosed() {
			return physicalClosed;
		},
	};
}

const insert = (id: number, name = `item ${id}`): SqlStatement => ({
	sql: 'INSERT INTO items (id, name) VALUES (?, ?)',
	args: [id, name],
});
async function setup(before?: (sql: string) => Promise<void> | void) {
	const f = fixture(before);
	await f.client.executeMultiple(
		'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, body BLOB);',
	);
	return f;
}

describe('exclusive SQL connection owner', () => {
	test('round trips positional/named bindings and binary values', async () => {
		const { client } = await setup();
		const result = await client.execute({
			sql: 'INSERT INTO items VALUES (?, ?, ?)',
			args: [1, 'hello', new Uint8Array([0, 128, 255])],
		});
		expect(result.rowsAffected).toBe(1);
		expect(result.lastInsertRowid).toBe(1n);
		const rows = await client.execute({
			sql: 'SELECT name, body FROM items WHERE id = :id',
			args: { ':id': 1 },
		});
		expect(rows.rows).toEqual([{ name: 'hello', body: new Uint8Array([0, 128, 255]) }]);
	});
});

async function ids(client: {
	execute(stmt: SqlStatement): Promise<{ rows: Record<string, unknown>[] }>;
}) {
	return (await client.execute('SELECT id FROM items ORDER BY rowid')).rows;
}

describe('leases and transactions', () => {
	test('holds outside statements until rollback and serves leases FIFO', async () => {
		const { client } = await setup();
		const tx = await client.transaction('write');
		await tx.execute(insert(1));
		const second = client.execute(insert(2));
		const third = client.executeMultiple(
			'INSERT INTO items SELECT 3, name, body FROM items WHERE id = 2',
		);
		const fourth = client.transaction();
		await tx.rollback();
		await second;
		await third;
		const next = await fourth;
		expect((await next.execute('SELECT id FROM items')).rows).toEqual([{ id: 2 }, { id: 3 }]);
		await next.rollback();
		expect(await ids(client)).toEqual([{ id: 2 }, { id: 3 }]);
	});

	test('serializes standalone calls including executeMultiple', async () => {
		const entered = deferred();
		const resume = deferred();
		const { client } = await setup(async (sql) => {
			if (sql === "INSERT INTO items VALUES (1, 'first', NULL)") {
				entered.resolve();
				await resume.promise;
			}
		});
		const first = client.executeMultiple("INSERT INTO items VALUES (1, 'first', NULL)");
		await entered.promise;
		const second = client.execute('INSERT INTO items SELECT 2, name, body FROM items WHERE id = 1');
		resume.resolve();
		await Promise.all([first, second]);
		expect(await ids(client)).toEqual([{ id: 1 }, { id: 2 }]);
	});

	test('commit closes the handle immediately and waits for queued statements', async () => {
		const entered = deferred();
		const resume = deferred();
		const { client } = await setup(async (sql) => {
			if (sql === "INSERT INTO items VALUES (1, 'first', NULL)") {
				entered.resolve();
				await resume.promise;
			}
		});
		const tx = await client.transaction();
		const first = tx.execute("INSERT INTO items VALUES (1, 'first', NULL)");
		await entered.promise;
		const second = tx.execute('INSERT INTO items SELECT 2, name, body FROM items WHERE id = 1');
		const commit = tx.commit();
		expect(tx.closed).toBe(true);
		await expect(tx.execute(insert(3))).rejects.toThrow();
		resume.resolve();
		await Promise.all([first, second, commit]);
		expect(await ids(client)).toEqual([{ id: 1 }, { id: 2 }]);
		await expect(tx.commit()).rejects.toThrow();
		await tx.rollback();
	});

	test('a failed statement aborts queued statements and prevents partial commit', async () => {
		const { client } = await setup();
		const tx = await client.transaction();
		await tx.execute(insert(1));
		const failed = tx.execute(insert(1));
		const queued = tx.execute(insert(2));
		const committed = tx.commit();
		const outcomes = await Promise.allSettled([failed, queued, committed]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected']);
		expect(await ids(client)).toEqual([]);
	});

	test('batch commits all results and rolls back the entire batch on failure', async () => {
		const { client } = await setup();
		const result = await client.batch([insert(1), insert(2)]);
		expect(result.map((row) => row.rowsAffected)).toEqual([1, 1]);
		await expect(client.batch([insert(3), insert(1), insert(4)])).rejects.toThrow();
		expect(await ids(client)).toEqual([{ id: 1 }, { id: 2 }]);
		expect(await client.batch([])).toEqual([]);
	});

	test.each(['read', 'write', 'deferred'] as const)(
		'%s transaction rolls back idempotently',
		async (mode) => {
			const { client } = await setup();
			const tx = await client.transaction(mode);
			await tx.execute(insert(1));
			await Promise.all([tx.rollback(), tx.rollback()]);
			await tx.rollback();
			expect(tx.closed).toBe(true);
			expect(await ids(client)).toEqual([]);
		},
	);
});

describe('connection failures and shutdown', () => {
	test('failed BEGIN releases the lease for a queued statement', async () => {
		let fail = true;
		const { client } = await setup((sql) => {
			if (sql.startsWith('BEGIN') && fail) {
				fail = false;
				throw new Error('begin failed');
			}
		});
		const tx = client.transaction();
		const outside = client.execute(insert(1));
		await expect(tx).rejects.toThrow('begin failed');
		await outside;
		expect(await ids(client)).toEqual([{ id: 1 }]);
	});

	test('failed COMMIT rolls back before releasing the connection', async () => {
		const { client } = await setup((sql) => {
			if (sql === 'COMMIT') throw new Error('commit failed');
		});
		const tx = await client.transaction();
		await tx.execute(insert(1));
		const outside = client.execute(insert(2));
		await expect(tx.commit()).rejects.toThrow('commit failed');
		await outside;
		expect(await ids(client)).toEqual([{ id: 2 }]);
	});

	test('failed ROLLBACK rejects queued/new work instead of leaking the transaction', async () => {
		const { client } = await setup((sql) => {
			if (sql === 'ROLLBACK') throw new Error('rollback failed');
		});
		const tx = await client.transaction();
		await tx.execute(insert(1));
		const outside = client.execute(insert(2));
		const outcomes = await Promise.allSettled([tx.rollback(), outside]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
		await expect(client.execute(insert(3))).rejects.toThrow();
		await expect(client.transaction()).rejects.toThrow();
	});

	test('close rejects pending work, waits for a running statement, and is awaitable/idempotent', async () => {
		const entered = deferred();
		const resume = deferred();
		const f = await setup(async (sql) => {
			if (sql.startsWith('INSERT')) {
				entered.resolve();
				await resume.promise;
			}
		});
		const running = f.client.execute(insert(1));
		await entered.promise;
		const pending = f.client.execute(insert(2));
		const closing = f.client.close();
		expect(f.physicalClosed).toBe(false);
		await expect(pending).rejects.toThrow();
		await expect(f.client.execute('SELECT 1')).rejects.toThrow();
		await expect(f.client.executeMultiple('SELECT 1')).rejects.toThrow();
		await expect(f.client.batch([])).rejects.toThrow();
		await expect(f.client.transaction()).rejects.toThrow();
		resume.resolve();
		await running;
		await closing;
		expect(f.physicalClosed).toBe(true);
		await f.client.close();
	});

	test('close automatically rolls back an abandoned active transaction', async () => {
		const f = await setup();
		const tx = await f.client.transaction();
		await tx.execute(insert(1));
		await f.client.close();
		expect(tx.closed).toBe(true);
		expect(f.physicalClosed).toBe(true);
		await tx.rollback();
		await expect(tx.commit()).rejects.toThrow();
	});

	test('close during BEGIN rolls back and rejects the undelivered transaction', async () => {
		const entered = deferred();
		const resume = deferred();
		const f = await setup(async (sql) => {
			if (sql.startsWith('BEGIN')) {
				entered.resolve();
				await resume.promise;
			}
		});
		const opening = f.client.transaction();
		await entered.promise;
		const closing = f.client.close();
		resume.resolve();
		await expect(opening).rejects.toThrow();
		await closing;
		expect(f.physicalClosed).toBe(true);
	});

	test('close still releases physical connection if automatic rollback fails', async () => {
		const f = await setup((sql) => {
			if (sql === 'ROLLBACK') throw new Error('rollback failed');
		});
		const tx = await f.client.transaction();
		await tx.execute(insert(1));
		await expect(f.client.close()).rejects.toThrow();
		expect(f.physicalClosed).toBe(true);
	});

	test('idle close reports a physical close failure to explicit awaiters', async () => {
		const { client } = fixture(undefined, () => {
			throw new Error('close failed');
		});
		await expect(client.close()).rejects.toThrow('close failed');
		await expect(client.close()).rejects.toThrow('close failed');
	});
});

describe('shutdown races', () => {
	test('close finishes a running transaction statement, rejects queued statements, then rolls back', async () => {
		const entered = deferred();
		const resume = deferred();
		let closingRows: unknown;
		const f = fixture(
			async (sql) => {
				if (sql.startsWith('INSERT')) {
					entered.resolve();
					await resume.promise;
				}
			},
			() => {
				closingRows = f.db.query('SELECT id FROM items').all();
			},
		);
		await f.client.executeMultiple('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
		const tx = await f.client.transaction();
		const first = tx.execute(insert(1));
		await entered.promise;
		const queued = tx.execute(insert(2));
		const closing = f.client.close();
		expect(tx.closed).toBe(true);
		expect(f.physicalClosed).toBe(false);
		const outcomes = Promise.allSettled([first, queued]);
		resume.resolve();
		expect((await outcomes).map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
		await closing;
		expect(closingRows).toEqual([]);
	});

	test('close cancels a queued commit and never acknowledges a rolled-back mutation', async () => {
		const entered = deferred();
		const resume = deferred();
		let closingRows: unknown;
		const f = fixture(
			async (sql) => {
				if (sql.startsWith('INSERT')) {
					entered.resolve();
					await resume.promise;
				}
			},
			() => {
				closingRows = f.db.query('SELECT id FROM items').all();
			},
		);
		await f.client.executeMultiple('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
		const tx = await f.client.transaction();
		const first = tx.execute(insert(1));
		await entered.promise;
		const commit = tx.commit();
		const closing = f.client.close();
		resume.resolve();
		await first;
		await expect(commit).rejects.toThrow();
		await closing;
		expect(closingRows).toEqual([]);
	});

	test('close waits for a COMMIT already in progress and preserves its successful result', async () => {
		const entered = deferred();
		const resume = deferred();
		let closingRows: unknown;
		const f = fixture(
			async (sql) => {
				if (sql === 'COMMIT') {
					entered.resolve();
					await resume.promise;
				}
			},
			() => {
				closingRows = f.db.query('SELECT id FROM items').all();
			},
		);
		await f.client.executeMultiple('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
		const tx = await f.client.transaction();
		await tx.execute(insert(1));
		const commit = tx.commit();
		await entered.promise;
		const closing = f.client.close();
		resume.resolve();
		await commit;
		await closing;
		expect(closingRows).toEqual([{ id: 1 }]);
	});
});
