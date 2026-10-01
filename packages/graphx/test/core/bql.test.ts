import { afterEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Database as BunDatabase, type SQLQueryBindings } from 'bun:sqlite';
import { z } from 'zod';
import {
	bqlDatabaseName,
	bqlHranaUrl,
	createBqlClient,
	createBqlRemoteClient,
	openBqlMemoryDb,
	type BqlDatabase,
	type BqlModule,
	type BqlStatement,
} from '../../src/core/bql.ts';
import { closeAll, getDb } from '../../src/core/db.ts';
import type { DbClient, SqlStatement } from '../../src/core/dialect.ts';
import { applyConnPragmas } from '../../src/core/runtime.ts';
import {
	defineGraphSchema,
	Graph,
	hashEmbed,
	hybridRetrieve,
	init,
	match,
} from '../../src/core/portable.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	closeAll();
});

/**
 * Bun's SQLite behind `bql.sh/sqlite`'s shape: a cached `prepare`, `safeIntegers`, and
 * `changes` / `lastInsertRowid` read off the connection. This exercises the ADAPTER contract —
 * the statement cache it must not finalize, the bigint narrowing, RETURNING, transaction
 * control — not bql.sh's FFI driver, which is bql.sh's own suite's job. `test/hrana` in bql.sh and
 * `GRAPHX_TEST_DRIVER=bql` here cover the real thing.
 */
function shim(): { database: BqlDatabase; prepared: () => number; finalized: () => number } {
	// `safeIntegers` mirrors the real driver's open option: every INTEGER arrives as a bigint.
	const db = new BunDatabase(':memory:', { safeIntegers: true });
	db.exec('pragma journal_mode = memory');
	const cache = new Map<string, BqlStatement>();
	let prepared = 0;
	let finalized = 0;
	const meta = () =>
		db.query('SELECT changes() AS changes, last_insert_rowid() AS rowid').get() as {
			changes: bigint;
			rowid: bigint;
		};
	const database: BqlDatabase = {
		safeIntegers: true,
		get closed() {
			return false;
		},
		get changes() {
			return meta().changes;
		},
		get lastInsertRowid() {
			return meta().rowid;
		},
		prepare(sql) {
			const hit = cache.get(sql);
			if (hit) return hit;
			prepared++;
			const query = db.query(sql).as(Object);
			const statement: BqlStatement = {
				get columnNames() {
					return query.columnNames;
				},
				// The real driver reads this from SQLite at prepare time; the shim's
				// approximation is enough for the one thing the adapter does with it.
				readonly: !/^\s*(insert|update|delete|create|drop|alter|replace|vacuum)/i.test(sql),
				all: (...params) => query.all(...(params as SQLQueryBindings[])) as Record<string, never>[],
				run: (...params) => {
					query.run(...(params as SQLQueryBindings[]));
					const { changes, rowid } = meta();
					return { changes, lastInsertRowid: rowid };
				},
			};
			cache.set(sql, statement);
			return statement;
		},
		exec: (sql) => db.exec(sql),
		interrupt: () => {},
		deadline: () => {},
		// Bun's SQLite exposes none of these; the real driver's hooks are exercised against the
		// real driver. Here they only have to exist, because the client hands the connection
		// through and a host installs them.
		onCommit: () => {},
		onRollback: () => {},
		onUpdate: () => {},
		onPreupdate: () => {},
		authorizer: () => {},
		close: () => {
			finalized++;
			db.close();
		},
	};
	return { database, prepared: () => prepared, finalized: () => finalized };
}

const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string() }),
		gateway: z.object({ name: z.string() }),
	},
	edges: { deployedAt: { from: 'gateway', to: 'site' } },
});

