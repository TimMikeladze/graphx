import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { createDuckClient, type DuckClient } from '../../src/core/duck.ts';
import { Graph } from '../../src/core/graph.ts';
import { MemoryObjectStore } from '../../src/core/objstore/memory.ts';
import { SnapshotStore } from '../../src/core/objstore/snapshot.ts';
import type { ObjectStore } from '../../src/core/objstore/store.ts';

/**
 * The stage-4 round trip: a `Graph` whose durable state is a snapshot chain in an object
 * store, with no local file of record.
 *
 * Set `GRAPHX_TEST_S3_ENDPOINT` to run every case against a real S3-compatible store
 * (MinIO) instead of the in-memory one. That is the only configuration that exercises the
 * genuine create-if-absent CAS the commit protocol is built on.
 */

const root = mkdtempSync(join(tmpdir(), 'graphx-e2e-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SCHEMA = defineGraphSchema({
	nodes: { Doc: z.object({ slug: z.string().optional(), v: z.number().optional() }) },
	edges: { links: { from: 'Doc', to: 'Doc' } },
});

const S3_ENDPOINT = process.env.GRAPHX_TEST_S3_ENDPOINT;
const S3_BUCKET = process.env.GRAPHX_TEST_S3_BUCKET ?? 'graphx-test';
let prefixCounter = 0;

/** A fresh, empty store — MinIO when configured, otherwise in-memory. */
async function newStore(): Promise<ObjectStore> {
	if (!S3_ENDPOINT) return new MemoryObjectStore();
	const { S3ObjectStore } = await import('../../src/core/objstore/s3.ts');
	// A unique prefix per store stands in for a fresh bucket.
	return new S3ObjectStore({
		bucket: S3_BUCKET,
		prefix: `e2e/${process.pid}/${prefixCounter++}`,
		region: 'us-east-1',
		endpoint: S3_ENDPOINT,
		forcePathStyle: true,
		credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
	});
}

function client(store: ObjectStore): DuckClient {
	return createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
}

function graph(c: DuckClient): Graph<typeof SCHEMA> {
	return new Graph(c, SCHEMA);
}

describe('duckdb end to end', () => {
	test('a bare mutation commits on its own', async () => {
		const store = await newStore();
		const c = client(store);
		await graph(c).addNode({ type: 'Doc', data: { slug: 'a' } });
		expect(await new SnapshotStore(store).resolveHead()).not.toBeNull();
		await c.end();
	});

	test('a write session commits exactly once', async () => {
		const store = await newStore();
		const c = client(store);
		const g = graph(c);
		await g.write(async (w) => {
			await w.addNode({ type: 'Doc', data: { slug: 'a' } });
			await w.addNode({ type: 'Doc', data: { slug: 'b' } });
			await w.addNode({ type: 'Doc', data: { slug: 'c' } });
		});
		expect((await store.list('snapshots/')).length).toBe(1);
		expect((await new SnapshotStore(store).resolveHead())?.snapshot).toBe(0);
		await c.end();
	});

	test('a write session that throws commits nothing', async () => {
		const store = await newStore();
		const c = client(store);
		const g = graph(c);
		await expect(
			g.write(async (w) => {
				await w.addNode({ type: 'Doc', data: { slug: 'a' } });
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		expect(await new SnapshotStore(store).resolveHead()).toBeNull();
		// The local database is a materialization, so discarding it IS the rollback.
		expect((await c.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('a nested write joins the outer session', async () => {
		const store = await newStore();
		const c = client(store);
		const g = graph(c);
		await g.write(async (w) => {
			await w.addNode({ type: 'Doc', data: { slug: 'a' } });
			await w.write(async (inner) => {
				await inner.addNode({ type: 'Doc', data: { slug: 'b' } });
			});
		});
		expect((await store.list('snapshots/')).length).toBe(1);
		expect((await c.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(2);
		await c.end();
	});

	test('a second reader sees a committed write', async () => {
		const store = await newStore();
		const w = client(store);
		const node = await graph(w).addNode({ type: 'Doc', data: { slug: 'a' } });
		await w.end();

		const r = client(store);
		expect((await graph(r).getNode(node.id))?.id).toBe(node.id);
		await r.end();
	});

	test('an edge and its endpoints survive the round trip', async () => {
		const store = await newStore();
		const w = client(store);
		const gw = graph(w);
		const [a, b] = await gw.write(async (s) => [
			await s.addNode({ type: 'Doc', data: { slug: 'a' } }),
			await s.addNode({ type: 'Doc', data: { slug: 'b' } }),
		]);
		await gw.addEdge({ rel: 'links', src: a.id, dst: b.id });
		await w.end();

		const r = client(store);
		const n = await graph(r).neighbors(a.id);
		expect(n.map((x) => x.id)).toEqual([b.id]);
		await r.end();
	});

	test('an update round-trips as one live version plus its closed history', async () => {
		const store = await newStore();
		const w = client(store);
		const n = await graph(w).addNode({ type: 'Doc', data: { v: 0 } });
		await graph(w).updateNode(n.id, { data: { v: 1 } });
		await w.end();

		const r = client(store);
		expect((await graph(r).getNode(n.id))?.data).toEqual({ v: 1 });
		const rows = await r.execute({
			sql: 'SELECT count(*) AS n FROM node_versions WHERE id = ?',
			args: [n.id],
		});
		expect(rows.rows[0]?.n).toBe(2);
		await r.end();
	});
	test('a reopened namespace keeps allocating vers past the snapshot', async () => {
		const store = await newStore();
		const first = client(store);
		await graph(first).addNode({ type: 'Doc', data: { slug: 'a' } });
		await graph(first).addNode({ type: 'Doc', data: { slug: 'b' } });
		await first.end();
		// a fresh process used to restart seq_ver at 1 and fail on a duplicate key
		const second = client(store);
		await graph(second).addNode({ type: 'Doc', data: { slug: 'c' } });
		const r = await second.execute('SELECT ver FROM node_versions ORDER BY ver');
		expect(r.rows.map((row) => Number(row.ver))).toEqual([1, 2, 3]);
		await second.end();
	});
});
