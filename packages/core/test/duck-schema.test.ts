import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { init, readEmbDim } from '../src/schema.ts';

const FOREVER = 8640000000000000;

describe('duckdbSchema', () => {
	test('init creates the split tables and their compatibility views', async () => {
		const c = createDuckClient();
		await init(c, 4);
		const r = await c.execute(
			`SELECT table_name FROM duckdb_tables() UNION ALL SELECT view_name FROM duckdb_views()
			 WHERE view_name IN ('node_versions','edge_versions','nodes','edges')`,
		);
		const names = r.rows.map((x) => String(x.table_name ?? x.view_name));
		for (const t of ['nv_live', 'nv_history', 'ev_live', 'ev_history']) {
			expect(names).toContain(t);
		}
		await c.end();
	});

	test('init is idempotent', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await init(c, 4);
		await c.end();
	});

	test('node_versions unions live and history', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 10, FOREVER],
		});
		await c.execute({
			sql: `INSERT INTO nv_history (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [2, 'n1', 'Doc', 1, 10],
		});
		expect((await c.execute('SELECT count(*) AS n FROM node_versions')).rows[0]?.n).toBe(2);
		expect((await c.execute('SELECT count(*) AS n FROM nodes')).rows[0]?.n).toBe(1);
		await c.end();
	});

	test('the live table enforces one row per id without a partial index', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 10, FOREVER],
		});
		await expect(
			c.execute({
				sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
				args: [2, 'n1', 'Doc', 20, FOREVER],
			}),
		).rejects.toThrow();
		await c.end();
	});

	test('readEmbDim reads the declared width back', async () => {
		const c = createDuckClient();
		await init(c, 384);
		expect(await readEmbDim(c)).toBe(384);
		await c.end();
	});

	test('init rejects a conflicting dimension', async () => {
		const c = createDuckClient();
		await init(c, 384);
		await expect(init(c, 768)).rejects.toThrow(/immutable/);
		await c.end();
	});

	test('temporal columns hold the FOREVER sentinel without overflow', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 1, FOREVER],
		});
		expect((await c.execute('SELECT valid_to FROM nv_live')).rows[0]?.valid_to).toBe(FOREVER);
		await c.end();
	});
});
