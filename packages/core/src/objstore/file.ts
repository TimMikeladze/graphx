import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { Dirent } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ObjectExistsError, type ObjectStore } from './store.ts';

/**
 * Filesystem {@link ObjectStore} — the default test store, and a legitimate single-host
 * deployment target. `putIfAbsent` uses `O_CREAT | O_EXCL`, which is the POSIX
 * create-if-absent primitive and is atomic on every mainstream filesystem, so it models
 * S3's `If-None-Match: *` faithfully rather than approximating it with a stat-then-write.
 */
export class FileObjectStore implements ObjectStore {
	constructor(private readonly rootDir: string) {}

	private path(key: string): string {
		return join(this.rootDir, ...key.split('/'));
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(this.path(key)));
		} catch {
			return null;
		}
	}

	async getIfChanged(
		key: string,
		etag?: string,
	): Promise<{ body: Uint8Array; etag: string } | 'unchanged' | null> {
		const body = await this.get(key);
		if (body === null) return null;
		const current = createHash('sha256').update(body).digest('hex').slice(0, 32);
		if (etag !== undefined && etag === current) return 'unchanged' as const;
		return { body, etag: current };
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		const p = this.path(key);
		await mkdir(dirname(p), { recursive: true });
		await writeFile(p, body);
	}

	async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		const p = this.path(key);
		await mkdir(dirname(p), { recursive: true });
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(p, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ObjectExistsError(key);
			throw e;
		}
		try {
			await handle.writeFile(body);
		} finally {
			await handle.close();
		}
	}

	async list(prefix: string): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				const full = join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else out.push(relative(this.rootDir, full).split(sep).join('/'));
			}
		};
		await walk(this.rootDir);
		return out.filter((k) => k.startsWith(prefix)).sort();
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
	}
}
