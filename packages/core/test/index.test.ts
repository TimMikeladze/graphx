import { expect, test } from 'bun:test';
import { applyConnPragmas } from '../src/db.ts';
import type { DbClient } from '../src/dialect.ts';
import { libsqlOnly, makeTestDb } from './harness.ts';

// P0 foundation + libSQL capability probe. Proves the engine features the whole
// design rests on (native vectors, FTS5, generated columns) actually work on the
// pinned @libsql/client before later phases build on them (§18, audit M16).
// These probe libSQL-native capabilities and do not apply to the Postgres backend.

function mem(): DbClient {
	return makeTestDb().client;
}

test('P0: SELECT 1 over libSQL', async () => {
	const c = mem();
	const r = await c.execute('SELECT 1 AS one');
	expect(Number(r.rows[0]!.one)).toBe(1);
	c.close();
});

libsqlOnly('P0: connection pragmas apply (foreign_keys ON, busy_timeout set)', async () => {
	const c = mem();
	await applyConnPragmas(c);
	const fk = await c.execute('PRAGMA foreign_keys');
	expect(Number(fk.rows[0]!.foreign_keys)).toBe(1);
	const bt = await c.execute('PRAGMA busy_timeout');
	expect(Number(bt.rows[0]!.timeout)).toBe(5000);
	c.close();
});

libsqlOnly('P0 capability: native vectors — F32_BLOB + libsql_vector_idx + vector_top_k', async () => {
	const c = mem();
	await c.executeMultiple(
		`CREATE TABLE items (ver INTEGER PRIMARY KEY, emb F32_BLOB(4));
		 CREATE INDEX items_emb ON items(libsql_vector_idx(emb, 'metric=cosine'));`,
	);
	await c.batch(
		[
			{ sql: 'INSERT INTO items (ver, emb) VALUES (1, vector(?))', args: ['[1,0,0,0]'] },
			{ sql: 'INSERT INTO items (ver, emb) VALUES (2, vector(?))', args: ['[0,1,0,0]'] },
			{ sql: 'INSERT INTO items (ver, emb) VALUES (3, vector(?))', args: ['[0.9,0.1,0,0]'] },
		],
		'write',
	);
	// vector_top_k returns base-table rowids in column `id`; join on rowid (= ver alias).
	const r = await c.execute({
		sql: "SELECT i.ver FROM vector_top_k('items_emb', vector(?), 2) v JOIN items i ON i.rowid = v.id",
		args: ['[1,0,0,0]'],
	});
	const vers = r.rows.map((x) => Number(x.ver));
	expect(vers.length).toBe(2);
	expect(vers).toContain(1); // nearest to the query
	c.close();
});

libsqlOnly('P0 capability: FTS5 virtual table + MATCH', async () => {
	const c = mem();
	await c.executeMultiple(
		`CREATE VIRTUAL TABLE docs USING fts5(body);
		 INSERT INTO docs(body) VALUES ('the quick brown fox');`,
	);
	const r = await c.execute("SELECT rowid FROM docs WHERE docs MATCH 'fox'");
	expect(r.rows.length).toBe(1);
	c.close();
});

libsqlOnly('P0 capability: generated column + json ->> operator', async () => {
	const c = mem();
	await c.executeMultiple(
		`CREATE TABLE n (ver INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}',
		   etype TEXT GENERATED ALWAYS AS (data ->> 'etype'));`,
	);
	await c.execute({
		sql: 'INSERT INTO n (ver, data) VALUES (1, ?)',
		args: [JSON.stringify({ etype: 'device' })],
	});
	const r = await c.execute('SELECT etype FROM n WHERE ver = 1');
	expect(r.rows[0]!.etype).toBe('device');
	c.close();
});
