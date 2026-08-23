import { ObjectExistsError, type ObjectStore } from './store.ts';

/**
 * In-memory {@link ObjectStore} for unit tests. `putIfAbsent` is atomic because JS is
 * single-threaded and the check-and-set below contains no `await` — the concurrency test
 * in store.test.ts asserts exactly that.
 */
export class MemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, { body: Uint8Array; etag: string }>();
	private counter = 0;

	async get(key: string): Promise<Uint8Array | null> {
		return this.objects.get(key)?.body ?? null;
	}

	async getIfChanged(
		key: string,
		etag?: string,
	): Promise<{ body: Uint8Array; etag: string } | 'unchanged' | null> {
		const o = this.objects.get(key);
		if (!o) return null;
		if (etag !== undefined && etag === o.etag) return 'unchanged' as const;
		return { body: o.body, etag: o.etag };
	}

	async put(key: string, body: Uint8Array): Promise<void> {
		this.objects.set(key, { body, etag: `e${++this.counter}` });
	}

	async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		// No await between the check and the set — this is the atomic section.
		if (this.objects.has(key)) throw new ObjectExistsError(key);
		this.objects.set(key, { body, etag: `e${++this.counter}` });
	}

	async list(prefix: string): Promise<string[]> {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}
}