test('a graph runs on an embedded bql.sh connection, through the sqlite dialect', async () => {
	const { database } = shim();
	const client = createBqlClient(database);
	cleanup.push(() => client.close());
	expect(client.dialect).toBe('sqlite');

	const embedder = hashEmbed();
	await init(client, embedder);
	const g = new Graph(client, schema, { embedder });
	const site = await g.addNode({ type: 'site', data: { name: 'us-east-1' } });
	const gateway = await g.addNode({
		type: 'gateway',
		data: { name: 'gw-1' },
		body: 'a gateway in us-east-1',
	});
	await g.addEdge({ rel: 'deployedAt', src: gateway.id, dst: site.id });

	// A pattern over the traversal SQL the sqlite arm emits.
	const rows = await (
		await match(schema, client)
			.node('g', 'gateway')
			.out('deployedAt')
			.node('s', 'site')
			.select('g', 's')
	).run();
	expect(rows.map((row) => [row.g.data.name, row.s.data.name])).toEqual([['gw-1', 'us-east-1']]);
	expect((await g.neighbors(gateway.id)).map((node) => node.id)).toEqual([site.id]);
	// Retrieval on this dialect is exact vector ranking over JSON text (no ANN index) fused
	// with FTS5 — the one bql.sh's pinned libsqlite3 compiles in.
	const found = await hybridRetrieve(client, embedder, { query: 'gateway in us-east-1', k: 2 });
	expect(found[0]?.id).toBe(gateway.id);
});

test('an interactive transaction rolls back on the embedded driver', async () => {
	const { database } = shim();
	const client = createBqlClient(database);
	cleanup.push(() => client.close());
	await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

	const tx = await client.transaction('write');
	await tx.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['first'] });
	await tx.rollback();
	expect((await client.execute('SELECT count(*) AS n FROM t')).rows[0]?.n).toBe(0);

	const committed = await client.transaction('write');
	await committed.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['second'] });
	await committed.commit();
	expect((await client.execute('SELECT v FROM t')).rows[0]?.v).toBe('second');
});

test('the embedded driver reports writes, RETURNING rows and rowids', async () => {
	const { database, prepared } = shim();
	const client = createBqlClient(database);
	cleanup.push(() => client.close());
	await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

	const insert = await client.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['a'] });
	expect(insert.rowsAffected).toBe(1);
	expect(insert.lastInsertRowid).toBe(1n);

	// `all` is the RETURNING-safe verb: `run` would drain the cursor and discard the rows.
	const returned = await client.execute("INSERT INTO t (v) VALUES ('b') RETURNING id, v");
	expect(returned.rows).toEqual([{ id: 2, v: 'b' }]);

	// A row value inside the safe range narrows from bigint to number.
	await client.execute({ sql: 'INSERT INTO t (id, v) VALUES (?, ?)', args: [2n ** 40n, 'big'] });
	const wide = await client.execute({ sql: 'SELECT id FROM t WHERE v = ?', args: ['big'] });
	expect(wide.rows[0]?.id).toBe(2 ** 40);

	// Statements are the host's, cached by SQL text: the same text compiles once, and the
	// adapter never finalizes one out from under the cache.
	const before = prepared();
	for (let i = 0; i < 3; i++) await client.execute({ sql: 'SELECT ? AS v', args: [i] });
	expect(prepared() - before).toBe(1);
});

test('the embedded driver refuses a connection that rounds 64-bit integers', () => {
	const { database } = shim();
	const unsafe: BqlDatabase = { ...database, safeIntegers: false };
	expect(() => createBqlClient(unsafe)).toThrow(/safeIntegers/);
});

test('a row value past 2^53 is refused rather than rounded', async () => {
	const { database } = shim();
	const client = createBqlClient(database);
	cleanup.push(() => client.close());
	await client.execute('CREATE TABLE t (v INTEGER)');
	await client.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: [2n ** 62n] });
	await expect(client.execute('SELECT v FROM t')).rejects.toThrow(/cannot be safely represented/);
});

