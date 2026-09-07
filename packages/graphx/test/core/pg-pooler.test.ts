import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { createPgClient } from '../../src/core/pg.ts';
import { init } from '../../src/core/schema.ts';
import { TEST_DRIVER } from './harness.ts';

/**
 * Pooled mode: the tenant `search_path` is applied with `SET LOCAL` inside every statement's
 * transaction rather than as a connect-time option — the only form that survives a transaction
 * pooler. Exercised here against plain Postgres by forcing the mode, which proves each code path
 * (execute, batch, interactive transaction, DDL script) resolves the tenant schema; the sandbox
 * behind PgBouncer is where `'auto'` gets its real detection test.
 */
const pgOnly = TEST_DRIVER === 'postgres' ? test : test.skip;
const PG_URL =
	process.env.GRAPHX_TEST_PG_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5455/graphx_test';

pgOnly('pg: pooled mode resolves the tenant schema on every path', async () => {
	const schema = `pool_${ulid().toLowerCase()}`;
	const c = createPgClient({
		connectionString: PG_URL,
		schema,
		ensureSchema: true,
		ensureExtension: true,
		pooler: 'transaction',
	});
	try {
		await init(c); // executeMultiple: DDL lands in the tenant schema, not public
		const where = await c.execute(
			`SELECT table_schema AS s FROM information_schema.tables WHERE table_name = 'node_versions' AND table_schema = '${schema}'`,
		);
		expect(where.rows.length).toBe(1);

		await c.batch([{ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: ['a'] }], 'write');
		const tx = await c.transaction('write');
		await tx.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: ['b'] });
		await tx.commit();
		const n = await c.execute('SELECT count(*) AS n FROM node_identity');
		expect(Number(n.rows[0]?.n)).toBe(2);
		// The public schema saw none of it.
		const pub = await c.execute(
			"SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'node_identity'",
		);
		expect(Number(pub.rows[0]?.n)).toBe(0);
	} finally {
		await c.execute(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
		await c.end();
	}
});
