import { expect, test } from 'bun:test';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { EmbeddingError, hashEmbed } from '../../src/core/embedder.ts';
import { Graph } from '../../src/core/graph.ts';
import { init, readEmbeddingMeta } from '../../src/core/schema.ts';
import { makeTestDb } from './harness.ts';

// The embedding model and width are recorded in `graph_meta` the first time a namespace is
// initialised with an embedder. A different embedder later must fail fast — `reembed` is the
// sanctioned switch — rather than silently mixing two vector spaces. Runs on every backend.

const SCHEMA = defineGraphSchema({ nodes: {}, edges: {} });

test('readEmbeddingMeta: null before init, then the model + width', async () => {
	const db = makeTestDb();
	try {
		expect(await readEmbeddingMeta(db.client)).toBeNull();
		await init(db.client); // base schema only — still no model
		expect(await readEmbeddingMeta(db.client)).toBeNull();
		await init(db.client, hashEmbed(64));
		expect(await readEmbeddingMeta(db.client)).toEqual({ model: 'hash:64', dim: 64 });
	} finally {
		await db.teardown();
	}
});

test('init: re-init with the SAME embedder is idempotent', async () => {
	const db = makeTestDb();
	try {
		await init(db.client, hashEmbed(64));
		await init(db.client, hashEmbed(64)); // no throw
		await init(db.client); // no embedder: leaves the recorded model alone
		expect(await readEmbeddingMeta(db.client)).toEqual({ model: 'hash:64', dim: 64 });
	} finally {
		await db.teardown();
	}
});

test('init: a DIFFERENT embedder throws a model error naming both, and changes nothing', async () => {
	const db = makeTestDb();
	try {
		await init(db.client, hashEmbed(64));
		const err = await init(db.client, hashEmbed(128)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(EmbeddingError);
		expect((err as EmbeddingError).code).toBe('model');
		expect((err as Error).message).toMatch(/'hash:64' \(64 dims\).*'hash:128' \(128 dims\)/);
		expect(await readEmbeddingMeta(db.client)).toEqual({ model: 'hash:64', dim: 64 }); // unchanged
	} finally {
		await db.teardown();
	}
});

test('Graph.reembed switches the namespace to the graph embedder and records it', async () => {
	const db = makeTestDb();
	try {
		await init(db.client, hashEmbed(64));
		const g = new Graph(db.client, SCHEMA, { embedder: hashEmbed(128) });
		const result = await g.reembed();
		expect(result).toEqual({ nodes: 0, embedded: 0, skipped: 0 });
		expect(await readEmbeddingMeta(db.client)).toEqual({ model: 'hash:128', dim: 128 });
		await init(db.client, hashEmbed(128)); // now the matching embedder — no throw
	} finally {
		await db.teardown();
	}
});
