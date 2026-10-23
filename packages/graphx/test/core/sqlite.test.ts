import { afterEach, expect, test } from 'bun:test';
import { Database as PlainDatabase, type SQLQueryBindings } from 'bun:sqlite';
import { Database } from 'bql.sh/sqlite';
import { createBqlClient } from '../../src/core/bql.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createConnectionClient } from '../../src/core/portable.ts';
import { vectorSeedRows } from '../../src/core/retrieve.ts';
import { annSeeds, embJson, embReadExpr } from '../../src/core/dialect-sql.ts';
import { getDb } from '../../src/core/db.ts';
import {
	Graph,
	defineGraphSchema,
	init,
	hashEmbed,
	history,
	declareUniqueNodeProp,
	materializeConstraints,
	shortestPath,
	outboxTail,
	bulkLoad,
	bulkEdges,
	changeFeed,
	match,
} from '../../src/core/portable.ts';

// Ordinary SQLite plus sqlite-vec: no libSQL vector extension and no platform persistence claims.
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

/**
 * SQLite through bql.sh's pinned libsqlite3, which compiles in sqlite-vec: the `sqlite` dialect's
 * vectors need it. `ddl` rewrites what `init` executes, to simulate a missing module.
 */
function open(path = ':memory:', ddl = (sql: string) => sql) {
	const db = Database.open(path, { safeIntegers: true, wal: false });
	const database = new Proxy(db, {
		get(target, key) {
			if (key === 'exec') return (sql: string) => target.exec(ddl(sql));
			const value = Reflect.get(target, key);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	const client = createBqlClient(database);
	disposers.push(() => client.close());
	return client;
}

/**
 * SQLite without sqlite-vec. After other tests here open bql.sh connections, Bun's own SQLite in
 * the same process also answers vec_version(), so the missing function is simulated.
 */
function openPlain() {
	const db = new PlainDatabase(':memory:');
	const client = createConnectionClient(
		{
			async execute(stmt) {
				const sql = typeof stmt === 'string' ? stmt : stmt.sql;
				const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
				if (sql.includes('vec_version')) throw new Error('no such function: vec_version');
				const rows = db.query(sql).all(...(args as SQLQueryBindings[]));
				return { rows: rows as Record<string, unknown>[], rowsAffected: 0 };
			},
			async executeMultiple(sql) {
				db.exec(sql);
			},
			close() {
				db.close();
			},
		},
		'sqlite',
	);
	disposers.push(() => client.close());
	return client;
}

const schema = defineGraphSchema({
	nodes: { note: z.object({ path: z.string() }) },
	edges: {
		links: { from: 'note', to: 'note' },
		parent: { from: 'note', to: 'note', single: true },
	},
});

test('ordinary SQLite persists graph content and temporal history on reopen', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'graphx-sqlite-'));
	disposers.push(async () => rmSync(dir, { recursive: true, force: true }));
	let client = open(join(dir, 'vault.db'));
	const embedder = hashEmbed(8);
	expect((await client.execute('PRAGMA journal_mode')).rows[0]?.journal_mode).toBe('delete');
	await init(client, embedder);
	const graph = new Graph(client, schema, { embedder, events: { outbox: true } });
	const a = await graph.addNode({ type: 'note', data: { path: 'A.md' }, body: 'first' });
	const b = await graph.addNode({ type: 'note', data: { path: 'B.md' }, body: 'second' });
	await graph.addEdge({ rel: 'links', src: a.id, dst: b.id });
	await graph.updateNode(a.id, { body: 'edited' });
	expect((await history(client, a.id)).filter((v) => v.current)).toHaveLength(2);
	expect((await graph.neighbors(a.id))[0]?.id).toBe(b.id);
	await client.close();
	client = open(join(dir, 'vault.db'));
	await init(client, embedder);
	const reopened = new Graph(client, schema, { embedder });
	expect((await reopened.getNodeContent(a.id))?.body).toBe('edited');
	expect((await reopened.retrieve({ query: 'edited', k: 1, maxDepth: 0 }))[0]?.id).toBe(a.id);
	expect((await reopened.listNodes({ q: 'edited' })).nodes.map((n) => n.id)).toEqual([a.id]);
	expect((await reopened.neighbors(a.id)).map((n) => n.id)).toEqual([b.id]);
	expect((await history(client, a.id)).filter((v) => v.current)).toHaveLength(2);
	expect((await client.execute('PRAGMA journal_mode')).rows[0]?.journal_mode).toBe('delete');
	expect((await outboxTail(client)).events.length).toBeGreaterThanOrEqual(4);
});

