import { describe, expect, test } from 'bun:test';
import { createDuckClient, splitStatements } from '../src/duck.ts';
import { embParam, normalizeRow } from '../src/duck-value.ts';

describe('duck value marshalling', () => {
	test('bigint columns come back as numbers', () => {
		expect(normalizeRow({ ver: 42n, id: 'x' })).toEqual({ ver: 42, id: 'x' });
	});

	test('a bigint beyond Number.MAX_SAFE_INTEGER is preserved as bigint', () => {
		const big = 9007199254740993n;
		expect(normalizeRow({ n: big }).n).toBe(big);
	});

	test('the FOREVER sentinel survives normalization as a number', () => {
		expect(normalizeRow({ valid_to: 8640000000000000n }).valid_to).toBe(8640000000000000);
	});

	test('embParam produces a JSON array string', () => {
		expect(embParam([1, 0.5, 0.25])).toBe('[1,0.5,0.25]');
	});
});

describe('DuckClient', () => {
	test('execute returns rows and rowsAffected', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER, v TEXT)');
		const ins = await c.execute({ sql: 'INSERT INTO t VALUES (?, ?)', args: [1, 'a'] });
		expect(ins.rowsAffected).toBe(1);
		const sel = await c.execute('SELECT id, v FROM t');
		expect(sel.rows).toEqual([{ id: 1, v: 'a' }]);
		await c.end();
	});

	test('batch is atomic — a failing statement rolls the whole batch back', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)');
		await expect(
			c.batch(
				[
					{ sql: 'INSERT INTO t VALUES (?)', args: [1] },
					{ sql: 'INSERT INTO t VALUES (?)', args: [1] },
				],
				'write',
			),
		).rejects.toThrow();
		expect((await c.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('an interactive transaction commits', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER)');
		const tx = await c.transaction('write');
		await tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [7] });
		await tx.commit();
		expect(tx.closed).toBe(true);
		expect((await c.execute('SELECT id FROM t')).rows).toEqual([{ id: 7 }]);
		await c.end();
	});

	test('commit on an aborted transaction throws instead of silently discarding', async () => {
		// DuckDB's COMMIT resolves successfully on an aborted transaction and drops the
		// writes. An adapter that reported that as durable would lie to its caller.
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER PRIMARY KEY)');
		const tx = await c.transaction('write');
		await tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [1] });
		await expect(tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [1] })).rejects.toThrow();
		await expect(tx.commit()).rejects.toThrow(/aborted/i);
		expect((await c.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('rowsAffected drives a conditional-close compare-and-swap', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE v(id TEXT, valid_to BIGINT)');
		await c.execute({ sql: 'INSERT INTO v VALUES (?, ?)', args: ['a', 8640000000000000] });
		const won = await c.execute({
			sql: 'UPDATE v SET valid_to = ? WHERE id = ? AND valid_to = ?',
			args: [100, 'a', 8640000000000000],
		});
		expect(won.rowsAffected).toBe(1);
		const lost = await c.execute({
			sql: 'UPDATE v SET valid_to = ? WHERE id = ? AND valid_to = ?',
			args: [200, 'a', 8640000000000000],
		});
		expect(lost.rowsAffected).toBe(0);
		await c.end();
	});

	test('executeMultiple runs every statement of a DDL script', async () => {
		const c = createDuckClient();
		await c.executeMultiple(`
			CREATE TABLE a(id INTEGER);
			CREATE TABLE b(id INTEGER);
			INSERT INTO a VALUES (1);
		`);
		expect((await c.execute('SELECT count(*) AS n FROM a')).rows[0]?.n).toBe(1);
		expect((await c.execute('SELECT count(*) AS n FROM b')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('an embedding round-trips bit-exactly through the JSON binding', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE e(id TEXT, emb FLOAT[])');
		const vec = [1 / 3, 1e-8, -2.5e-30, 0.1];
		await c.execute({
			sql: `INSERT INTO e VALUES (?, from_json(?, '["FLOAT"]'))`,
			args: ['x', embParam(vec)],
		});
		const r = await c.execute('SELECT to_json(emb) AS j FROM e');
		const back = JSON.parse(String(r.rows[0]?.j)) as number[];
		expect(back.map(Math.fround)).toEqual(vec.map(Math.fround));
		await c.end();
	});

	test('splitStatements respects literals and comments', () => {
		// Each of these would silently corrupt schema DDL if mis-split: a dropped
		// statement, a merged one, or a literal cut in half.
		expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
		expect(splitStatements("SELECT ';' AS a; SELECT 2")).toEqual(["SELECT ';' AS a", 'SELECT 2']);
		expect(splitStatements("SELECT 'a''b;c' AS a")).toEqual(["SELECT 'a''b;c' AS a"]);
		expect(splitStatements('SELECT 1; -- trailing; comment\nSELECT 2')).toEqual([
			'SELECT 1',
			'SELECT 2',
		]);
		expect(splitStatements('-- lone; comment\nSELECT 1')).toEqual(['SELECT 1']);
		expect(splitStatements('SELECT 1; /* block; comment */ SELECT 2')).toEqual([
			'SELECT 1',
			'SELECT 2',
		]);
		expect(splitStatements('  ;; \n')).toEqual([]);
		expect(splitStatements('')).toEqual([]);
	});

	test('rollback discards the writes and closes the transaction', async () => {
		const c = createDuckClient();
		await c.execute('CREATE TABLE t(id INTEGER)');
		const tx = await c.transaction('write');
		await tx.execute({ sql: 'INSERT INTO t VALUES (?)', args: [1] });
		await tx.rollback();
		expect(tx.closed).toBe(true);
		expect((await c.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('executeMultiple runs a script whose comments contain semicolons', async () => {
		// The schema DDL this splits is full of comments; a semicolon in one must not
		// truncate the script.
		const c = createDuckClient();
		await c.executeMultiple(`
			-- first; with a semicolon in the comment
			CREATE TABLE a(id INTEGER);
			/* and a block; comment */
			CREATE TABLE b(id INTEGER);
		`);
		expect((await c.execute('SELECT count(*) AS n FROM a')).rows[0]?.n).toBe(0);
		expect((await c.execute('SELECT count(*) AS n FROM b')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('the dialect tag is duckdb', () => {
		const c = createDuckClient();
		expect(c.dialect).toBe('duckdb');
		void c.end();
	});
});
