import { createClient } from '@libsql/client';
import { describe, expect, test } from 'bun:test';
import { createDuckClient } from '../../src/core/duck.ts';
import { init, readEmbeddingMeta } from '../../src/core/schema.ts';
import { hashEmbed } from '../../src/core/embedder.ts';

const FOREVER = 8640000000000000;

describe('duckdbSchema', () => {
	test('init creates the version tables and their views', async () => {
		const c = createDuckClient();
		await init(c, hashEmbed(4));
		const r = await c.execute('SELECT table_name FROM duckdb_tables()');
		const names = r.rows.map((x) => String(x.table_name));
		for (const t of ['node_versions', 'edge_versions', 'node_identity', 'graph_outbox']) {
			expect(names).toContain(t);
		}
		await c.end();
	});

	test('init is idempotent', async () => {
		const c = createDuckClient();
		await init(c, hashEmbed(4));
		await init(c, hashEmbed(4));
		await c.end();
	});

	test('nodes shows only the live version, node_versions shows every one', async () => {
		const c = createDuckClient();
		await init(c, hashEmbed(4));
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO node_versions (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 10, FOREVER],
		});
		await c.execute({
			sql: `INSERT INTO node_versions (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [2, 'n1', 'Doc', 1, 10],
		});
		expect((await c.execute('SELECT count(*) AS n FROM node_versions')).rows[0]?.n).toBe(2);
		expect((await c.execute('SELECT count(*) AS n FROM nodes')).rows[0]?.n).toBe(1);
		await c.end();
	});

	test('two live rows for one id are NOT rejected by the store — the writer must prevent them', async () => {
		// On libSQL and Postgres a partial unique index makes this impossible. DuckDB has
		// no partial indexes, so the invariant is upheld by the serialized writer (Task 16)
		// and application-level checks (Task 12) instead. This test pins that the store
		// gives no backstop, so nobody later mistakes silence for enforcement.
		const c = createDuckClient();
		await init(c, hashEmbed(4));
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		for (const ver of [1, 2]) {
			await c.execute({
				sql: `INSERT INTO node_versions (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
				args: [ver, 'n1', 'Doc', ver * 10, FOREVER],
			});
		}
		expect((await c.execute('SELECT count(*) AS n FROM nodes')).rows[0]?.n).toBe(2);
		await c.end();
	});

	test('the views expose exactly the columns libSQL exposes', async () => {
		// Every query in the codebase reads these four. A column missing, renamed, or
		// reordered would break them on this backend only, silently — and no other test
		// here would notice, because they all query the schema they just created rather
		// than comparing it against the reference. Comparing the two live backends keeps
		// this self-maintaining: it fails if EITHER schema drifts.
		const duck = createDuckClient();
		await init(duck, hashEmbed(4));
		const lib = createClient({ url: ':memory:' });
		await init(lib, hashEmbed(4));
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
		await init(c, hashEmbed(4));
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO node_versions (id, type, valid_from) VALUES (?, ?, ?)`,
			args: ['n1', 'Doc', 1],
		});
		const r = await c.execute('SELECT ver FROM node_versions');
		expect(Number(r.rows[0]?.ver)).toBeGreaterThan(0);
		await c.end();
	});

	test('readEmbeddingMeta reads the recorded model and width back', async () => {
		const c = createDuckClient();
		await init(c, hashEmbed(384));
		expect(await readEmbeddingMeta(c)).toEqual({ model: 'hash:384', dim: 384 });
		await c.end();
	});

	test('init rejects a different embedder', async () => {
		const c = createDuckClient();
		await init(c, hashEmbed(384));
		await expect(init(c, hashEmbed(768))).rejects.toThrow(/embedded with 'hash:384'/);
		await c.end();
	});

	test('temporal columns hold the FOREVER sentinel without overflow', async () => {
		const c = createDuckClient();
		await init(c, hashEmbed(4));
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO node_versions (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 1, FOREVER],
		});
		expect((await c.execute('SELECT valid_to FROM node_versions')).rows[0]?.valid_to).toBe(FOREVER);
		await c.end();
	});
});