test('SQLite graph constraints reject collisions and keep one parent', async () => {
	const client = open();
	await init(client);
	await declareUniqueNodeProp(client, { type: 'note', prop: 'path' });
	await materializeConstraints(client, schema);
	const graph = new Graph(client, schema);
	const a = await graph.addNode({ type: 'note', data: { path: 'A.md' } });
	const b = await graph.addNode({ type: 'note', data: { path: 'B.md' } });
	const c = await graph.addNode({ type: 'note', data: { path: 'C.md' } });
	await expect(graph.addNode({ type: 'note', data: { path: 'A.md' } })).rejects.toThrow();
	await graph.addEdge({ rel: 'parent', src: a.id, dst: b.id });
	await graph.addEdge({ rel: 'parent', src: a.id, dst: c.id });
	expect((await graph.neighbors(a.id, { rels: ['parent'] })).map((n) => n.id)).toEqual([c.id]);
	expect(await shortestPath(client, a.id, c.id, { mode: 'sql' })).not.toBeNull();
});

test('SQLite stores and ranks vectors locally and supports FTS and model checks', async () => {
	const client = open();
	const embedder = hashEmbed(64);
	await init(client, embedder);
	const graph = new Graph(client, schema, { embedder });
	const peach = await graph.addNode({
		type: 'note',
		data: { path: 'Peach.md' },
		body: 'peach orchard fruit',
	});
	await graph.addNode({
		type: 'note',
		data: { path: 'Other.md' },
		body: 'database storage engine',
	});
	expect((await graph.retrieve({ query: 'peach orchard fruit', k: 1 }))[0]?.id).toBe(peach.id);
	expect((await graph.hybridRetrieve({ query: 'peach orchard', k: 1 }))[0]?.id).toBe(peach.id);
	await expect(init(client, hashEmbed(32))).rejects.toThrow();
	await graph.updateNode(peach.id, { body: 'peach harvest' });
	expect((await graph.retrieve({ query: 'peach harvest', k: 1 }))[0]?.id).toBe(peach.id);
	expect((await history(client, peach.id)).filter((v) => v.current)).toHaveLength(2);
});

test('SQLite exact vectors deduplicate all chunks, order ties, and preserve best snippets', async () => {
	const client = open();
	await init(client, hashEmbed(2));
	for (const id of ['a', 'b', 'c', 'zero'])
		await client.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: [id] });
	for (let chunk = 0; chunk < 12; chunk++) {
		await client.execute({
			sql: 'INSERT INTO node_embeddings VALUES (?, ?, ?, vec_f32(?), ?)',
			args: ['a', chunk, `chunk ${chunk}`, chunk === 11 ? '[1,0]' : '[1,1]', 'hash'],
		});
	}
	for (const id of ['b', 'c', 'zero'])
		await client.execute({
			sql: 'INSERT INTO node_embeddings VALUES (?, 0, NULL, vec_f32(?), ?)',
			args: [id, id === 'zero' ? '[0,0]' : '[1,0]', 'hash'],
		});
	const rows = await vectorSeedRows(client, [1, 0], 4);
	expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'zero']);
	expect(rows[0]?.snippet).toBe('chunk 11');
	expect(rows.map((r) => r.dist)).toEqual([0, 0, 0, 1]);
	expect(await vectorSeedRows(client, [0, 0], 4)).toEqual([]);
	expect((await vectorSeedRows(client, [Number.MAX_VALUE, 0], 1))[0]?.dist).toBe(0);
	await expect(vectorSeedRows(client, [1], 1)).rejects.toThrow('dimension');
	await expect(vectorSeedRows(client, [NaN, 0], 1)).rejects.toThrow('finite');
});

test('SQLite validates vector shape at storage and corrupted blobs on retrieval', async () => {
	const client = open();
	await init(client, hashEmbed(2));
	await client.execute("INSERT INTO node_identity VALUES ('bad')");
	for (const emb of ['[1]', '{}', 'null', 'invalid', '[1,null]']) {
		await expect(
			client.execute({
				sql: "INSERT INTO node_embeddings VALUES ('bad', 0, NULL, vec_f32(?), 'hash')",
				args: [emb],
			}),
		).rejects.toThrow();
	}
	await client.execute('PRAGMA ignore_check_constraints = ON');
	await client.execute("INSERT INTO node_embeddings VALUES ('bad', 0, NULL, X'0000803F', 'hash')");
	await expect(vectorSeedRows(client, [1, 0], 1)).rejects.toThrow();
});

test('SQLite without sqlite-vec runs a graph but refuses an embedder', async () => {
	const client = openPlain();
	await init(client);
	const graph = new Graph(client, schema);
	const a = await graph.addNode({ type: 'note', data: { path: 'A.md' }, body: 'plain' });
	expect((await graph.listNodes({ q: 'plain' })).nodes.map((n) => n.id)).toEqual([a.id]);
	await expect(init(openPlain(), hashEmbed(2))).rejects.toThrow('sqlite-vec');
});

