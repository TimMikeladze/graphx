import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { fsSource } from '../src/source.ts';

async function tmpVault(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'gx-source-'));
	for (const [name, body] of Object.entries(files)) {
		await writeFile(join(dir, name), body);
	}
	return dir;
}

test('fsSource: list() returns sorted POSIX keys', async () => {
	const dir = await tmpVault({
		'z.md': 'Z',
		'a.md': 'A',
		'b.yaml': 'B',
	});
	const src = fsSource(dir);
	const keys = await src.list();
	expect(keys).toEqual(['a.md', 'b.yaml', 'z.md']);
	await rm(dir, { recursive: true, force: true });
});

test('fsSource: read() returns UTF-8 contents of a key', async () => {
	const dir = await tmpVault({ 'hello.md': 'hello world' });
	const src = fsSource(dir);
	const content = await src.read('hello.md');
	expect(content).toBe('hello world');
	await rm(dir, { recursive: true, force: true });
});

test('fsSource: list() respects include filter', async () => {
	const dir = await tmpVault({ 'a.md': 'A', 'b.txt': 'B', 'c.yaml': 'C' });
	const src = fsSource(dir, ['.md']);
	const keys = await src.list();
	expect(keys).toEqual(['a.md']);
	await rm(dir, { recursive: true, force: true });
});
