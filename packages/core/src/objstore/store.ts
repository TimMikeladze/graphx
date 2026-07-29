/**
 * Provider-neutral object-storage contract. The commit protocol needs exactly one
 * non-trivial primitive — {@link ObjectStore.putIfAbsent}, "create this key, fail if it
 * already exists" — because that is what serializes writers without a lock service or a
 * catalog database. Everything else here is ordinary get/put/list/delete.
 *
 * Deliberately NOT an If-Match conditional overwrite: create-if-absent is the most widely
 * supported primitive across providers, and the protocol never needs to overwrite a key
 * whose contents matter (see `_head`, which is a hint).
 */
export interface ObjectStore {
	/** Object bytes, or null when the key does not exist. */
	get(key: string): Promise<Uint8Array | null>;
	/**
	 * Conditional read. Returns `'unchanged'` when `etag` still matches (an HTTP 304 or its
	 * local equivalent), a `{ body, etag }` pair when it does not, or null when absent.
	 * This is what keeps the per-query manifest resolve cheap.
	 */
	getIfChanged(
		key: string,
		etag?: string,
	): Promise<{ body: Uint8Array; etag: string } | 'unchanged' | null>;
	/** Unconditional write. */
	put(key: string, body: Uint8Array): Promise<void>;
	/** Create-only write. Throws {@link ObjectExistsError} if the key is taken. */
	putIfAbsent(key: string, body: Uint8Array): Promise<void>;
	/** Keys under `prefix`, sorted ascending. */
	list(prefix: string): Promise<string[]>;
	delete(key: string): Promise<void>;
}

/** `putIfAbsent` lost the race — another writer already created this key. */
export class ObjectExistsError extends Error {
	constructor(readonly key: string) {
		super(`object already exists: ${key}`);
		this.name = 'ObjectExistsError';
	}
}
