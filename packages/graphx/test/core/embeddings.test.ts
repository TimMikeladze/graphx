import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { bulkLoad } from '../../src/core/bulk.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { chunkText, defineEmbedder, embedHash, EmbeddingError } from '../../src/core/embedder.ts';
import { Graph } from '../../src/core/graph.ts';
import { retrieve } from '../../src/core/retrieve.ts';
import { init, readEmbeddingMeta } from '../../src/core/schema.ts';
import { createApp } from '../../src/core/serve.ts';
import { embedTrigger, TriggerRunner } from '../../src/core/triggers.ts';
import { makeTestDb, stubEmbedder, type TestDb } from './harness.ts';

/**
 * The embedding lifecycle the graph owns: what gets embedded, when it is re-embedded, how a
 * vector is validated, how a model switch happens, and what retrieval returns. Every test here
 * runs on all three backends.
 */

const teardowns: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const t of teardowns) await t();
});
function db(opts: { file?: boolean } = {}): TestDb {
	const d = makeTestDb(opts);
	teardowns.push(d.teardown);
	return d;
}

/** `[len(text), firstCharCode, 0, 0]` — cheap, distinct per text, and easy to reason about. */
const lenEmbed = (id = 'len') =>
	stubEmbedder((t) => [t.length, t.charCodeAt(0) || 0, 0, 0], { id, dim: 4 });

// --- defineEmbedder ---------------------------------------------------------------------------

test('defineEmbedder: learns dim from the first vector, splits batches, rejects a width change', async () => {
	const seen: number[] = [];
	const e = defineEmbedder({
		id: 'm',
		batchSize: 2,
		embed: async (texts) => {
			seen.push(texts.length);
			return texts.map(() => [1, 2, 3]);
		},
	});
	expect(e.dim).toBeUndefined();
	expect(await e.resolveDim()).toBe(3);
	expect(await e.embed(['a', 'b', 'c', 'd', 'e'])).toHaveLength(5);
	expect(seen).toEqual([1, 2, 2, 1]);

	const bad = defineEmbedder({
		id: 'bad',
		dim: 3,
		embed: async (texts) => texts.map((t) => (t === 'short' ? [1, 2] : [1, 2, 3])),
	});
	await expect(bad.embed(['short'])).rejects.toThrow(
		/2 dimensions but this namespace is embedded at 3/,
	);
	const nan = defineEmbedder({ id: 'nan', embed: async () => [[1, Number.NaN]] });
	const err = await nan.embedOne('x').catch((x: unknown) => x);
	expect(err).toBeInstanceOf(EmbeddingError);
	expect((err as EmbeddingError).code).toBe('invalid');
});

test('chunkText: deterministic windows on paragraph/line/space boundaries with overlap', () => {
	const text = `${'alpha beta gamma delta '.repeat(20)}\n\n${'epsilon zeta '.repeat(30)}`;
	const a = chunkText(text, { size: 120, overlap: 20 });
	const b = chunkText(text, { size: 120, overlap: 20 });
	expect(a).toEqual(b);
	expect(a.length).toBeGreaterThan(3);
	for (const c of a) expect(c.length).toBeLessThanOrEqual(120);
	// No window cuts a word: every chunk starts and ends on a token.
	for (const c of a) expect(c).toMatch(/^\S[\s\S]*\S$|^\S$/);
	// A short text is a single chunk, untouched.
	expect(chunkText('tiny', { size: 100 })).toEqual(['tiny']);
	// The hash mixes the model in, so a model change is a new hash for identical text.
	expect(embedHash('m1', 'x')).not.toBe(embedHash('m2', 'x'));
});

// --- per-type policy + chunking ----------------------------------------------------------------

const POLICY_SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string(), bio: z.string() }),
		note: z.object({ title: z.string() }),
		secret: z.object({ v: z.string() }),
	},
	edges: { about: { from: 'note', to: 'person' } },
	embedding: {
		// A data-only type: embed a projection of its data rather than a (missing) body.
		person: { text: (d) => `${d.name}: ${d.bio}` },
		// Long notes are split; each chunk is its own vector row.
		note: { chunk: { size: 40, overlap: 8 } },
		// Never embedded.
		secret: { text: () => null },
	},
});

