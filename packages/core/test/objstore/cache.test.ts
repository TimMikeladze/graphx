import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { contentKey, FileCache } from '../../src/objstore/cache.ts';
import { MemoryObjectStore } from '../../src/objstore/memory.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-cache-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const enc = (s: string) => new TextEncoder().encode(s);

describe('FileCache', () => {
	test('contentKey is stable and content-derived', () => {
		expect(contentKey(enc('abc'))).toBe(contentKey(enc('abc')));
		expect(contentKey(enc('abc'))).not.toBe(contentKey(enc('abd')));
		expect(contentKey(enc('abc'))).toMatch(/^data\/[0-9a-f]{64}\.parquet$/);
	});

	test('putContent uploads under the content key and returns it', async () => {
		const store = new MemoryObjectStore();
		const cache = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const key = await cache.putContent(enc('payload'));
		expect(key).toBe(contentKey(enc('payload')));
		expect(await store.get(key)).not.toBeNull();
	});

	test('putContent is idempotent for identical bytes', async () => {
		const store = new MemoryObjectStore();
		const cache = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const a = await cache.putContent(enc('same'));
		const b = await cache.putContent(enc('same'));
		expect(a).toBe(b);
		expect(await store.list('data/')).toHaveLength(1);
	});

	test('a writer can read back what it wrote without touching the store', async () => {
		// putContent populates the local cache too — the bytes are already in hand, and
		// re-downloading your own upload is pure waste. The store write happens first, so
		// nothing uncommitted is ever cached.
		const store = new MemoryObjectStore();
		const cache = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const key = await cache.putContent(enc('body'));
		expect(await cache.has(key)).toBe(true);
		await store.delete(key);
		expect(readFileSync(await cache.ensure(key), 'utf8')).toBe('body');
	});

	test('a reader downloads once and serves from disk afterward', async () => {
		// The download path as it actually occurs: a process with its own cache directory
		// that did not write the object.
		const store = new MemoryObjectStore();
		const writer = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const key = await writer.putContent(enc('body'));

		const reader = new FileCache(store, mkdtempSync(join(root, 'c-')));
		expect(await reader.has(key)).toBe(false);

		const path = await reader.ensure(key);
		expect(readFileSync(path, 'utf8')).toBe('body');
		expect(await reader.has(key)).toBe(true);

		// Delete from the store; a cached file must still resolve, because content-addressed
		// objects never change and so never need revalidation.
		await store.delete(key);
		expect(await reader.ensure(key)).toBe(path);
	});

	test('resolve fetches whatever is missing and preserves input order', async () => {
		const store = new MemoryObjectStore();
		const writer = new FileCache(store, mkdtempSync(join(root, 'c-')));
		const a = await writer.putContent(enc('one'));
		const b = await writer.putContent(enc('two'));

		const reader = new FileCache(store, mkdtempSync(join(root, 'c-')));
		await reader.ensure(a);
		expect(await reader.has(b)).toBe(false);

		const paths = await reader.resolve([b, a]);
		expect(paths).toEqual([reader.localPath(b), reader.localPath(a)]);
		expect(await reader.has(b)).toBe(true);
	});

	test('ensure throws a named error for a key that is in neither place', async () => {
		const cache = new FileCache(new MemoryObjectStore(), mkdtempSync(join(root, 'c-')));
		await expect(cache.ensure('data/deadbeef.parquet')).rejects.toThrow(/not found/);
	});
});
