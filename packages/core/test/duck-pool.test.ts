import { describe, expect, test } from 'bun:test';
import { DuckPool, isFatalInstanceError } from '../src/duck-pool.ts';

describe('DuckPool', () => {
	test('runs a query and reports column names', async () => {
		const pool = new DuckPool(':memory:');
		const r = await pool.withConnection((c) => c.run('SELECT 1 AS a, 2 AS b'));
		expect(r.rows).toEqual([{ a: 1, b: 2 }]);
		expect(r.columnNames).toEqual(['a', 'b']);
		await pool.close();
	});

	test('binds positional parameters', async () => {
		const pool = new DuckPool(':memory:');
		const r = await pool.withConnection((c) => c.run('SELECT $1::VARCHAR AS v', ['x']));
		expect(r.rows).toEqual([{ v: 'x' }]);
		await pool.close();
	});

	test('reports rowsChanged for DML', async () => {
		const pool = new DuckPool(':memory:');
		await pool.withConnection(async (c) => {
			await c.run('CREATE TABLE t(id INTEGER, v INTEGER)');
			await c.run('INSERT INTO t VALUES (1,1),(2,2),(3,3)');
			expect((await c.run('UPDATE t SET v = 9 WHERE id <= 2')).rowsChanged).toBe(2);
			expect((await c.run('UPDATE t SET v = 9 WHERE id = 99')).rowsChanged).toBe(0);
		});
		await pool.close();
	});

	test('two concurrent transactions do not merge', async () => {
		// The landmine: one connection is serialized but shared, so interleaving tasks
		// silently join transactions. The pool must hand each task its own connection.
		const pool = new DuckPool(':memory:', { max: 4 });
		await pool.withConnection((c) => c.run('CREATE TABLE t(v INTEGER)'));

		const taskA = pool.withConnection(async (c) => {
			await c.run('BEGIN');
			await c.run('INSERT INTO t VALUES (1)');
			await new Promise((r) => setTimeout(r, 20));
			await c.run('ROLLBACK');
		});
		const taskB = (async () => {
			await new Promise((r) => setTimeout(r, 5));
			await pool.withConnection((c) => c.run('INSERT INTO t VALUES (99)'));
		})();
		await Promise.all([taskA, taskB]);

		const r = await pool.withConnection((c) => c.run('SELECT v FROM t'));
		expect(r.rows).toEqual([{ v: 99 }]);
		await pool.close();
	});

	test('acquire beyond max waits for a release rather than opening more', async () => {
		const pool = new DuckPool(':memory:', { max: 1 });
		const first = await pool.acquire();
		let secondReady = false;
		const second = pool.acquire().then((c) => {
			secondReady = true;
			return c;
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(secondReady).toBe(false);
		first.release();
		(await second).release();
		expect(secondReady).toBe(true);
		await pool.close();
	});

	test('close settles callers parked in the queue instead of hanging them', async () => {
		const pool = new DuckPool(':memory:', { max: 1 });
		const held = await pool.acquire();
		const parked = pool.acquire();
		await new Promise((r) => setTimeout(r, 10));
		await pool.close();
		// Must settle one way or the other. Before this fix the promise never resolved.
		await expect(parked).rejects.toThrow(/closed/);
		held.release();
	});

	test('a connection from a superseded generation is discarded, not pooled', async () => {
		const pool = new DuckPool(':memory:', { max: 1 });
		const c = await pool.acquire();
		// Simulate the FATAL path: the instance is replaced while this caller holds a
		// connection from the old generation.
		(pool as unknown as { rebuild(): void }).rebuild();
		c.release();
		// The corpse must not be handed to the next caller, and must not count toward max.
		expect((pool as unknown as { idle: unknown[] }).idle).toHaveLength(0);
		const fresh = await pool.acquire();
		expect((await fresh.run('SELECT 1 AS a')).rows).toEqual([{ a: 1 }]);
		fresh.release();
		await pool.close();
	});

	test('a freed slot reaches a waiter even with others queued behind it', async () => {
		// The slot-freeing paths — a stale-generation discard and a failed connect() —
		// wake a waiter without pushing anything to `idle`. With more than one caller
		// queued, a resumed waiter that deferred to the queue behind it would re-park and
		// nobody would ever create: every caller hanging while `open < max`. One queued
		// waiter is not enough to catch this; two are.
		const pool = new DuckPool(':memory:', { max: 1 });
		const held = await pool.acquire();
		const first = pool.acquire();
		const second = pool.acquire();
		await new Promise((r) => setTimeout(r, 10));

		// Simulate the FATAL path, then hand the corpse back: the slot frees with no
		// connection pooled.
		(pool as unknown as { rebuild(): void }).rebuild();
		held.release();

		const a = await first;
		expect((await a.run('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
		a.release();
		const b = await second;
		expect((await b.run('SELECT 2 AS n')).rows).toEqual([{ n: 2 }]);
		b.release();
		await pool.close();
	});

	test('isFatalInstanceError recognizes an invalidated database', () => {
		expect(isFatalInstanceError(new Error('FATAL Error: database has been invalidated'))).toBe(
			true,
		);
		expect(isFatalInstanceError(new Error('Constraint Error: duplicate key'))).toBe(false);
	});
});
