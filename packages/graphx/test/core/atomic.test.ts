import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createConnectionClient } from '../../src/core/connection.ts';
import type { DbClient } from '../../src/core/dialect.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { Graph } from '../../src/core/graph.ts';
import type { AtomicGraph } from '../../src/core/graph.ts';
import { hashEmbed } from '../../src/core/embedder.ts';
import { pagerank } from '../../src/core/algorithms.ts';
import { InMemoryEvents } from '../../src/core/events.ts';
import { init } from '../../src/core/schema.ts';
import { declareUniqueNodeProp } from '../../src/core/constraints.ts';
import { history, outboxTail } from '../../src/core/temporal.ts';
import { createLocalBlobStore } from '../../src/core/local-blobs.ts';
import { makeTestDb, TEST_DRIVER, type TestDb } from './harness.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function sqliteDb(): TestDb {
	const dir = mkdtempSync(join(tmpdir(), 'graphx-atomic-'));
	const clients: ReturnType<typeof createConnectionClient>[] = [];
	function open() {
		const db = new Database(join(dir, 'db.sqlite'));
		const client = createConnectionClient(
			{
				async execute(stmt) {
					const query = db.query(typeof stmt === 'string' ? stmt : stmt.sql);
					const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
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
					db.exec(sql);
				},
				close() {
					db.close();
				},
			},
			'sqlite',
		);
		clients.push(client);
		return client;
	}
	return {
		client: open(),
		sibling: open,
		async teardown() {
			for (const client of clients) await client.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const schema = defineGraphSchema({
	nodes: {
		note: z.object({ path: z.string().nullable(), extra: z.string().optional() }),
		other: z.object({ title: z.string() }),
	},
	edges: {
		links: { from: 'note', to: 'note' },
		parent: { from: 'note', to: 'note', single: true },
	},
});

for (const [driver, open] of [
	['libsql', () => makeTestDb({ file: true })],
	['sqlite', sqliteDb],
] as const) {
	if (driver === 'libsql' && TEST_DRIVER !== 'libsql') continue;
	describe(`atomic graph (${driver})`, () => {
		async function setup() {
			const db = open();
			cleanup.push(db.teardown);
			await init(db.client);
			await declareUniqueNodeProp(db.client, { type: 'note', prop: 'path' });
			const events = new InMemoryEvents();
			const graph = new Graph(db.client, schema, { events: { sink: events, outbox: true } });
			return { ...db, graph, events };
		}

		test('commits new endpoints, links, bytes, and versioned content together', async () => {
			const { graph, events, client } = await setup();
			const result = await graph.atomic(async (scope) => {
				const blob = await scope.blobs.put(new Uint8Array([0, 255, 128]));
				const a = await scope.addNode({
					type: 'note',
					data: { path: 'A.md' },
					body: 'orchard',
					uri: blob.uri,
					content_hash: blob.hash,
					content_type: 'application/octet-stream',
				});
				const b = await scope.addNode({ type: 'note', data: { path: 'B.md' }, body: 'peach' });
				await scope.addEdge({ rel: 'links', src: a.id, dst: b.id });
				expect(events.events).toEqual([]);
				expect((await scope.getNodeVersion(a.id))?.contentHash).toBe(blob.hash);
				return { a, b, blob };
			});
			expect(result.a.revision).toMatch(/^\d+$/);
			expect(await graph.getNodeVersion(result.a.id)).toEqual(result.a);
			expect((await graph.neighbors(result.a.id)).map((n) => n.id)).toEqual([result.b.id]);
			expect(await (await createLocalBlobStore(client)).get(result.blob.uri)).toEqual(
				new Uint8Array([0, 255, 128]),
			);
			expect(events.events.map((e) => e.op)).toEqual(['node.create', 'node.create', 'edge.create']);
			expect((await outboxTail(client)).events).toHaveLength(3);
		});

		test('callback failure rolls back bytes, graph, FTS, and outbox and emits nothing', async () => {
			const { graph, client, events } = await setup();
			await expect(
				graph.atomic(async (scope) => {
					await scope.blobs.put(new Uint8Array([1]));
					const a = await scope.addNode({
						type: 'note',
						data: { path: 'A.md' },
						body: 'rollbackword',
					});
					const b = await scope.addNode({ type: 'note', data: { path: 'B.md' } });
					await scope.addEdge({ rel: 'links', src: a.id, dst: b.id });
					throw new Error('cancelled');
				}),
			).rejects.toThrow('cancelled');
			for (const table of [
				'node_identity',
				'node_versions',
				'edge_identity',
				'edge_versions',
				'graphx_blobs',
				'graph_outbox',
			]) {
				expect((await client.execute(`SELECT * FROM ${table}`)).rows).toEqual([]);
			}
			expect((await graph.listNodes({ q: 'rollbackword' })).nodes).toEqual([]);
			expect(events.events).toEqual([]);
		});

		test('CAS saves return successor revisions, clear null content, and replace metadata', async () => {
			const { graph, client } = await setup();
			const node = await graph.addNode({
				type: 'note',
				data: { path: 'A.md', extra: 'remove' },
				body: 'before',
				uri: 'source',
				content_hash: 'hash',
				content_type: 'text/plain',
			});
			const before = (await graph.getNodeVersion(node.id))!;
			const after = await graph.atomic((scope) =>
				scope.updateNode(
					node.id,
					{
						data: { path: 'B.md' },
						body: null,
						uri: null,
						content_hash: null,
						content_type: null,
					},
					{ expectedRevision: before.revision, replaceData: true },
				),
			);
			expect(after.revision).not.toBe(before.revision);
			expect(after.data).toEqual({ path: 'B.md' });
			expect([after.body, after.uri, after.contentHash, after.contentType]).toEqual([
				null,
				null,
				null,
				null,
			]);
			const versions = await history(client, node.id).then((vs) => vs.filter((v) => v.current));
			expect(versions).toHaveLength(2);
			expect(Number(versions[0]!.valid_to)).toBe(Number(versions[1]!.valid_from));
			expect(Number(versions[0]!.valid_from)).toBeLessThan(Number(versions[0]!.valid_to));
			expect(
				await graph.getNodeVersion(node.id, { asOf: Number(versions[0]!.valid_from) }),
			).toEqual({ ...before, revision: String(versions[0]!.ver) });
			const carried = await graph.atomic((scope) =>
				scope.updateNode(node.id, { data: { extra: 'new' } }, { expectedRevision: after.revision }),
			);
			expect(carried.data).toEqual({ path: 'B.md', extra: 'new' });
			expect(carried.body).toBeNull();
		});

		test('stale and missing revisions fail with a typed conflict and no changes', async () => {
			const { graph, client } = await setup();
			const created = await graph.addNode({ type: 'note', data: { path: 'A.md' }, body: 'before' });
			const before = (await graph.getNodeVersion(created.id))!;
			const winner = await graph.atomic((scope) =>
				scope.updateNode(created.id, { body: 'winner' }, { expectedRevision: before.revision }),
			);
			for (const id of [created.id, 'missing']) {
				let conflict: unknown;
				try {
					await graph.atomic((scope) =>
						scope.updateNode(id, { body: 'loser' }, { expectedRevision: before.revision }),
					);
				} catch (error) {
					conflict = error;
				}
				expect(conflict).toMatchObject({
					name: 'RevisionConflict',
					id,
					expectedRevision: before.revision,
					actualRevision: id === created.id ? winner.revision : null,
				});
			}
			expect(await graph.getNodeVersion(created.id)).toEqual(winner);
			expect((await history(client, created.id)).filter((v) => v.current)).toHaveLength(2);
		});

		test('scope validates updated schemas and caught validation or SQL failures poison the transaction', async () => {
			const { graph, events } = await setup();
			for (const fail of ['schema', 'unique']) {
				await expect(
					graph.atomic(async (scope) => {
						const a = await scope.addNode({ type: 'note', data: { path: 'A.md' } });
						try {
							if (fail === 'schema')
								await scope.updateNode(
									a.id,
									{ data: { path: 42 } },
									{ expectedRevision: a.revision },
								);
							else await scope.addNode({ type: 'note', data: { path: 'A.md' } });
						} catch {
							/* Caller cannot turn a failed operation into partial success. */
						}
					}),
				).rejects.toThrow();
				expect((await graph.listNodes()).nodes).toEqual([]);
				expect(events.events).toEqual([]);
			}
		});

		test('scoped listings and edge changes read their own uncommitted state', async () => {
			const { graph } = await setup();
			await graph.atomic(async (scope) => {
				const a = await scope.addNode({ type: 'note', data: { path: 'A.md' } });
				const b = await scope.addNode({ type: 'note', data: { path: 'B.md' } });
				const c = await scope.addNode({ type: 'note', data: { path: 'C.md' } });
				const edge = await scope.addEdge({ rel: 'links', src: a.id, dst: b.id });
				await scope.addEdge({ rel: 'parent', src: a.id, dst: b.id });
				await scope.addEdge({ rel: 'parent', src: a.id, dst: c.id });
				expect((await scope.listNodes({ limit: 2 })).nodes).toHaveLength(2);
				expect((await scope.graphSlice()).links).toHaveLength(2);
				await scope.deleteEdge(edge.id);
				expect((await scope.graphSlice()).links).toHaveLength(1);
			});
			expect((await graph.graphSlice()).links).toHaveLength(1);
		});

		test('purge removes all histories, incident edges and FTS while GC preserves shared references', async () => {
			const { graph, client } = await setup();
			const { a, b, oldBlob, newBlob } = await graph.atomic(async (scope) => {
				const oldBlob = await scope.blobs.put(new Uint8Array([1]));
				const newBlob = await scope.blobs.put(new Uint8Array([2]));
				let a = await scope.addNode({
					type: 'note',
					data: { path: 'A.md' },
					body: 'ancientword',
					content_hash: oldBlob.hash,
				});
				const b = await scope.addNode({
					type: 'note',
					data: { path: 'B.md' },
					body: 'survivorword',
					content_hash: oldBlob.hash,
				});
				await scope.addEdge({ rel: 'links', src: b.id, dst: a.id });
				await scope.addEdge({ rel: 'parent', src: a.id, dst: b.id });
				a = await scope.updateNode(
					a.id,
					{ body: 'currentword', content_hash: newBlob.hash },
					{ expectedRevision: a.revision },
				);
				return { a, b, oldBlob, newBlob };
			});
			await expect(
				graph.atomic((scope) => scope.purgeNode(a.id, { expectedRevision: 'stale' })),
			).rejects.toMatchObject({ name: 'RevisionConflict' });
			await graph.atomic(async (scope) => {
				await scope.purgeNode(a.id, { expectedRevision: a.revision });
				expect(await scope.blobs.gc()).toBe(1);
				expect(await scope.blobs.get(newBlob.uri)).toBeNull();
				expect(await scope.blobs.get(oldBlob.uri)).toEqual(new Uint8Array([1]));
			});
			expect(await graph.getNodeVersion(a.id)).toBeNull();
			expect(await history(client, a.id)).toEqual([]);
			for (const table of ['edge_versions', 'edge_identity'])
				expect((await client.execute(`SELECT * FROM ${table}`)).rows).toEqual([]);
			expect((await client.execute('SELECT id FROM node_identity')).rows.map((r) => r.id)).toEqual([
				b.id,
			]);
			// A later version may reuse the deleted SQLite rowid; stale FTS postings
			// must not make the new content match words from the purged document.
			await graph.addNode({ type: 'note', data: { path: 'C.md' }, body: 'replacementword' });
			for (const q of ['ancientword', 'currentword'])
				expect((await graph.listNodes({ q })).nodes).toEqual([]);
			expect((await graph.listNodes({ q: 'survivorword' })).nodes.map((n) => n.id)).toEqual([b.id]);
		});

		test('purge and GC roll back together when the callback fails', async () => {
			const { graph, client, events } = await setup();
			const { node, blob } = await graph.atomic(async (scope) => {
				const blob = await scope.blobs.put(new Uint8Array([3]));
				return {
					blob,
					node: await scope.addNode({
						type: 'note',
						data: { path: 'A.md' },
						body: 'retainedword',
						content_hash: blob.hash,
					}),
				};
			});
			const beforeEvents = events.events.length;
			await expect(
				graph.atomic(async (scope) => {
					await scope.purgeNode(node.id, { expectedRevision: node.revision });
					await scope.blobs.gc();
					throw new Error('cancel purge');
				}),
			).rejects.toThrow('cancel purge');
			expect(await graph.getNodeVersion(node.id)).toEqual(node);
			expect((await graph.listNodes({ q: 'retainedword' })).nodes.map((n) => n.id)).toEqual([
				node.id,
			]);
			expect(await (await createLocalBlobStore(client)).get(blob.uri)).toEqual(new Uint8Array([3]));
			expect(events.events).toHaveLength(beforeEvents);
		});

		test('escaped operations reject after commit and rollback, including bound blobs', async () => {
			const { graph } = await setup();
			for (const abort of [false, true]) {
				let escaped!: AtomicGraph<typeof schema>;
				try {
					await graph.atomic(async (scope) => {
						escaped = scope;
						if (abort) throw new Error('abort');
					});
				} catch {
					/* expected abort */
				}
				await expect(escaped.getNodeVersion('missing')).rejects.toThrow('closed');
				await expect(escaped.addNode({ type: 'note', data: { path: 'late.md' } })).rejects.toThrow(
					'closed',
				);
				await expect(escaped.blobs.put(new Uint8Array([1]))).rejects.toThrow('closed');
				await expect(escaped.blobs.gc()).rejects.toThrow('closed');
			}
			expect((await graph.listNodes()).nodes).toEqual([]);
		});

		test('serializes queued operations and drains unawaited writes before commit', async () => {
			const { graph } = await setup();
			await graph.atomic(async (scope) => {
				const a = await scope.addNode({ type: 'note', data: { path: 'A.md' } });
				const copy = new Uint8Array([0, 255]);
				const putting = scope.blobs.put(copy);
				copy.fill(8);
				const ref = await putting;
				expect(await scope.blobs.get(ref.uri)).toEqual(new Uint8Array([0, 255]));
				void scope.updateNode(a.id, { body: 'drained' }, { expectedRevision: a.revision });
			});
			const node = (await graph.listNodes()).nodes[0]!;
			expect((await graph.getNodeVersion(node.id))?.body).toBe('drained');
		});

		test('rejects configured or stored embeddings before opening a transaction', async () => {
			const { client } = await setup();
			let acquisitions = 0;
			const tagged: DbClient = {
				dialect: client.dialect,
				execute: (stmt) => client.execute(stmt),
				batch: (stmts, mode) => client.batch(stmts, mode),
				executeMultiple: (sql) => client.executeMultiple(sql),
				close: () => client.close(),
				transaction: async (mode) => {
					acquisitions++;
					return client.transaction(mode);
				},
			};
			const embedder = hashEmbed(4);
			let callbacks = 0;
			await expect(
				new Graph(tagged, schema, { embedder }).atomic(async () => {
					callbacks++;
				}),
			).rejects.toThrow('embeddings');
			await init(client, embedder);
			await expect(
				new Graph(tagged, schema).atomic(async () => {
					callbacks++;
				}),
			).rejects.toThrow('embeddings');
			expect(acquisitions).toBe(0);
			expect(callbacks).toBe(0);
		});

		test('concurrent clients accept exactly one save of a revision without replaying callbacks', async () => {
			const { graph, client, sibling } = await setup();
			const otherClient = sibling!();
			await init(otherClient);
			const other = new Graph(otherClient, schema);
			// Fail fast on native synchronous lock contention so the other callback
			// can finish; exercise Graph's asynchronous acquisition retry envelope.
			await client.execute('PRAGMA busy_timeout = 0');
			await otherClient.execute('PRAGMA busy_timeout = 0');
			const node = await graph.addNode({ type: 'note', data: { path: 'A.md' } });
			const version = (await graph.getNodeVersion(node.id))!;
			let callbacks = 0;
			const save = (g: Graph<typeof schema>, body: string) =>
				g.atomic(async (scope) => {
					callbacks++;
					return scope.updateNode(node.id, { body }, { expectedRevision: version.revision });
				});
			const results = await Promise.allSettled([save(graph, 'first'), save(other, 'second')]);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			expect(results.find((r) => r.status === 'rejected')).toMatchObject({
				reason: { name: 'RevisionConflict' },
			});
			expect(callbacks).toBe(2);
			expect((await history(client, node.id)).filter((v) => v.current)).toHaveLength(2);
		});

		test('commit failure rolls back all writes, emits nothing, and never replays the callback', async () => {
			const { client } = await setup();
			const events = new InMemoryEvents();
			const failing: DbClient = {
				dialect: client.dialect,
				execute: (stmt) => client.execute(stmt),
				batch: (stmts, mode) => client.batch(stmts, mode),
				executeMultiple: (sql) => client.executeMultiple(sql),
				close: () => client.close(),
				async transaction(mode) {
					const tx = await client.transaction(mode);
					return {
						get closed() {
							return tx.closed;
						},
						execute: (stmt) => tx.execute(stmt),
						rollback: () => tx.rollback(),
						async commit() {
							throw Object.assign(new Error('simulated commit failure'), { code: 'SQLITE_BUSY' });
						},
					};
				},
			};
			const graph = new Graph(failing, schema, { events: { sink: events, outbox: true } });
			let callbacks = 0;
			await expect(
				graph.atomic(async (scope) => {
					callbacks++;
					await scope.addNode({ type: 'note', data: { path: 'failed.md' } });
					await scope.blobs.put(new Uint8Array([1]));
				}),
			).rejects.toThrow('simulated commit failure');
			expect(callbacks).toBe(1);
			expect(events.events).toEqual([]);
			expect((await client.execute('SELECT * FROM node_versions')).rows).toEqual([]);
			expect((await client.execute('SELECT * FROM graphx_blobs')).rows).toEqual([]);
			expect((await outboxTail(client)).events).toEqual([]);
			await client.execute("INSERT INTO node_identity (id) VALUES ('connection-released')");
		});

		test('throwing sinks cannot reject committed writes and see committed state', async () => {
			const { client } = await setup();
			const observed: Promise<unknown>[] = [];
			const graph = new Graph(client, schema, {
				events: {
					outbox: true,
					sink: {
						emit(event) {
							observed.push(graph.getNodeVersion(event.id));
							throw new Error('listener failed');
						},
					},
				},
			});
			const node = await graph.atomic((scope) =>
				scope.addNode({ type: 'note', data: { path: 'A.md' } }),
			);
			expect(await Promise.all(observed)).toEqual([node]);
			expect((await outboxTail(client)).events).toHaveLength(1);
		});

		test('root endpoint caches invalidate only after committed type changes', async () => {
			const { graph } = await setup();
			const a = await graph.addNode({ type: 'note', data: { path: 'A.md' } });
			const b = await graph.addNode({ type: 'note', data: { path: 'B.md' } });
			const before = (await graph.getNodeVersion(a.id))!;
			await expect(
				graph.atomic(async (scope) => {
					await scope.updateNode(
						a.id,
						{ type: 'other', data: { title: 'other' } },
						{ expectedRevision: before.revision, replaceData: true },
					);
					throw new Error('abort');
				}),
			).rejects.toThrow('abort');
			await graph.addEdge({ rel: 'links', src: a.id, dst: b.id });
			await graph.atomic((scope) =>
				scope.updateNode(
					a.id,
					{ type: 'other', data: { title: 'other' } },
					{ expectedRevision: before.revision, replaceData: true },
				),
			);
			await expect(graph.addEdge({ rel: 'links', src: a.id, dst: b.id })).rejects.toThrow('type');
		});

		test('rechecks embedding configuration under the acquired lease before invoking the callback', async () => {
			const { client } = await setup();
			const racing: DbClient = {
				dialect: client.dialect,
				execute: (stmt) => client.execute(stmt),
				batch: (stmts, mode) => client.batch(stmts, mode),
				executeMultiple: (sql) => client.executeMultiple(sql),
				close: () => client.close(),
				async transaction(mode) {
					await init(client, hashEmbed(4));
					return client.transaction(mode);
				},
			};
			let callbacks = 0;
			await expect(
				new Graph(racing, schema).atomic(async () => {
					callbacks++;
				}),
			).rejects.toThrow('embeddings');
			expect(callbacks).toBe(0);
			await client.execute("INSERT INTO node_identity (id) VALUES ('lease-released')");
		});

		test('outgoing reconciliation can select exact provenance without closing other writers edges', async () => {
			const { graph } = await setup();
			await graph.atomic(async (scope) => {
				const a = await scope.addNode({ type: 'note', data: { path: 'A.md' } });
				const b = await scope.addNode({ type: 'note', data: { path: 'B.md' } });
				await scope.addEdge({ rel: 'links', src: a.id, dst: b.id, source: 'peachy:wikilinks' });
				const foreign = await scope.addEdge({
					rel: 'links',
					src: a.id,
					dst: b.id,
					source: 'import',
				});
				const own = await scope.listEdges({ src: a.id, rel: 'links', source: 'peachy:wikilinks' });
				expect(own).toHaveLength(1);
				await scope.deleteEdge(own[0]!.id);
				expect(await scope.listEdges({ dst: b.id })).toEqual([{ ...foreign, source: 'import' }]);
			});
		});

		test('a caught rename collision restores its predecessor and rolls back staged attachments', async () => {
			const { graph, client } = await setup();
			const a = await graph.addNode({ type: 'note', data: { path: 'A.md' }, body: 'original' });
			await graph.addNode({ type: 'note', data: { path: 'B.md' } });
			const before = (await graph.getNodeVersion(a.id))!;
			await expect(
				graph.atomic(async (scope) => {
					const blob = await scope.blobs.put(new Uint8Array([1]));
					try {
						await scope.updateNode(
							a.id,
							{ data: { path: 'B.md' }, body: 'changed', content_hash: blob.hash },
							{ expectedRevision: before.revision },
						);
					} catch {
						/* A failed insert follows the predecessor close. */
					}
				}),
			).rejects.toThrow();
			expect(await graph.getNodeVersion(a.id)).toEqual(before);
			expect((await history(client, a.id)).filter((v) => v.current)).toHaveLength(1);
			expect((await client.execute('SELECT * FROM graphx_blobs')).rows).toEqual([]);
		});

		test('a caught detached attachment input aborts earlier graph writes', async () => {
			const { graph } = await setup();
			const detached = new Uint8Array([1, 2]);
			structuredClone(detached.buffer, { transfer: [detached.buffer] });
			await expect(
				graph.atomic(async (scope) => {
					await scope.addNode({ type: 'note', data: { path: 'A.md' } });
					try {
						await scope.blobs.put(detached);
					} catch {
						/* Poison even when copying fails before I/O. */
					}
				}),
			).rejects.toThrow();
			expect((await graph.listNodes()).nodes).toEqual([]);
		});

		test('purges analyzed nodes without removing surviving nodes analytics', async () => {
			const { graph, client } = await setup();
			const a = await graph.addNode({ type: 'note', data: { path: 'A.md' } });
			const b = await graph.addNode({ type: 'note', data: { path: 'B.md' } });
			await graph.addEdge({ rel: 'links', src: a.id, dst: b.id });
			await pagerank(client);
			const survivor = (
				await client.execute({ sql: 'SELECT * FROM node_analytics WHERE id = ?', args: [b.id] })
			).rows;
			const version = (await graph.getNodeVersion(a.id))!;
			await graph.atomic((scope) => scope.purgeNode(a.id, { expectedRevision: version.revision }));
			expect(await graph.getNodeVersion(a.id)).toBeNull();
			expect((await client.execute('SELECT * FROM node_analytics')).rows).toEqual(survivor);
		});

		for (const reader of ['getNode', 'getNodeVersion'] as const) {
			test(`${reader} historical reads cannot replace the cached live endpoint type`, async () => {
				const { graph, client } = await setup();
				const a = await graph.addNode({ type: 'note', data: { path: 'A.md' } });
				const b = await graph.addNode({ type: 'note', data: { path: 'B.md' } });
				const before = (await graph.getNodeVersion(a.id))!;
				await graph.atomic((scope) =>
					scope.updateNode(
						a.id,
						{ type: 'other', data: { title: 'changed' } },
						{ expectedRevision: before.revision, replaceData: true },
					),
				);
				const versions = await history(client, a.id).then((vs) => vs.filter((v) => v.current));
				expect((await graph[reader](a.id, { asOf: Number(versions[0]!.valid_from) }))?.type).toBe(
					'note',
				);
				await expect(graph.addEdge({ rel: 'links', src: a.id, dst: b.id })).rejects.toThrow('type');
				expect((await graph.graphSlice()).links).toEqual([]);
			});
		}

		test('historical listings and traversals cannot poison live endpoint validation', async () => {
			const { graph, client } = await setup();
			const a = await graph.addNode({ type: 'note', data: { path: 'A.md' } });
			const b = await graph.addNode({ type: 'note', data: { path: 'B.md' } });
			await graph.addEdge({ rel: 'links', src: b.id, dst: a.id });
			const before = (await graph.getNodeVersion(a.id))!;
			await graph.atomic((scope) =>
				scope.updateNode(
					a.id,
					{ type: 'other', data: { title: 'changed' } },
					{ expectedRevision: before.revision, replaceData: true },
				),
			);
			const asOf = Number((await history(client, a.id)).filter((v) => v.current)[0]!.valid_to) - 1;
			const assertLiveType = () =>
				expect(graph.addEdge({ rel: 'links', src: a.id, dst: b.id })).rejects.toThrow('type');
			expect((await graph.listNodes({ asOf, type: 'note' })).nodes.map((n) => n.id)).toContain(
				a.id,
			);
			await assertLiveType();
			expect((await graph.neighbors(b.id, { asOf }))[0]?.type).toBe('note');
			await assertLiveType();
			expect((await graph.neighborsPage(b.id, { asOf, limit: 1 })).rows[0]?.type).toBe('note');
			await assertLiveType();
			await expect(
				graph.atomic(async (scope) => {
					expect((await scope.listNodes({ asOf, type: 'note' })).nodes.map((n) => n.id)).toContain(
						a.id,
					);
					await scope.addEdge({ rel: 'links', src: a.id, dst: b.id });
				}),
			).rejects.toThrow('type');
		});

		test('keeps the monotonic clock across standalone and atomic writes in the same millisecond', async () => {
			const { graph, client } = await setup();
			const clock = spyOn(Date, 'now').mockReturnValue(5000);
			try {
				await graph.addNode({ type: 'note', data: { path: 'A.md' } });
				await graph.addNode({ type: 'note', data: { path: 'B.md' } });
				await graph.atomic(async (scope) => {
					await scope.addNode({ type: 'note', data: { path: 'C.md' } });
					await scope.addNode({ type: 'note', data: { path: 'D.md' } });
				});
				await graph.addNode({ type: 'note', data: { path: 'E.md' } });
				expect(
					(await client.execute('SELECT valid_from FROM node_versions ORDER BY ver')).rows.map(
						(row) => Number(row.valid_from),
					),
				).toEqual([5000, 5001, 5002, 5003, 5004]);
			} finally {
				clock.mockRestore();
			}
		});

		test('rolls back analytics cleanup with an aborted purge', async () => {
			const { graph, client } = await setup();
			const node = await graph.addNode({
				type: 'note',
				data: { path: 'A.md' },
				body: 'analyzedword',
			});
			await pagerank(client);
			const analytics = (await client.execute('SELECT * FROM node_analytics')).rows;
			const before = (await graph.getNodeVersion(node.id))!;
			await expect(
				graph.atomic(async (scope) => {
					await scope.purgeNode(node.id, { expectedRevision: before.revision });
					throw new Error('abort analyzed purge');
				}),
			).rejects.toThrow('abort analyzed purge');
			expect(await graph.getNodeVersion(node.id)).toEqual(before);
			expect((await client.execute('SELECT * FROM node_analytics')).rows).toEqual(analytics);
			expect((await graph.listNodes({ q: 'analyzedword' })).nodes.map((n) => n.id)).toEqual([
				node.id,
			]);
		});
	});
}