test('openBqlMemoryDb configures and verifies the connection it opens', async () => {
	const module: BqlModule = {
		Database: {
			open: (path, options) => {
				expect(path).toBe(':memory:');
				expect(options?.safeIntegers).toBe(true);
				return shim().database;
			},
		},
	};
	const client = await openBqlMemoryDb(module);
	cleanup.push(() => client.close());
	expect((await client.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys).toBe(1);
	expect(client.interrupt).toBeFunction();
	expect(client.deadline).toBeFunction();
	// The connection is reachable, which is how a host installs a commit hook or an authorizer.
	expect(client.database.onCommit).toBeFunction();
});

test('the Hrana URL carries the database and the trailing slash @libsql/core needs', () => {
	expect(bqlHranaUrl('http://127.0.0.1:4321', 'acme__alpha')).toBe(
		'http://127.0.0.1:4321/v1/db/acme__alpha/',
	);
	expect(bqlHranaUrl('https://sql.example.com/', 'acme')).toBe(
		'https://sql.example.com/v1/db/acme/',
	);
	expect(() => bqlHranaUrl('http://127.0.0.1:4321', 'Acme')).toThrow(/invalid/);
	expect(() => bqlHranaUrl('http://127.0.0.1:4321/v1/db/acme/', 'acme')).toThrow(/origin/);
	expect(() => bqlHranaUrl('http://127.0.0.1:4321?x=1', 'acme')).toThrow(/origin/);
});

test('a bql.sh server client is tagged sqlite, and graphx issues it no pragmas', async () => {
	const client = createBqlRemoteClient({ url: 'http://127.0.0.1:4321', database: 'acme' });
	cleanup.push(() => client.close());
	expect(client.dialect).toBe('sqlite');
	expect(client.managedPragmas).toBe(true);

	// bql.sh's authorizer DENIES a pragma that sets anything, so a driver that owns its
	// connection settings must see none of these — the pragmas would throw, not be ignored.
	const issued: SqlStatement[] = [];
	const spy: DbClient = {
		dialect: 'sqlite',
		managedPragmas: true,
		execute: async (stmt) => {
			issued.push(stmt);
			return { rows: [], rowsAffected: 0 };
		},
		batch: async () => [],
		transaction: () => Promise.reject(new Error('unused')),
		executeMultiple: async () => {},
		close: () => {},
	};
	await applyConnPragmas(spy);
	expect(issued).toEqual([]);
});

test('getDb serves the bql driver, and says what is missing without a URL', () => {
	const client = getDb('acme__alpha', { driver: 'bql', bqlUrl: 'http://127.0.0.1:4321' });
	expect(client.dialect).toBe('sqlite');
	expect(client.managedPragmas).toBe(true);
	// One cached client per namespace, exactly as the other drivers.
	expect(getDb('acme__alpha', { driver: 'bql' })).toBe(client);

	const url = process.env.GRAPHX_BQL_URL;
	delete process.env.GRAPHX_BQL_URL;
	try {
		expect(() => getDb('other__ns', { driver: 'bql' })).toThrow(/GRAPHX_BQL_URL/);
	} finally {
		if (url !== undefined) process.env.GRAPHX_BQL_URL = url;
	}
});

test('a namespace is folded to a bql.sh database name, or refused', () => {
	// graphx mints `<prefix>_<ULID>`, and a ULID is upper case by construction.
	expect(bqlDatabaseName('evt_01M3E2K3W0D4T0QNR1QJAR33E7')).toBe('evt_01m3e2k3w0d4t0qnr1qjar33e7');
	expect(bqlDatabaseName('acme__alpha')).toBe('acme__alpha');
	expect(() => bqlDatabaseName('acme.alpha')).toThrow(/case folding/);
	expect(() => bqlDatabaseName('_leading')).toThrow(/case folding/);
	expect(bqlHranaUrl('http://127.0.0.1:4321', 'acme__alpha')).toContain('/v1/db/acme__alpha/');
});

test('a graphx config selecting bql loads the driver without an explicit import', async () => {
	// `graphx serve` / `graphx mcp` import the adapter for the driver the config names, the same
	// way they do for postgres and duckdb — so a config is enough, with no side-effect import.
	const { loadConfig } = await import('../../src/cli-config.ts');
	const path = join(import.meta.dir, `bql-cli-${Date.now()}.config.ts`);
	await Bun.write(
		path,
		`import { defineGraphSchema, hashEmbed } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({}).loose() }, edges: {} });
export default { schema, embedder: hashEmbed(8), db: { driver: 'bql', bqlUrl: 'http://127.0.0.1:4321' }, namespace: 'cfgbql' };
`,
	);
	try {
		const cfg = await loadConfig(path);
		expect(cfg.db?.driver).toBe('bql');
		expect(getDb('cfgbql', cfg.db).dialect).toBe('sqlite');
	} finally {
		await rm(path, { force: true });
	}
});
