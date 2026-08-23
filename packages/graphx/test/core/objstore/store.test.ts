import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { FileObjectStore } from '../../../src/core/objstore/file.ts';
import { MemoryObjectStore } from '../../../src/core/objstore/memory.ts';
import { ObjectExistsError, type ObjectStore } from '../../../src/core/objstore/store.ts';

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

// File-store specific tests: these catch defects that don't show up when
// the writer is awaited before the reader. They must run *after* both
// implementations exist, so they're outside the parameterized loop.

describe('FileObjectStore: atomicity & error handling', () => {
	test('a key is never observable half-written', async () => {
		const s = new FileObjectStore(mkdtempSync(join(dir, 'fs-')));
		const big = new Uint8Array(4 * 1024 * 1024).fill(7);
		const writing = s.putIfAbsent('big', big);
		// Race the write: every read must see either nothing or the whole object.
		for (let i = 0; i < 50; i++) {
			const seen = await s.get('big');
			if (seen !== null) expect(seen.length).toBe(big.length);
		}
		await writing;
		expect((await s.get('big'))?.length).toBe(big.length);
	});

	test('get surfaces a real I/O error instead of reporting absence', async () => {
		const root = mkdtempSync(join(dir, 'fs-'));
		const s = new FileObjectStore(root);
		// A directory where an object should be: EISDIR, which is not "absent".
		mkdirSync(join(root, 'collide'), { recursive: true });
		await expect(s.get('collide')).rejects.toThrow();
	});
});
