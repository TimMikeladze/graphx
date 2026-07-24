import { expect, test } from 'bun:test';
import { FOREVER } from '../src/db.ts';
import { hashEmbed, retrieve } from '../src/retrieve.ts';
import { CORPUS, seedCorpus } from './fixtures/corpus.ts';
import { annScored } from './retrieval-legs.ts';
import { embReadSql, makeTestDb } from './harness.ts';

/**
 * Invariants that hold for ANY embedder — no judgments, no golden file, no model.
 *
 * They are the cheap layer under the golden-set scoring: a broken index, a mangled vector
 * round-trip, or an order-dependent ranking will fail here with an unambiguous cause, long
 * before a quality score drifts and leaves you guessing which stage regressed.
 */

const embed = hashEmbed();

test('self-retrieval: a document’s own body retrieves that document at rank 1', async () => {
	const db = makeTestDb();
	const { slugOf } = await seedCorpus(db.client, embed);

	// The query vector is identical to the stored vector, so cosine similarity is exactly 1 —
	// nothing can legitimately outrank it. Failure here means the ANN index, the vector
	// encoding, or the seed SQL is broken, independent of any notion of relevance.
	for (const doc of CORPUS) {
		const res = await retrieve(db.client, embed, { query: doc.body, k: 1, maxDepth: 0 });
		expect(res.length).toBe(1);
		expect(slugOf.get(res[0]?.id as string)).toBe(doc.slug);
		expect(res[0]?.depth).toBe(0);
	}
	await db.teardown();
});

test('insertion order does not change the ranking', async () => {
	const forward = makeTestDb();
	const reverse = makeTestDb();
	const a = await seedCorpus(forward.client, embed);
	const b = await seedCorpus(reverse.client, embed, [...CORPUS].reverse());

	// Same corpus, opposite write order. Rank must be a function of the vectors alone; if row
	// order leaks into it, a golden file recorded today silently rots the next time the corpus
	// is edited.
	for (const q of ['wartime codebreaking of intercepted signals', 'the first compiler']) {
		const ra = (await retrieve(forward.client, embed, { query: q, k: 5, maxDepth: 0 })).map((r) =>
			a.slugOf.get(r.id),
		);
		const rb = (await retrieve(reverse.client, embed, { query: q, k: 5, maxDepth: 0 })).map((r) =>
			b.slugOf.get(r.id),
		);
		expect(ra.length).toBe(5);
		expect(new Set(ra)).toEqual(new Set(rb));
	}
	await forward.teardown();
	await reverse.teardown();
});

test('stored vectors round-trip exactly (what goes in is what the walk scores)', async () => {
	const db = makeTestDb();
	const { idOf } = await seedCorpus(db.client, embed);

	// `hashEmbed` emits small integer token counts, which are exact in the float32 storage
	// both dialects use — so any difference here is a real encoding bug, not precision loss.
	const r = await db.client.execute(
		`SELECT id, ${embReadSql(db.client)} AS e FROM node_versions WHERE valid_to = ${FOREVER}`,
	);
	expect(r.rows.length).toBe(CORPUS.length);
	const stored = new Map(r.rows.map((row) => [String(row.id), JSON.parse(String(row.e)) as number[]]));

	for (const doc of CORPUS) {
		const expected = await embed(doc.body);
		expect(stored.get(idOf.get(doc.slug) as string)).toEqual(expected);
	}
	await db.teardown();
});

test('ANN tie order is NOT stable, but the tie GROUPS are', async () => {
	const db = makeTestDb();
	const { slugOf } = await seedCorpus(db.client, embed);
	const query = 'who designed the analytical engine';

	// `halting-problem` and `bletchley-park` sit at exactly the same cosine distance from this
	// query. Repeating the identical query against the identical database returns them in
	// varying order — libSQL's `vector_top_k` does not break ties deterministically, and
	// pgvector breaks them by physical row order, which ULIDs randomize per ingest.
	//
	// Consequences a caller has to plan for: a paginated or cached ranking can shuffle between
	// requests, and when a tie straddles the k-cut, top-k MEMBERSHIP changes too. Anything that
	// must be reproducible needs a deterministic tie-break of its own (e.g. sort by id within
	// equal scores). Golden files must therefore pin distances, never tie-broken order.
	const scored = await annScored(db.client, embed, query);
	const byDistance = new Map<string, string[]>();
	for (const s of scored) {
		const bucket = s.dist.toFixed(6);
		byDistance.set(bucket, [...(byDistance.get(bucket) ?? []), slugOf.get(s.id) as string]);
	}
	// The corpus really does contain a tie — otherwise this test proves nothing.
	expect([...byDistance.values()].some((g) => g.length > 1)).toBe(true);

	// What IS stable: the multiset of distances, and therefore the tie groups.
	for (let i = 0; i < 5; i++) {
		const again = await annScored(db.client, embed, query);
		expect(again.map((s) => s.dist.toFixed(6))).toEqual(scored.map((s) => s.dist.toFixed(6)));
	}
	await db.teardown();
});

test('ANN seeding has NO relevance floor — an unrelated query still returns k seeds', async () => {
	const db = makeTestDb();
	const { slugOf } = await seedCorpus(db.client, embed);

	// Documented trap, not a bug: top-k is a *ranking* operator, so a query with zero overlap
	// still returns the k least-distant rows, and the walk then expands them into a subgraph
	// that looks authoritative. Callers who feed retrieve() to an LLM need their own similarity
	// floor or a reranker — the retriever will never return "nothing found" on its own. This
	// test pins that behavior so a future relevance cutoff is a deliberate, visible change.
	const res = await retrieve(db.client, embed, { query: 'zzzz qqqq', k: 5, maxDepth: 0 });
	expect(res.length).toBe(5);
	expect(res.every((r) => slugOf.has(r.id))).toBe(true);

	// And with a walk enabled, those arbitrary seeds pull in their neighbors too.
	const walked = await retrieve(db.client, embed, { query: 'zzzz qqqq', k: 5, maxDepth: 2 });
	expect(walked.length).toBeGreaterThan(res.length);
	await db.teardown();
});
