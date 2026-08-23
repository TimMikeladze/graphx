import { expect, test } from 'bun:test';
import { init, readEmbDim } from '../../src/core/schema.ts';
import { makeTestDb } from './harness.ts';

// The embedding dimension is baked into node_versions.emb at first init and the DDL is
// `IF NOT EXISTS`, so re-initing at a different EXPLICIT dim must fail fast rather than silently
// keep the old width (which would then reject every embed insert). Runs on both backends.

test('readEmbDim: null before init, then the initialized dim', async () => {
	const db = makeTestDb();
	try {
		expect(await readEmbDim(db.client)).toBeNull();
		await init(db.client, 64);
		expect(await readEmbDim(db.client)).toBe(64);
	} finally {
		await db.teardown();
	}
});

test('init: re-init at the SAME dim is idempotent', async () => {
	const db = makeTestDb();
	try {
		await init(db.client, 64);
		await init(db.client, 64); // no throw
		expect(await readEmbDim(db.client)).toBe(64);
	} finally {
		await db.teardown();
	}
});

test('init: re-init at a DIFFERENT explicit dim throws (dimension is immutable)', async () => {
	const db = makeTestDb();
	try {
		await init(db.client, 64);
		await expect(init(db.client, 128)).rejects.toThrow(/immutable|dim 64/);
		expect(await readEmbDim(db.client)).toBe(64); // unchanged
	} finally {
		await db.teardown();
	}
});

test('init: a defaulted dim (undefined) skips the check — no-op on an existing column', async () => {
	const db = makeTestDb();
	try {
		await init(db.client, 64);
		await init(db.client); // undefined → no throw even though the default (768) differs
		expect(await readEmbDim(db.client)).toBe(64);
	} finally {
		await db.teardown();
	}
});
