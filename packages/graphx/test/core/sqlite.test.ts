import { afterEach, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createConnectionClient } from '../../src/core/portable.ts';
import { vectorSeedRows } from '../../src/core/retrieve.ts';
import { annSeeds } from '../../src/core/dialect-sql.ts';
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

// Ordinary SQLite: no libSQL vector extension and no platform persistence claims.
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function open(path = ':memory:', ddl = (sql: string) => sql) {
	const db = new Database(path);
	const client = createConnectionClient(
		{
			async execute(stmt) {
				const sql = typeof stmt === 'string' ? stmt : stmt.sql;
				const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
				const query = db.query(sql);
				try {
					const rows = Array.isArray(args)
						? query.all(...(args as SQLQueryBindings[]))
						: query.all(args as SQLQueryBindings);
					const meta = db.query('SELECT changes() AS n, last_insert_rowid() AS id').get() as {
						n: number;
						id: number;
					};
					return {
						rows: rows as Record<string, unknown>[],
						rowsAffected: meta.n,
						lastInsertRowid: BigInt(meta.id),
					};
				} finally {
					query.finalize();
				}
			},
			async executeMultiple(sql) {
				db.exec(ddl(sql));
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
	expect(await history(client, a.id)).toHaveLength(2);
	expect((await graph.neighbors(a.id))[0]?.id).toBe(b.id);
	await client.close();
	client = open(join(dir, 'vault.db'));
	await init(client, embedder);
	const reopened = new Graph(client, schema, { embedder });
	expect((await reopened.getNodeContent(a.id))?.body).toBe('edited');
	expect((await reopened.retrieve({ query: 'edited', k: 1, maxDepth: 0 }))[0]?.id).toBe(a.id);
	expect((await reopened.listNodes({ q: 'edited' })).nodes.map((n) => n.id)).toEqual([a.id]);
	expect((await reopened.neighbors(a.id)).map((n) => n.id)).toEqual([b.id]);
	expect(await history(client, a.id)).toHaveLength(2);
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
	expect(await history(client, peach.id)).toHaveLength(2);
});

test('SQLite exact vectors deduplicate all chunks, order ties, and preserve best snippets', async () => {
	const client = open();
	await init(client, hashEmbed(2));
	for (const id of ['a', 'b', 'c', 'zero'])
		await client.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: [id] });
	for (let chunk = 0; chunk < 12; chunk++) {
		await client.execute({
			sql: 'INSERT INTO node_embeddings VALUES (?, ?, ?, ?, ?)',
			args: ['a', chunk, `chunk ${chunk}`, chunk === 11 ? '[1,0]' : '[1,1]', 'hash'],
		});
	}
	for (const id of ['b', 'c', 'zero'])
		await client.execute({
			sql: 'INSERT INTO node_embeddings VALUES (?, 0, NULL, ?, ?)',
			args: [id, id === 'zero' ? '[0,0]' : '[1,0]', 'hash'],
		});
	const rows = await vectorSeedRows(client, [1, 0], 4);
	expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'zero']);
	expect(rows[0]?.snippet).toBe('chunk 11');
	expect(rows.map((r) => r.dist)).toEqual([0, 0, 0, 1]);
	expect(await vectorSeedRows(client, [0, 0], 4)).toEqual([]);
	expect((await vectorSeedRows(client, [Number.MAX_VALUE, 0], 1))[0]?.dist).toBe(0);
	await expect(vectorSeedRows(client, [1], 1)).rejects.toThrow('dimensions');
	await expect(vectorSeedRows(client, [NaN, 0], 1)).rejects.toThrow('finite');
});

test('SQLite validates vector shape at storage and corrupted components on retrieval', async () => {
	const client = open();
	await init(client, hashEmbed(2));
	await client.execute("INSERT INTO node_identity VALUES ('bad')");
	for (const emb of ['[1]', '{}', 'null', 'invalid']) {
		await expect(
			client.execute({
				sql: "INSERT INTO node_embeddings VALUES ('bad', 0, NULL, ?, 'hash')",
				args: [emb],
			}),
		).rejects.toThrow();
	}
	await client.execute("INSERT INTO node_embeddings VALUES ('bad', 0, NULL, '[1,null]', 'hash')");
	await expect(vectorSeedRows(client, [1, 0], 1)).rejects.toThrow('finite');
	await client.execute('PRAGMA ignore_check_constraints = ON');
	for (const emb of ['[1]', '{}', 'invalid', '[1,1e999]']) {
		await client.execute({
			sql: "UPDATE node_embeddings SET emb = ? WHERE id = 'bad'",
			args: [emb],
		});
		await expect(vectorSeedRows(client, [1, 0], 1)).rejects.toThrow();
	}
});

test('native getDb refuses ordinary SQLite and direct ANN SQL is unavailable', () => {
	expect(() => getDb('sqlite-requires-driver', { driver: 'sqlite' })).toThrow(
		'createConnectionClient',
	);
	expect(() => annSeeds('sqlite')).toThrow('vectorSeedRows');
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
		{ loadTs: 20 },
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
	expect(await history(client, a.id)).toHaveLength(1);
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
	// Bun includes FTS5. Substitute a nonexistent module to exercise SQLite's actual
	// missing-module behavior at the DDL boundary. Bun 1.4's multi-statement exec
	// swallows that middle-statement error; init's single-statement FTS probe must
	// still reject the missing index. This is not a separate no-FTS SQLite build.
	const client = open(':memory:', (sql) => sql.replace('USING fts5(', 'USING unavailable_fts5('));
	await expect(init(client)).rejects.toThrow('nodes_fts');
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
