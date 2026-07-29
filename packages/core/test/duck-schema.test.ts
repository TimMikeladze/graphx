import { createClient } from '@libsql/client';
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

	test('the views expose exactly the columns libSQL exposes', async () => {
		// Every query in the codebase reads these four. A column missing, renamed, or
		// reordered would break them on this backend only, silently — and no other test
		// here would notice, because they all query the schema they just created rather
		// than comparing it against the reference. Comparing the two live backends keeps
		// this self-maintaining: it fails if EITHER schema drifts.
		const duck = createDuckClient();
		await init(duck, 4);
		const lib = createClient({ url: ':memory:' });
		await init(lib, 4);
		for (const view of ['nodes', 'edges', 'node_versions', 'edge_versions']) {
			const d = await duck.execute(`SELECT * FROM ${view} LIMIT 0`);
			const l = await lib.execute(`SELECT * FROM ${view} LIMIT 0`);
			expect(d.columns).toEqual(l.columns);
		}
		lib.close();
		await duck.end();
	});

	test('ver auto-populates from the sequence when a caller omits it', async () => {
		const c = createDuckClient();
		await init(c, 4);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO nv_live (id, type, valid_from) VALUES (?, ?, ?)`,
			args: ['n1', 'Doc', 1],
		});
		const r = await c.execute('SELECT ver FROM nv_live');
		expect(Number(r.rows[0]?.ver)).toBeGreaterThan(0);
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
