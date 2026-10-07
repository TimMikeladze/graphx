/**
 * Fetch the latest anime-offline-database release into `data/`.
 *
 *   bun run download.ts [--force]
 *
 * Skips the ~62 MB download when the file already there has the same `lastUpdate` as the latest
 * release. The remote `lastUpdate` sits in the first few hundred bytes of the file, so a 4 KB
 * range request is enough to compare.
 */
import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RELEASE_FILE, RELEASE_URL } from './dataset.ts';

const LAST_UPDATE = /"lastUpdate"\s*:\s*"([^"]+)"/;

/** `lastUpdate` from the head of a release file, or null if it is not in the first `bytes`. */
export function lastUpdateOf(head: string): string | null {
	return LAST_UPDATE.exec(head)?.[1] ?? null;
}

async function remoteLastUpdate(): Promise<string | null> {
	const res = await fetch(RELEASE_URL, { headers: { Range: 'bytes=0-4095' } });
	if (!res.ok) return null;
	// A server that ignores Range sends the whole file; read only the start of it.
	const reader = res.body?.getReader();
	if (!reader) return null;
	let head = '';
	const decoder = new TextDecoder();
	while (head.length < 4096) {
		const { done, value } = await reader.read();
		if (done) break;
		head += decoder.decode(value, { stream: true });
	}
	await reader.cancel();
	return lastUpdateOf(head);
}

async function localLastUpdate(path: string): Promise<string | null> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	return lastUpdateOf(await file.slice(0, 4096).text());
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });
	const dir = join(import.meta.dir, 'data');
	const target = join(dir, RELEASE_FILE);
	mkdirSync(dir, { recursive: true });

	const [local, remote] = await Promise.all([localLastUpdate(target), remoteLastUpdate()]);
	if (!values.force && local && local === remote) {
		console.log(`up to date: ${RELEASE_FILE} lastUpdate ${local}`);
		process.exit(0);
	}

	console.log(
		`downloading release ${remote ?? '(unknown lastUpdate)'} (local: ${local ?? 'none'})`,
	);
	const res = await fetch(RELEASE_URL);
	if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
	const tmp = `${target}.part`;
	await Bun.write(tmp, res);
	renameSync(tmp, target);
	const got = await localLastUpdate(target);
	console.log(
		`saved ${target} (${(Bun.file(target).size / 1e6).toFixed(1)} MB, lastUpdate ${got})`,
	);
}
