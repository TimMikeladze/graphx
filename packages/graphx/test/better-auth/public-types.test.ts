import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('published Better Auth types retain additional plugins, fields, and preset endpoints', () => {
	const result = Bun.spawnSync(
		['bun', 'x', 'tsc', '--noEmit', '-p', resolve(import.meta.dir, 'tsconfig.json')],
		{ cwd: resolve(import.meta.dir, '../../../..') },
	);
	expect(`${result.stdout.toString()}${result.stderr.toString()}`.trim()).toBe('');
	expect(result.exitCode).toBe(0);
}, 30_000);
