import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { createDuckClient, type DuckClient } from '../../src/core/duck.ts';
import { Graph } from '../../src/core/graph.ts';
import { MemoryObjectStore } from '../../src/core/objstore/memory.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-fts-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SCHEMA = defineGraphSchema({
	nodes: { Doc: z.object({ slug: z.string().optional() }) },
	edges: {},
});

function client(store: MemoryObjectStore): DuckClient {
	return createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
}

describe('full-text round trip', () => {
	test('a committed index is readable by a second client', async () => {
		const store = new MemoryObjectStore();
		const w = client(store);
		const g = new Graph(w, SCHEMA);
		await g.write(async (s) => {
			await s.addNode({ type: 'Doc', body: 'temporal graph database', data: {} });
			await s.addNode({ type: 'Doc', body: 'vector search engine', data: {} });
		});
		await w.end();

		const r = client(store);
		await r.open();
		const rows = await r.execute({
			sql: `SELECT count(*) AS n FROM fts_terms WHERE term = ?`,
			args: ['graph'],
		});
		expect(rows.rows[0]?.n).toBe(1);
		await r.end();
	});

	test('the manifest splits live and history index files', async () => {
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c, SCHEMA);
		const n = await g.addNode({ type: 'Doc', body: 'original text', data: {} });
		await g.updateNode(n.id, { body: 'replacement text' });
		const m = c.snapshot();
		// The superseded version is history; the successor is live. Both are indexed.
		expect(m?.indexes.fts_live?.fts_docs?.length).toBe(1);
		expect(m?.indexes.fts_history?.fts_docs?.length).toBe(1);
		expect(m?.indexes.fts_global?.fts_dict?.length).toBe(1);
		await c.end();
	});

	test('the index tracks an update — the old body stops matching live', async () => {
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c, SCHEMA);
		const n = await g.addNode({ type: 'Doc', body: 'sphinx', data: {} });
		await g.updateNode(n.id, { body: 'griffin' });
		const live = await c.execute({
			sql: `SELECT term FROM fts_terms WHERE live AND term IN ('sphinx','griffin')`,
		});
		expect(live.rows.map((r) => String(r.term))).toEqual(['griffin']);
		// ...but history still carries it, which is what makes as-of lexical search exact.
		const all = await c.execute({
			sql: `SELECT count(*) AS n FROM fts_terms WHERE term = 'sphinx'`,
		});
		expect(all.rows[0]?.n).toBe(1);
		await c.end();
	});

	test('a commit that does not touch node_versions leaves the index files alone', async () => {
		// `dirty` is the CALLER's assertion about what changed, and the index deliberately
		// follows it rather than re-deriving it from the database — that contract is what
		// makes an incremental commit cheap. To prove the gate actually consults `dirty`
		// (rather than, say, always rebuilding into byte-identical content-addressed files, or
		// always carrying forward), this test mutates `node_versions` directly with raw SQL —
		// bypassing the write path that would normally mark it dirty — then commits while
		// naming only `archival_state` as dirty. A real rebuild would see the new body and
		// mint different keys; the old keys surviving is what proves the commit trusted the
		// (deliberately wrong) dirty set instead of reinspecting the table itself.
		const store = new MemoryObjectStore();
		const c = client(store);
		const g = new Graph(c, SCHEMA);
		await g.addNode({ type: 'Doc', body: 'original words here', data: {} });
		const first = c.snapshot();
		// Otherwise the rest of this test proves nothing.
		expect(first?.indexes.fts_global?.fts_dict?.length ?? 0).toBeGreaterThan(0);

		await c.execute({ sql: `UPDATE node_versions SET body = 'entirely different words'` });
		await c.execute({
			sql: 'INSERT INTO archival_state VALUES (?,?,?)',
			args: ['node_versions', 1, 1],
		});
		const second = await c.commit(new Set(['archival_state']));
		// Rebuilding an index nobody invalidated would make every commit cost the whole corpus.
		expect(second.indexes).toEqual(first?.indexes);
		await c.end();
	});

	test('an empty corpus commits an index with no files rather than empty ones', async () => {
		const store = new MemoryObjectStore();
		const c = client(store);
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		const m = await c.commit(new Set(['node_versions']));
		expect(m.indexes.fts_live?.fts_docs ?? []).toEqual([]);
		await c.end();
	});
});
