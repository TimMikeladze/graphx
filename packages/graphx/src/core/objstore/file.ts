import { createHash, randomUUID } from 'node:crypto';
import { Dirent } from 'node:fs';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { ObjectExistsError, type ObjectStore } from './store.ts';

/**
 * Filesystem {@link ObjectStore} — the default test store, and a legitimate single-host
 * deployment target. `putIfAbsent` uses atomic write-then-link to avoid the torn-read
 * window, so it models S3's `If-None-Match: *` faithfully rather than approximating it
 * with a stat-then-write.
 */
export class FileObjectStore implements ObjectStore {
	constructor(private readonly rootDir: string) {}

	private path(key: string): string {
		return join(this.rootDir, ...key.split('/'));
	}

	/**
	 * Absence is load-bearing in this protocol — `resolveHead` probes forward until a
	 * snapshot is missing — so only a genuine "not there" may return null. A catch-all
	 * would make a permission error or a path collision indistinguishable from absence,
	 * and silently resolve an older snapshot as head.
	 */
	async get(key: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(await readFile(this.path(key)));
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return null;
			throw e;
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
		await this.writeThenMove(p, body, rename);
	}

	/**
	 * Create-only, and atomic in BOTH senses that matter: only one caller wins, and the
	 * key never exists in a half-written state.
	 *
	 * `O_CREAT | O_EXCL` alone gives only the first: it makes the file exist at zero bytes
	 * and the body lands in a second step, so a reader racing that window gets a truncated
	 * object instead of `null` — and in this protocol that reader is `resolveHead` parsing
	 * a manifest. Writing to a temp file first and `link()`ing it into place gives both:
	 * `link` fails `EEXIST` atomically, and the name it publishes is already complete.
	 */
	async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		const p = this.path(key);
		await mkdir(dirname(p), { recursive: true });
		await this.writeThenMove(p, body, link, key);
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
				else {
					const key = relative(this.rootDir, full).split(sep).join('/');
					// Skip temp files that may be mid-write.
					if (!key.endsWith('.tmp')) out.push(key);
				}
			}
		};
		await walk(this.rootDir);
		return out.filter((k) => k.startsWith(prefix)).sort();
	}

	async delete(key: string): Promise<void> {
		await rm(this.path(key), { force: true });
	}

	/** Write to a sibling temp file, then publish it under `target` in one step. */
	private async writeThenMove(
		target: string,
		body: Uint8Array,
		publish: (from: string, to: string) => Promise<void>,
		exclusiveKey?: string,
	): Promise<void> {
		const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmp, body);
		try {
			await publish(tmp, target);
		} catch (e) {
			if (exclusiveKey !== undefined && (e as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new ObjectExistsError(exclusiveKey);
			}
			throw e;
		} finally {
			await rm(tmp, { force: true });
		}
	}
}
