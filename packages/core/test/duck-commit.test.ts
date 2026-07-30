import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { createDuckClient } from '../src/duck.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';
import { SnapshotStore } from '../src/objstore/snapshot.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-commit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cacheDir(): string {
	return mkdtempSync(join(root, 'c-'));
}

describe('snapshot commit', () => {
	test('a client opened on an empty bucket starts at no snapshot', async () => {
		const store = new MemoryObjectStore();
		const c = createDuckClient({ store, cacheDir: cacheDir() });
		await c.open();
		expect(c.snapshot()).toBeNull();
		await c.end();
	});

	test('committing writes a snapshot that a second client reads back', async () => {
		const store = new MemoryObjectStore();
		const writer = createDuckClient({ store, cacheDir: cacheDir() });
		await writer.open();
		await writer.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await writer.commit(new Set(['node_identity']));
		expect(writer.snapshot()?.snapshot).toBe(0);
		await writer.end();

		const reader = createDuckClient({ store, cacheDir: cacheDir() });
		await reader.open();
		expect((await reader.execute('SELECT id FROM node_identity')).rows).toEqual([{ id: 'n1' }]);
		await reader.end();
	});

	test('two commits chain, and the second sees the first', async () => {
		const store = new MemoryObjectStore();
		const c = createDuckClient({ store, cacheDir: cacheDir() });
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['a'] });
		await c.commit(new Set(['node_identity']));
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['b'] });
		const m = await c.commit(new Set(['node_identity']));
		expect(m.snapshot).toBe(1);
		expect(m.parent).toBe(0);
		expect((await c.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(2);
		await c.end();
	});

	test('an unchanged table reuses its file refs rather than re-uploading', async () => {
		const store = new MemoryObjectStore();
		const c = createDuckClient({ store, cacheDir: cacheDir() });
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['a'] });
		const first = await c.commit(new Set(['node_identity']));
		const objectsAfterFirst = (await store.list('data/')).length;

		await c.execute({
			sql: `INSERT INTO archival_state VALUES (?, ?, ?)`,
			args: ['node_versions', 1, 1],
		});
		const second = await c.commit(new Set(['archival_state']));
		expect(second.tables.node_identity?.files).toEqual(first.tables.node_identity?.files);
		expect((await store.list('data/')).length).toBe(objectsAfterFirst + 1);
		await c.end();
	});

	test('identical content produces the same object key', async () => {
		const store = new MemoryObjectStore();
		const a = createDuckClient({ store, cacheDir: cacheDir() });
		await a.open();
		await a.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['x'] });
		const m1 = await a.commit(new Set(['node_identity']));
		await a.execute({ sql: 'DELETE FROM node_identity WHERE id = ?', args: ['x'] });
		await a.commit(new Set(['node_identity']));
		await a.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['x'] });
		const m3 = await a.commit(new Set(['node_identity']));
		expect(m3.tables.node_identity?.files).toEqual(m1.tables.node_identity?.files);
		await a.end();
	});

	test('the manifest carries the ver and seq high-water marks', async () => {
		const store = new MemoryObjectStore();
		const c = createDuckClient({ store, cacheDir: cacheDir() });
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO node_versions (ver, id, type, valid_from) VALUES (?,?,?,?)`,
			args: [17, 'n1', 'Doc', 1],
		});
		const m = await c.commit(new Set(['node_identity', 'node_versions']));
		expect(m.verHigh).toBe(17);
		await c.end();
	});

	test('node_versions exports live and history as separate files', async () => {
		const store = new MemoryObjectStore();
		const c = createDuckClient({ store, cacheDir: cacheDir() });
		await c.open();
		await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
		await c.execute({
			sql: `INSERT INTO node_versions (ver, id, type, valid_from, valid_to) VALUES (?,?,?,?,?)`,
			args: [1, 'n1', 'Doc', 1, 5],
		});
		await c.execute({
			sql: `INSERT INTO node_versions (ver, id, type, valid_from) VALUES (?,?,?,?)`,
			args: [2, 'n1', 'Doc', 5],
		});
		const m = await c.commit(new Set(['node_identity', 'node_versions']));
		expect(m.tables.node_versions?.files.length).toBe(2);

		// Both halves come back, so the split is a storage layout and nothing else.
		const reader = createDuckClient({ store, cacheDir: cacheDir() });
		await reader.open();
		expect(
			(await reader.execute('SELECT count(*) AS n FROM node_versions')).rows[0]?.n,
		).toBe(2);
		await reader.end();
		await c.end();
	});

	test('a local-only client refuses to commit', async () => {
		const c = createDuckClient();
		await expect(c.commit(new Set(['node_identity']))).rejects.toThrow(/requires a store/);
		await c.end();
	});

	test('a lost race on a table both writers changed fails loudly, not silently', async () => {
		const store = new MemoryObjectStore();
		const a = createDuckClient({ store, cacheDir: cacheDir() });
		const b = createDuckClient({ store, cacheDir: cacheDir() });
		await a.open();
		await b.open();
		await a.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['a'] });
		await b.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['b'] });
		const settled = await Promise.allSettled([
			a.commit(new Set(['node_identity'])),
			b.commit(new Set(['node_identity'])),
		]);
		const won = settled.filter((r) => r.status === 'fulfilled');
		const lost = settled.filter((r) => r.status === 'rejected');
		expect(won.length).toBe(1);
		expect(lost.length).toBe(1);
		expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(/would discard/);

		// The winner's row is intact — the loser did not overwrite it on its way out.
		const head = await new SnapshotStore(store).resolveHead();
		expect(head?.snapshot).toBe(0);
		const reader = createDuckClient({ store, cacheDir: cacheDir() });
		await reader.open();
		expect((await reader.execute('SELECT count(*) AS n FROM node_identity')).rows[0]?.n).toBe(1);
		await reader.end();
		await a.end();
		await b.end();
	});

	test('a lost race on disjoint tables rebases cleanly and both land', async () => {
		const store = new MemoryObjectStore();
		const a = createDuckClient({ store, cacheDir: cacheDir() });
		const b = createDuckClient({ store, cacheDir: cacheDir() });
		await a.open();
		await b.open();
		await a.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['a'] });
		await b.execute({
			sql: 'INSERT INTO archival_state VALUES (?, ?, ?)',
			args: ['node_versions', 1, 1],
		});
		const [ma, mb] = await Promise.all([
			a.commit(new Set(['node_identity'])),
			b.commit(new Set(['archival_state'])),
		]);
		expect([ma.snapshot, mb.snapshot].sort()).toEqual([0, 1]);
		// Whichever rebased carried the winner's table forward rather than dropping it.
		const head = await new SnapshotStore(store).resolveHead();
		expect(head?.tables.node_identity).toBeDefined();
		expect(head?.tables.archival_state).toBeDefined();
		await a.end();
		await b.end();
	});
});
