import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { materialize, SNAPSHOT_TABLES } from '../src/duck-materialize.ts';
import { FileCache } from '../src/objstore/cache.ts';
import { emptyManifest, type Manifest } from '../src/objstore/manifest.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-mat-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function ctx() {
	const store = new MemoryObjectStore();
	return { store, cache: new FileCache(store, mkdtempSync(join(root, 'c-'))) };
}

describe('materialize', () => {
	test('a null manifest produces an empty but complete schema', async () => {
		const { cache } = ctx();
		const c = createDuckClient();
		await materialize(c, null, cache);
		for (const t of SNAPSHOT_TABLES) {
			const r = await c.execute(`SELECT count(*) AS n FROM ${t}`);
			// "Complete" means graph_meta already carries its seeded emb_dim row
			// (duckdbSchema inserts it unconditionally) — every other table starts empty.
			expect(r.rows[0]?.n).toBe(t === 'graph_meta' ? 1 : 0);
		}
		await c.end();
	});

	test('rows written to Parquet come back through materialize', async () => {
		const { cache } = ctx();
		// Produce Parquet files the way the commit path will: write them from DuckDB itself.
		// node_versions.id REFERENCES node_identity(id), so a real snapshot always exports
		// both together — the fixture must too, or the load trips the FK constraint.
		const producer = createDuckClient();
		await producer.execute(`CREATE TABLE ids AS SELECT 'n1' AS id`);
		const idPath = join(root, 'ni.parquet');
		await producer.execute(`COPY ids TO '${idPath}' (FORMAT parquet)`);
		await producer.execute(
			`CREATE TABLE t AS SELECT 'n1' AS id, 'Doc' AS type, 1::BIGINT AS ver,
			 1::BIGINT AS valid_from, 8640000000000000::BIGINT AS valid_to,
			 NULL::TEXT AS body, NULL::TEXT AS uri, NULL::TEXT AS content_hash,
			 NULL::TEXT AS embed_hash, NULL::TEXT AS content_type, '{}' AS data,
			 NULL::FLOAT[] AS emb`,
		);
		const path = join(root, 'nv.parquet');
		await producer.execute(`COPY t TO '${path}' (FORMAT parquet)`);
		await producer.end();

		const idKey = await cache.putContent(new Uint8Array(await Bun.file(idPath).arrayBuffer()));
		const key = await cache.putContent(new Uint8Array(await Bun.file(path).arrayBuffer()));
		const manifest: Manifest = {
			...emptyManifest(4, 'h'),
			tables: { node_identity: { files: [idKey] }, node_versions: { files: [key] } },
		};

		const c = createDuckClient();
		await materialize(c, manifest, cache);
		expect((await c.execute('SELECT count(*) AS n FROM node_versions')).rows[0]?.n).toBe(1);
		expect((await c.execute('SELECT count(*) AS n FROM nodes')).rows[0]?.n).toBe(1);
		await c.end();
	});

	test('materialize is a fresh load, not an append', async () => {
		const { cache } = ctx();
		const c = createDuckClient();
		const manifest = { ...emptyManifest(4, 'h'), tables: {} };
		await materialize(c, manifest, cache);
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['stale'] });
		await materialize(c, manifest, cache);
		expect((await c.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(0);
		await c.end();
	});

	test('a manifest carrying graph_meta does not collide with the seeded row', async () => {
		// duckdbSchema seeds graph_meta with emb_dim, and every real manifest also carries
		// graph_meta because the constraint declarations live there. A plain INSERT throws
		// `Constraint Error: Duplicate key "key: emb_dim"` and breaks the first round-trip.
		const { cache } = ctx();
		const producer = createDuckClient();
		await producer.execute(`CREATE TABLE gm AS SELECT 'emb_dim' AS key, '4' AS value`);
		const path = join(root, 'gm.parquet');
		await producer.execute(`COPY gm TO '${path}' (FORMAT parquet)`);
		await producer.end();
		const key = await cache.putContent(new Uint8Array(await Bun.file(path).arrayBuffer()));

		const c = createDuckClient();
		await materialize(
			c,
			{ ...emptyManifest(4, 'h'), tables: { graph_meta: { files: [key] } } },
			cache,
		);
		expect(
			(await c.execute(`SELECT count(*) AS n FROM graph_meta WHERE key='emb_dim'`)).rows[0]?.n,
		).toBe(1);
		await c.end();
	});

	test('the embedding dimension comes from the manifest', async () => {
		const { cache } = ctx();
		const c = createDuckClient();
		await materialize(c, { ...emptyManifest(384, 'h'), tables: {} }, cache);
		expect((await c.execute(`SELECT value FROM graph_meta WHERE key='emb_dim'`)).rows[0]?.value)
			.toBe('384');
		await c.end();
	});
});
