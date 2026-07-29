import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { FileObjectStore } from '../../src/objstore/file.ts';
import { MemoryObjectStore } from '../../src/objstore/memory.ts';
import { ObjectExistsError, type ObjectStore } from '../../src/objstore/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'graphx-objstore-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const stores: Array<[string, () => ObjectStore]> = [
	['memory', () => new MemoryObjectStore()],
	['file', () => new FileObjectStore(mkdtempSync(join(dir, 'fs-')))],
];

for (const [name, make] of stores) {
	describe(`ObjectStore: ${name}`, () => {
		test('get returns null for a missing key', async () => {
			expect(await make().get('nope')).toBeNull();
		});

		test('put then get round-trips bytes', async () => {
			const s = make();
			await s.put('a/b.txt', enc('hello'));
			expect(dec((await s.get('a/b.txt')) as Uint8Array)).toBe('hello');
		});

		test('putIfAbsent succeeds on a new key', async () => {
			const s = make();
			await s.putIfAbsent('k', enc('one'));
			expect(dec((await s.get('k')) as Uint8Array)).toBe('one');
		});

		test('putIfAbsent on a taken key throws ObjectExistsError and does not overwrite', async () => {
			const s = make();
			await s.putIfAbsent('k', enc('one'));
			await expect(s.putIfAbsent('k', enc('two'))).rejects.toBeInstanceOf(ObjectExistsError);
			expect(dec((await s.get('k')) as Uint8Array)).toBe('one');
		});

		test('exactly one of N concurrent putIfAbsent calls wins', async () => {
			const s = make();
			const results = await Promise.allSettled(
				Array.from({ length: 12 }, (_, i) => s.putIfAbsent('race', enc(String(i)))),
			);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			for (const r of results.filter((r) => r.status === 'rejected')) {
				expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ObjectExistsError);
			}
		});

		test('list returns keys under a prefix, sorted', async () => {
			const s = make();
			await s.put('snapshots/2', enc('b'));
			await s.put('snapshots/1', enc('a'));
			await s.put('data/x', enc('c'));
			expect(await s.list('snapshots/')).toEqual(['snapshots/1', 'snapshots/2']);
		});

		test('getIfChanged returns "unchanged" for a matching etag', async () => {
			const s = make();
			await s.put('m', enc('v1'));
			const first = await s.getIfChanged('m');
			if (first === null || first === 'unchanged') throw new Error('expected a body');
			expect(await s.getIfChanged('m', first.etag)).toBe('unchanged');
			await s.put('m', enc('v2'));
			const second = await s.getIfChanged('m', first.etag);
			if (second === null || second === 'unchanged') throw new Error('expected a new body');
			expect(dec(second.body)).toBe('v2');
		});

		test('delete removes a key', async () => {
			const s = make();
			await s.put('gone', enc('x'));
			await s.delete('gone');
			expect(await s.get('gone')).toBeNull();
		});
	});
}
