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
