import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ObjectStore } from './store.ts';

/**
 * The object key for a blob, derived entirely from its bytes. Content addressing buys
 * three things at once: uploads are idempotent (so a retried or duplicated PUT is a
 * no-op and a lost acknowledgement cannot corrupt anything), a losing writer's uploads
 * are inert rather than damaging, and a cached file never needs revalidation.
 */
export function contentKey(bytes: Uint8Array): string {
	return `data/${createHash('sha256').update(bytes).digest('hex')}.parquet`;
}

/**
 * A local, content-addressed mirror of the bucket's data objects.
 *
 * DuckDB will not do this for us. Its external file cache is IN-MEMORY and scoped to the
 * `DuckDBInstance` — measured at 54 requests cold, 1 HEAD warm, and full price again in a
 * second instance or a second process. Nothing survives a cold start, and every ANN query
 * served remotely re-reads the whole embedding column.
 *
 * Because the keys are content hashes, this cache has no invalidation logic and no
 * staleness window: a key's bytes are the same forever, so a file on disk never needs
 * revalidation against the store.
 */
export class FileCache {
	constructor(
		private readonly store: ObjectStore,
		private readonly cacheDir: string,
	) {}

	/** Where `key` lives (or would live) on disk. Pure — does not touch the filesystem. */
	localPath(key: string): string {
		return join(this.cacheDir, key.replace(/\//g, '_'));
	}

	async has(key: string): Promise<boolean> {
		try {
			await access(this.localPath(key));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Upload bytes under their content key, skipping the PUT when it is already there, and
	 * write them into the local cache too. The writer already holds the bytes in hand, so
	 * re-downloading its own upload on the next read would be pure waste. The store write
	 * happens first, so nothing uncommitted is ever cached.
	 */
	async putContent(bytes: Uint8Array): Promise<string> {
		const key = contentKey(bytes);
		if ((await this.store.get(key)) === null) await this.store.put(key, bytes);
		await this.writeAtomic(this.localPath(key), bytes);
		return key;
	}

	/** Download `key` if it is not already cached on disk, and return its local path. */
	async ensure(key: string): Promise<string> {
		const path = this.localPath(key);
		if (await this.has(key)) return path;
		const bytes = await this.store.get(key);
		if (bytes === null) {
			throw new Error(`FileCache: object not found in store or cache: ${key}`);
		}
		await this.writeAtomic(path, bytes);
		return path;
	}

	/** Ensure every key, in parallel, and return their local paths in the same order as `keys`. */
	async resolve(keys: string[]): Promise<string[]> {
		return Promise.all(keys.map((key) => this.ensure(key)));
	}

	/**
	 * Write via a uniquely named temp file and rename. A half-written cache file would be
	 * indistinguishable from a complete one to `has()`, and DuckDB would read it as a
	 * truncated Parquet — so the write must be atomic. The temp name is unique per call,
	 * not just per process, so that two concurrent writers for the same key (e.g. two
	 * `ensure` calls racing, as `resolve` can trigger) cannot interleave into one temp file.
	 */
	private async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
		await mkdir(this.cacheDir, { recursive: true });
		const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmp, bytes);
		try {
			await rename(tmp, path);
		} finally {
			await rm(tmp, { force: true });
		}
	}
}
