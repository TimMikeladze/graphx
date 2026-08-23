import { describe, expect, test } from 'bun:test';
import { MemoryObjectStore } from '../../../src/core/objstore/memory.ts';
import {
	ConditionalWriteUnsupportedError,
	probeConditionalWrite,
} from '../../../src/core/objstore/s3.ts';
import type { ObjectStore } from '../../../src/core/objstore/store.ts';

/** A store whose putIfAbsent silently overwrites — the GCS-silent-ignore failure mode. */
class LyingStore extends MemoryObjectStore {
	override async putIfAbsent(key: string, body: Uint8Array): Promise<void> {
		await this.put(key, body);
	}
}

describe('conditional-write probe', () => {
	test('passes against a store that enforces create-only', async () => {
		await probeConditionalWrite(new MemoryObjectStore());
	});

	test('fails loudly against a store that silently overwrites', async () => {
		await expect(probeConditionalWrite(new LyingStore())).rejects.toBeInstanceOf(
			ConditionalWriteUnsupportedError,
		);
	});

	test('leaves no probe object behind', async () => {
		const s: ObjectStore = new MemoryObjectStore();
		await probeConditionalWrite(s);
		expect(await s.list('')).toEqual([]);
	});
});
