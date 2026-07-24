import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DEFAULT_INCLUDE, discover } from '../src/discover.ts';

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'gx-discover-'));
	await mkdir(join(dir, 'notes'), { recursive: true });
	await writeFile(join(dir, 'a.md'), 'a');
	await writeFile(join(dir, 'notes', 'b.markdown'), 'b');
	await writeFile(join(dir, 'notes', 'c.yaml'), 'c');
	await writeFile(join(dir, 'notes', 'd.yml'), 'd');
	await writeFile(join(dir, 'ignore.txt'), 'nope');
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

test('discover: returns sorted POSIX keys for included extensions only', async () => {
	expect(await discover(dir, DEFAULT_INCLUDE)).toEqual([
		'a.md',
		'notes/b.markdown',
		'notes/c.yaml',
		'notes/d.yml',
	]);
});

test('discover: dot-directories are skipped (Obsidian .trash / .obsidian)', async () => {
	const d = await mkdtemp(join(tmpdir(), 'gx-dotdir-'));
	await mkdir(join(d, '.trash'), { recursive: true });
	await mkdir(join(d, '.obsidian', 'plugins'), { recursive: true });
	await mkdir(join(d, 'note'), { recursive: true });
	await writeFile(join(d, '.trash', 'deleted.md'), 'deleted');
	await writeFile(join(d, '.obsidian', 'plugins', 'readme.md'), 'plugin');
	await writeFile(join(d, 'note', 'keep.md'), 'keep');
	expect(await discover(d, DEFAULT_INCLUDE)).toEqual(['note/keep.md']);
	await rm(d, { recursive: true, force: true });
});

test('discover: a dot-FILE is skipped too, but a dotted extension is not', async () => {
	const d = await mkdtemp(join(tmpdir(), 'gx-dotfile-'));
	await writeFile(join(d, '.hidden.md'), 'hidden');
	await writeFile(join(d, 'diagram.excalidraw.md'), 'multi-dot but visible');
	expect(await discover(d, DEFAULT_INCLUDE)).toEqual(['diagram.excalidraw.md']);
	await rm(d, { recursive: true, force: true });
});