test('policy: data-only types embed their declared text; chunked types store one row per chunk', async () => {
	const { client } = db();
	const embedder = lenEmbed();
	await init(client, embedder);
	const g = new Graph(client, POLICY_SCHEMA, { embedder });

	const ada = await g.addNode({
		type: 'person',
		data: { name: 'Ada', bio: 'wrote the first program' },
	});
	const long = 'first sentence here. second sentence here. third sentence here. fourth one.';
	const note = await g.addNode({ type: 'note', data: { title: 'long' }, body: long });
	const secret = await g.addNode({ type: 'secret', data: { v: 'x' }, body: 'never embedded' });

	const rows = async (id: string) =>
		(
			await client.execute({
				sql: 'SELECT chunk, text FROM node_embeddings WHERE id = ? ORDER BY chunk',
				args: [id],
			})
		).rows;
	expect((await rows(ada.id)).length).toBe(1);
	expect((await rows(ada.id))[0]?.text).toBeNull(); // whole input: nothing worth storing twice
	const noteRows = await rows(note.id);
	expect(noteRows.length).toBeGreaterThan(1);
	expect(noteRows.map((r) => Number(r.chunk))).toEqual(noteRows.map((_, i) => i));
	for (const r of noteRows) expect(String(r.text).length).toBeLessThanOrEqual(40);
	expect((await rows(secret.id)).length).toBe(0);

	// Retrieval groups chunks to their node, reports the best chunk as `snippet`, and carries
	// type/data/score/via/seed on every row.
	const hits = await g.retrieve({ query: 'third sentence here.', k: 5, maxDepth: 0 });
	const hit = hits.find((h) => h.id === note.id);
	expect(hit).toBeDefined();
	expect(hit?.type).toBe('note');
	expect(hit?.data).toEqual({ title: 'long' });
	expect(hit?.via).toEqual(['vector']);
	expect(hit?.seed).toBe(note.id);
	expect(typeof hit?.score).toBe('number');
	expect(hit?.snippet).not.toBeNull();
	expect(hits.filter((h) => h.id === note.id).length).toBe(1);
	expect(hits.some((h) => h.id === secret.id)).toBe(false);

	// The walk reaches the person through the edge, tagged as walked, with the seed recorded.
	await g.addEdge({ rel: 'about', src: note.id, dst: ada.id });
	// Query with one stored chunk's exact text: under lenEmbed that is a zero-distance seed.
	const walked = await g.retrieve({ query: String(noteRows[1]?.text), k: 1, maxDepth: 1 });
	const reached = walked.find((h) => h.id === ada.id);
	expect(reached?.via).toEqual(['walk']);
	expect(reached?.score).toBeNull();
	expect(reached?.seed).toBe(note.id);
	expect(reached?.depth).toBe(1);
});

test('policy: a data-only edit that changes the embedded text re-embeds; one that does not, does not', async () => {
	const { client } = db({ file: true });
	let calls = 0;
	const embedder = stubEmbedder(
		(t) => {
			calls++;
			return [t.length, 0, 0, 0];
		},
		{ dim: 4 },
	);
	await init(client, embedder);
	const g = new Graph(client, POLICY_SCHEMA, { embedder });
	const ada = await g.addNode({ type: 'person', data: { name: 'Ada', bio: 'x' } });
	expect(calls).toBe(1);
	await g.updateNode(ada.id, { data: { bio: 'x' } }); // same projection
	expect(calls).toBe(1);
	await g.updateNode(ada.id, { data: { bio: 'a longer bio' } }); // projection changed
	expect(calls).toBe(2);
	// `embedding: false` on a write leaves the stored vectors alone even when the text changed.
	await g.updateNode(ada.id, { data: { bio: 'changed again' }, embedding: false });
	expect(calls).toBe(2);
});

// --- validation ---------------------------------------------------------------------------------

const SIMPLE = defineGraphSchema({ nodes: { doc: z.object({ t: z.string() }) }, edges: {} });

test('validation: wrong width and non-finite vectors are refused before any SQL; zero query returns []', async () => {
	const { client } = db();
	const embedder = lenEmbed();
	await init(client, embedder);
	const g = new Graph(client, SIMPLE, { embedder });
	await expect(g.addNode({ type: 'doc', data: { t: 'a' }, emb: [1, 2] })).rejects.toThrow(
		/2 dimensions but this namespace is embedded at 4/,
	);
	await expect(
		g.addNode({ type: 'doc', data: { t: 'a' }, emb: [1, 2, Number.POSITIVE_INFINITY, 0] }),
	).rejects.toThrow(/not a finite number/);
	expect(Number((await client.execute('SELECT count(*) AS n FROM nodes')).rows[0]?.n)).toBe(0);

	await g.addNode({ type: 'doc', data: { t: 'a' }, body: 'hello' });
	// An empty query embeds to the zero vector under lenEmbed; cosine is undefined, so no seeds.
	expect(await g.retrieve({ query: '', k: 5 })).toEqual([]);
});