test('SQLite vectors read back at full float32 precision', async () => {
	const client = open();
	await init(client, hashEmbed(2));
	await client.execute("INSERT INTO node_identity VALUES ('p')");
	await client.execute({
		sql: "INSERT INTO node_embeddings VALUES ('p', 0, NULL, vec_f32(?), 'hash')",
		args: ['[0.1234567, 1e-7]'],
	});
	const row = (await client.execute(`SELECT ${embReadExpr('sqlite')} AS e FROM node_embeddings`))
		.rows[0];
	const [x, y] = JSON.parse(embJson(row?.e)) as number[];
	expect(x).toBeCloseTo(0.1234567, 7);
	expect(y).toBeCloseTo(1e-7, 12);
});

test('native getDb refuses ordinary SQLite and SQLite seeds rank with sqlite-vec', () => {
	expect(() => getDb('sqlite-requires-driver', { driver: 'sqlite' })).toThrow(
		'createConnectionClient',
	);
	expect(annSeeds('sqlite').sql).toContain('vec_distance_cosine');
});

test('SQLite bulk ingestion keeps lexical search, temporal boundaries, and pagination consistent', async () => {
	const client = open();
	await init(client, hashEmbed(8));
	await bulkLoad(
		client,
		schema,
		[
			{
				id: 'a',
				type: 'note',
				data: { path: 'A.md' },
				body: 'ancient orchard',
				validFrom: 10,
				validTo: 20,
			},
			{ id: 'a', type: 'note', data: { path: 'A.md' }, body: 'current harvest', validFrom: 20 },
			{
				id: 'b',
				type: 'note',
				data: { path: 'B.md' },
				body: 'current peaches',
				validFrom: 20,
				embedding: false,
			},
			{ id: 'c', type: 'note', data: { path: 'C.md' }, body: 'unrelated', validFrom: 20 },
		],
		{ embedder: hashEmbed(8), chunkSize: 2 },
	);
	await bulkEdges(
		client,
		schema,
		[
			{ id: 'ab', src: 'a', dst: 'b', rel: 'links', weight: 1 },
			{ id: 'ac', src: 'a', dst: 'c', rel: 'links', weight: 5 },
			{ id: 'bc', src: 'b', dst: 'c', rel: 'links', weight: 1 },
		],
		{ validFrom: 20 },
	);
	const graph = new Graph(client, schema, { embedder: hashEmbed(8) });
	expect((await graph.listNodes({ q: 'ancient', asOf: 19 })).nodes.map((n) => n.id)).toEqual(['a']);
	expect((await graph.listNodes({ q: 'ancient', asOf: 20 })).nodes).toEqual([]);
	expect((await graph.listNodes({ q: 'current', type: 'note' })).nodes.map((n) => n.id)).toEqual([
		'a',
		'b',
	]);
	expect((await graph.listNodes({ q: '" OR * : ()' })).nodes).toEqual([]);
	const first = await graph.listNodes({ type: 'note', limit: 2 });
	expect(first.nodes.map((n) => n.id)).toEqual(['a', 'b']);
	expect(first.nextCursor).not.toBeNull();
	expect(
		(await graph.listNodes({ type: 'note', limit: 2, cursor: first.nextCursor! })).nodes.map(
			(n) => n.id,
		),
	).toEqual(['c']);
	const neighbors = await graph.neighborsPage('a', { limit: 1 });
	expect(neighbors.rows.map((n) => n.id)).toEqual(['b']);
	expect(
		(await graph.neighborsPage('a', { limit: 1, cursor: neighbors.nextCursor! })).rows.map(
			(n) => n.id,
		),
	).toEqual(['c']);
	expect(await shortestPath(client, 'a', 'c', { mode: 'sql' })).toEqual({
		path: ['a', 'b', 'c'],
		cost: 2,
	});
	const pattern = await match(schema, client)
		.node('a', 'note')
		.where('a', 'path', 'A.md')
		.out('links')
		.node('b', 'note')
		.where('b', 'path', 'B.md')
		.select('a', 'b');
	expect(await pattern.run()).toHaveLength(1);
	expect(
		(await graph.hybridRetrieve({ query: 'peaches', k: 3, maxDepth: 0 })).find((n) => n.id === 'b')
			?.via,
	).toEqual(['fts']);
	const feed = await changeFeed(client, {}, { limit: 2 });
	expect(feed.nodes).toHaveLength(2);
	expect(feed.edges).toHaveLength(2);
	const next = await changeFeed(
		client,
		{ nodes: feed.nextCursor.nodes!, edges: feed.nextCursor.edges! },
		{ limit: 2 },
	);
	expect(next.nodes).toHaveLength(2);
	expect(next.edges).toHaveLength(1);
	expect(new Set([...feed.nodes, ...next.nodes].map((n) => n.ver)).size).toBe(4);
	expect(
		(
			await client.execute(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'nodes_fts_ai'",
			)
		).rows,
	).toHaveLength(1);
});

