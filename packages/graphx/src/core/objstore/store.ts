import { createHash } from 'node:crypto';

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

/** The store accepted a create-only write over an existing key — it does not enforce CAS. */
export class ConditionalWriteUnsupportedError extends Error {
	constructor(detail: string) {
		super(
			`object store does not enforce create-if-absent writes (${detail}). The snapshot ` +
				'commit protocol relies on it to serialize writers; without it, two writers can ' +
				'silently overwrite one another. Backblaze B2 has no conditional write in either ' +
				"API; on Google Cloud Storage set conditionalWrite: 'gcs-generation'.",
		);
		this.name = 'ConditionalWriteUnsupportedError';
	}
}

/**
 * Assert the store genuinely enforces create-if-absent, by doing it: write a probe key,
 * write it again, and require the second write to fail. Two providers make this necessary
 * rather than paranoid — Google's S3-compatible endpoint may ignore `If-None-Match` on PUT
 * silently, and MinIO builds from 2023–24 accepted the `*` wildcard without enforcing it.
 * A silent no-op there is not a slow path, it is two writers overwriting each other.
 */
export async function probeConditionalWrite(store: ObjectStore): Promise<void> {
	const key = `_probe/${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16)}`;
	const one = new TextEncoder().encode('1');
	const two = new TextEncoder().encode('2');
	try {
		await store.putIfAbsent(key, one);
		let overwrote = false;
		try {
			await store.putIfAbsent(key, two);
			overwrote = true;
		} catch (e) {
			if (!(e instanceof ObjectExistsError)) throw e;
		}
		if (overwrote) {
			throw new ConditionalWriteUnsupportedError('a second putIfAbsent on a taken key succeeded');
		}
		const after = await store.get(key);
		if (after !== null && new TextDecoder().decode(after) !== '1') {
			throw new ConditionalWriteUnsupportedError(
				'the probe object was modified by the second write',
			);
		}
	} finally {
		await store.delete(key).catch(() => {});
	}
}