test('validation: a namespace without embeddings, or with another model, refuses vector work', async () => {
	const { client } = db();
	await init(client);
	const g = new Graph(client, SIMPLE, { embedder: lenEmbed() });
	const missing = await g.retrieve({ query: 'x' }).catch((e: unknown) => e);
	expect((missing as EmbeddingError).code).toBe('missing');
	// Writes without an embedding table still succeed — they just carry no vector.
	const n = await g
		.addNode({ type: 'doc', data: { t: 'a' }, body: 'no table yet' })
		.catch((e: unknown) => e);
	expect((n as EmbeddingError).code).toBe('missing');

	await init(client, lenEmbed('m1'));
	const other = new Graph(client, SIMPLE, { embedder: lenEmbed('m2') });
	const model = await other
		.addNode({ type: 'doc', data: { t: 'a' }, body: 'x' })
		.catch((e: unknown) => e);
	expect((model as EmbeddingError).code).toBe('model');
	const q = await retrieve(client, lenEmbed('m2'), { query: 'x' }).catch((e: unknown) => e);
	expect((q as EmbeddingError).code).toBe('model');
});

// --- ranking ------------------------------------------------------------------------------------

test('ranking: seeds are ordered by true distance, live and as-of, on every backend', async () => {
	const { client } = db();
	const q = stubEmbedder(() => [1, 0, 0, 0], { dim: 4 });
	await init(client, q);
	const g = new Graph(client, SIMPLE, { embedder: q });
	// Inserted far → mid → near, so rowid order is the opposite of similarity order.
	const far = await g.addNode({ type: 'doc', data: { t: 'far' }, emb: [0, 1, 0, 0] });
	const mid = await g.addNode({ type: 'doc', data: { t: 'mid' }, emb: [0.5, 0.5, 0, 0] });
	const near = await g.addNode({ type: 'doc', data: { t: 'near' }, emb: [1, 0, 0, 0] });
	const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
	expect(ids(await g.retrieve({ query: 'x', k: 1, maxDepth: 0 }))).toEqual([near.id]);
	expect(ids(await g.retrieve({ query: 'x', k: 2, maxDepth: 0 }))).toEqual([near.id, mid.id]);
	const t = Date.now() + 60_000;
	expect(ids(await g.retrieve({ query: 'x', k: 1, maxDepth: 0, asOf: t }))).toEqual([near.id]);
	expect(ids(await g.retrieve({ query: 'x', k: 3, maxDepth: 0, asOf: t }))).toEqual([
		near.id,
		mid.id,
		far.id,
	]);
	const scores = (await g.retrieve({ query: 'x', k: 3, maxDepth: 0 })).map(
		(r) => r.score as number,
	);
	expect(scores[0]).toBeCloseTo(1, 5);
	expect(scores[2]).toBeCloseTo(0, 5);
});

// --- bulk + lazy + reembed + report ------------------------------------------------------------

test('bulkLoad: embeds live rows through the embedder in one batch; `embedding: false` opts a row out', async () => {
	const { client } = db();
	let batches = 0;
	const embedder = stubEmbedder(
		(t) => {
			batches++;
			return [t.length, 0, 0, 0];
		},
		{ dim: 4 },
	);
	await init(client, embedder);
	const res = await bulkLoad(
		client,
		SIMPLE,
		[
			{ type: 'doc', data: { t: 'a' }, body: 'embedded' },
			{ type: 'doc', data: { t: 'b' }, body: 'skipped', embedding: false },
			{ type: 'doc', data: { t: 'c' }, body: 'history', validFrom: 1, validTo: 2 },
			{ type: 'doc', data: { t: 'd' }, body: 'raw', emb: [9, 9, 9, 9] },
		],
		{ embedder },
	);
	expect(res.count).toBe(4);
	const n = await client.execute('SELECT count(*) AS n FROM node_embeddings');
	expect(Number(n.rows[0]?.n)).toBe(2); // 'embedded' + the raw vector; skipped + history have none
	expect(batches).toBe(1);
	await expect(
		bulkLoad(client, SIMPLE, [{ type: 'doc', data: { t: 'x' }, emb: [1] }], { embedder }),
	).rejects.toThrow(/1 dimensions/);
});

