/**
 * Preloaded by `bun test` (see bunfig.toml). libSQL opens a bare namespace as `<name>.db` in the
 * process cwd, so tests that pass `db: 'ns_…'` leave files wherever the suite was started. Once
 * the run ends, delete the scratch databases THIS run created — files older than the run belong
 * to someone else (a dev server, a concurrent suite) and are left alone.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll } from 'bun:test';
import { isScratch } from './scratch-db.ts';

const startedAt = Date.now();

afterAll(() => {
	const dir = process.cwd();
	for (const name of readdirSync(dir)) {
		if (!isScratch(name)) continue;
		const path = join(dir, name);
		try {
			if (statSync(path).birthtimeMs >= startedAt) rmSync(path, { force: true, recursive: true });
		} catch {
			// Removed concurrently — nothing to do.
		}
	}
});