test('SQLite graph rollback leaves content, vectors, history, FTS and outbox unchanged', async () => {
	const client = open();
	const embedder = hashEmbed(8);
	await init(client, embedder);
	await declareUniqueNodeProp(client, { type: 'note', prop: 'path' });
	const graph = new Graph(client, schema, { embedder, events: { outbox: true } });
	const a = await graph.addNode({ type: 'note', data: { path: 'A.md' }, body: 'before' });
	await graph.addNode({ type: 'note', data: { path: 'B.md' }, body: 'other' });
	const before = await client.execute('SELECT * FROM node_embeddings ORDER BY id, chunk');
	await expect(
		graph.updateNode(a.id, { data: { path: 'B.md' }, body: 'forbidden' }),
	).rejects.toThrow();
	expect((await graph.getNodeContent(a.id))?.body).toBe('before');
	expect((await history(client, a.id)).filter((v) => v.current)).toHaveLength(1);
	expect((await graph.listNodes({ q: 'forbidden' })).nodes).toEqual([]);
	expect((await client.execute('SELECT * FROM node_embeddings ORDER BY id, chunk')).rows).toEqual(
		before.rows,
	);
	expect((await outboxTail(client)).events).toHaveLength(2);
	const tx = await client.transaction();
	await tx.execute("INSERT INTO node_identity VALUES ('rolled-back')");
	await tx.rollback();
	expect(
		(await client.execute("SELECT * FROM node_identity WHERE id = 'rolled-back'")).rows,
	).toEqual([]);
	await expect(
		client.execute(
			"INSERT INTO edge_versions (id, src, dst, rel, valid_from) VALUES ('missing', 'missing', 'missing', 'links', 1)",
		),
	).rejects.toThrow('FOREIGN KEY');
});

test('SQLite model replacement reembeds chunks and deletion removes live retrieval', async () => {
	const client = open();
	const embedder = hashEmbed(8);
	await init(client, embedder);
	const chunked = defineGraphSchema({
		nodes: schema.nodes,
		edges: schema.edges,
		embedding: { note: { chunk: { size: 24, overlap: 4 } } },
	});
	const graph = new Graph(client, chunked, { embedder, events: { outbox: true } });
	const note = await graph.addNode({
		type: 'note',
		data: { path: 'Chunks.md' },
		body: 'peach orchard fruit. database storage. peach harvest season.',
	});
	const results = await graph.retrieve({ query: 'peach orchard fruit.', k: 2, maxDepth: 0 });
	expect(results).toHaveLength(1);
	expect(results[0]?.snippet).toContain('peach');
	expect((await graph.embeddingReport()).vectors).toBeGreaterThan(1);
	const replacement = new Graph(client, chunked, {
		embedder: hashEmbed(16),
		events: { outbox: true },
	});
	await expect(replacement.retrieve({ query: 'peach' })).rejects.toThrow('model');
	expect(await replacement.reembed({ pageSize: 1 })).toEqual({ nodes: 1, embedded: 1, skipped: 0 });
	expect((await replacement.embeddingReport()).stored?.dim).toBe(16);
	expect((await replacement.hybridRetrieve({ query: 'peach', mmr: { k: 1 } }))[0]?.id).toBe(
		note.id,
	);
	await replacement.deleteNode(note.id);
	expect(await replacement.retrieve({ query: 'peach' })).toEqual([]);
	expect((await replacement.listNodes({ q: 'peach' })).nodes).toEqual([]);
	expect((await client.execute('SELECT * FROM node_embeddings')).rows).toEqual([]);
	expect((await outboxTail(client)).events.at(-1)?.op).toBe('node.delete');
});

test('SQLite init propagates a missing FTS module error instead of disabling search', async () => {
	// Substitute a nonexistent module to exercise SQLite's actual missing-module behavior at the
	// DDL boundary. This is not a separate no-FTS SQLite build.
	const client = open(':memory:', (sql) => sql.replace('USING fts5(', 'USING unavailable_fts5('));
	await expect(init(client)).rejects.toThrow('unavailable_fts5');
});

test('SQLite graph rejects invalid input vectors before persisting any node', async () => {
	const client = open();
	await init(client, hashEmbed(2));
	const graph = new Graph(client, schema);
	expect(await vectorSeedRows(client, [1, 0], 2)).toEqual([]);
	for (const emb of [[1], [NaN, 0], [Infinity, 0]]) {
		await expect(
			graph.addNode({ type: 'note', data: { path: 'Invalid.md' }, emb }),
		).rejects.toThrow();
	}
	expect((await graph.listNodes()).nodes).toEqual([]);
});
