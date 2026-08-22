import { describe, expect, test } from 'bun:test';
import { FOREVER } from '../src/db.ts';
import { ftsSeedAsOf, ftsSeedLive, ftsWhere } from '../src/dialect-sql.ts';
import { createDuckClient, type DuckClient } from '../src/duck.ts';
import { duckdbSchema } from '../src/dialect-sql.ts';
import { rebuildIndex } from '../src/fts/index-tables.ts';
import { tokenize } from '../src/fts/tokenize.ts';

const terms = (q: string): string => JSON.stringify(tokenize(q));

/** Two live nodes and one superseded version, indexed. */
async function seeded(): Promise<DuckClient> {
	const c = createDuckClient();
	await c.executeMultiple(duckdbSchema(4));
	for (const id of ['a', 'b']) {
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: [id] });
	}
	const rows: [number, string, string, number, number][] = [
		[1, 'a', 'temporal graph database', 0, 100], // superseded at t=100
		[2, 'a', 'rewritten beyond recognition', 100, FOREVER],
		[3, 'b', 'vector search engine', 0, FOREVER],
	];
	for (const [ver, id, body, from, to] of rows) {
		await c.execute({
			sql: `INSERT INTO node_versions (ver, id, type, body, valid_from, valid_to)
            VALUES (?,?,?,?,?,?)`,
			args: [ver, id, 'Doc', body, from, to],
		});
	}
	await rebuildIndex(c);
	return c;
}

describe('duckdb fts fragments', () => {
	test('ftsSeedLive returns live ids best-first', async () => {
		const c = await seeded();
		const r = await c.execute({ sql: ftsSeedLive('duckdb'), args: [terms('vector search'), 10] });
		expect(r.rows.map((row) => String(row.id))).toEqual(['b']);
		await c.end();
	});

	test('ftsSeedLive does not match a superseded body', async () => {
		// ver 1 says 'temporal graph database' but is closed; live search must not see it.
		const c = await seeded();
		const r = await c.execute({ sql: ftsSeedLive('duckdb'), args: [terms('temporal'), 10] });
		expect(r.rows).toEqual([]);
		await c.end();
	});

	test('ftsSeedLive honors k', async () => {
		const c = await seeded();
		const r = await c.execute({ sql: ftsSeedLive('duckdb'), args: [terms('rewritten vector'), 1] });
		expect(r.rows.length).toBe(1);
		await c.end();
	});

	test('ftsSeedAsOf matches the version live at t — the exactness ANN cannot give', async () => {
		const c = await seeded();
		const r = await c.execute({
			sql: ftsSeedAsOf('duckdb'),
			args: [terms('temporal'), 50, 50, 10],
		});
		expect(r.rows.map((row) => String(row.id))).toEqual(['a']);
		await c.end();
	});

	test('ftsSeedAsOf does not match a version that had not been written yet', async () => {
		const c = await seeded();
		const r = await c.execute({
			sql: ftsSeedAsOf('duckdb'),
			args: [terms('rewritten'), 50, 50, 10],
		});
		expect(r.rows).toEqual([]);
		await c.end();
	});

	test('ftsWhere filters a node_versions scan', async () => {
		const c = await seeded();
		const r = await c.execute({
			sql: `SELECT nv.id FROM node_versions nv
            WHERE nv.valid_to = ${FOREVER} AND ${ftsWhere('duckdb', 'nv')}`,
			args: [terms('vector')],
		});
		expect(r.rows.map((row) => String(row.id))).toEqual(['b']);
		await c.end();
	});

	test('every fragment binds the same number of args as the libsql arm', () => {
		// The callers bind positionally from one code path shared with libSQL and Postgres.
		const count = (sql: string): number => (sql.match(/\?/g) ?? []).length;
		expect(count(ftsWhere('duckdb', 'nv'))).toBe(count(ftsWhere('libsql', 'nv')));
		expect(count(ftsSeedLive('duckdb'))).toBe(count(ftsSeedLive('libsql')));
		expect(count(ftsSeedAsOf('duckdb'))).toBe(count(ftsSeedAsOf('libsql')));
	});
});