test('lazy mode + embedTrigger: writes store no vector; the trigger embeds after commit', async () => {
	const { client } = db({ file: true });
	const embedder = lenEmbed();
	await init(client, embedder);
	const g = new Graph(client, SIMPLE, { embedder, embedding: 'lazy', events: { outbox: true } });
	const n = await g.addNode({ type: 'doc', data: { t: 'a' }, body: 'later' });
	const count = async () =>
		Number(
			(
				await client.execute({
					sql: 'SELECT count(*) AS c FROM node_embeddings WHERE id = ?',
					args: [n.id],
				})
			).rows[0]?.c,
		);
	expect(await count()).toBe(0);
	const runner = new TriggerRunner(g, {
		name: 'lazy-test',
		triggers: [embedTrigger()],
		start: 'beginning',
	});
	await runner.runOnce();
	expect(await count()).toBe(1);
	// Its own write is a `node_embeddings` change, not a version — nothing to cascade.
	await runner.runOnce();
	expect(await count()).toBe(1);
});

test('reembed + embeddingReport: a model switch drops and rebuilds every live vector', async () => {
	const { client } = db();
	const m1 = lenEmbed('m1');
	await init(client, m1);
	const g1 = new Graph(client, SIMPLE, { embedder: m1 });
	const a = await g1.addNode({ type: 'doc', data: { t: 'a' }, body: 'alpha' });
	await g1.addNode({ type: 'doc', data: { t: 'b' }, body: 'beta' });
	await g1.addNode({ type: 'doc', data: { t: 'c' } }); // no body ⇒ no vector
	const r1 = await g1.embeddingReport();
	expect(r1).toMatchObject({ liveNodes: 3, embedded: 2, unembedded: 0, stale: 0, vectors: 2 });
	expect(r1.stored).toEqual({ model: 'm1', dim: 4 });

	// A vector written under different text is stale; a graph with another model sees a mismatch.
	await client.execute({
		sql: 'UPDATE node_embeddings SET embed_hash = ? WHERE id = ?',
		args: ['old', a.id],
	});
	expect((await g1.embeddingReport()).stale).toBe(1);

	const m2 = stubEmbedder((t) => [0, 0, 0, t.length], { id: 'm2', dim: 4 });
	const g2 = new Graph(client, SIMPLE, { embedder: m2 });
	const result = await g2.reembed();
	expect(result).toEqual({ nodes: 3, embedded: 2, skipped: 1 });
	expect(await readEmbeddingMeta(client)).toEqual({ model: 'm2', dim: 4 });
	const r2 = await g2.embeddingReport();
	expect(r2).toMatchObject({ embedded: 2, stale: 0, unembedded: 0 });
	expect(r2.configured).toEqual({ model: 'm2', dim: 4 });
	const hits = await g2.retrieve({ query: 'alpha', k: 2, maxDepth: 0 });
	expect(hits.map((h) => h.id)).toContain(a.id);
	for (const h of hits) expect(h.via).toEqual(['vector']);
});

// --- HTTP -----------------------------------------------------------------------------------------

test('serve: embedding errors map to 400 (dimension), 409 (model), 501 (missing)', async () => {
	const ns = `emb_http_${Date.now()}`;
	const { app, tenant, project, control } = await createApp({
		schema: SIMPLE,
		embedder: lenEmbed('http'),
		db: ns,
	});
	const post = (body: unknown) =>
		app.request(`/t/${tenant}/p/${project}/nodes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	const ok = await post({ type: 'doc', data: { t: 'a' }, body: 'embedded on the way in' });
	expect(ok.status).toBe(201);
	const bad = await post({ type: 'doc', data: { t: 'a' }, emb: [1, 2] });
	expect(bad.status).toBe(400);
	expect(((await bad.json()) as { code: string }).code).toBe('dimension');
	const hits = await app.request(
		`/t/${tenant}/p/${project}/retrieve?query=${encodeURIComponent('embedded on the way in')}&k=1`,
	);
	expect(hits.status).toBe(200);
	const rows = (await hits.json()) as Array<{ type: string; data: unknown; via: string[] }>;
	expect(rows[0]).toMatchObject({ type: 'doc', data: { t: 'a' }, via: ['vector'] });

	const noEmbedder = await createApp({ schema: SIMPLE, db: `${ns}_none` });
	const r501 = await noEmbedder.app.request(
		`/t/${noEmbedder.tenant}/p/${noEmbedder.project}/retrieve?query=x`,
	);
	expect(r501.status).toBe(501);
	control.close();
	noEmbedder.control.close();
});
