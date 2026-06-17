import { expect, test } from 'bun:test';
import { z } from 'zod';
import { FOREVER } from '../src/db.ts';
import type { DbClient } from '../src/dialect.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { hybridRetrieve, sanitizeMatch } from '../src/hybrid.ts';
import { type EmbedFn, retrieve } from '../src/retrieve.ts';
import { init } from '../src/schema.ts';
import { embSql, makeTestDb, TEST_DRIVER } from './harness.ts';

/** These probe libSQL's FTS5 internals (the `nodes_fts` table + sync trigger), which have no
 *  Postgres analog (FTS is a generated `body_tsv` column there). The user-facing hybrid-search
 *  contract is exercised by the retrieval tests below, which DO run on both backends. */
const libsqlOnly = TEST_DRIVER === 'postgres' ? test.skip : test;

// P13 — hybrid retrieval (FTS5 + RRF) + rerank/MMR (§19.3–19.4). dim 4.

const SCHEMA = defineGraphSchema({
	nodes: { doc: z.object({ title: z.string() }) },
	edges: { links: { from: 'doc', to: 'doc' } },
});

const VECTORS: Record<string, number[]> = {
	red: [1, 0, 0, 0],
	green: [0, 1, 0, 0],
	blue: [0, 0, 1, 0],
	yellow: [0, 0, 0, 1],
	dragon: [1, 1, 1, 1],
	phoenix: [0, 0, 0, 1],
	a: [1, 0, 0, 0],
};
// Unknown query → a nonzero default so vector_top_k never sees a degenerate 0-vector.
const stubEmbed: EmbedFn = async (text: string) => VECTORS[text] ?? [1, 0, 0, 0];

async function freshGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const client = makeTestDb().client;
	await init(client, 4);
	return { client, g: new Graph(client, SCHEMA) };
}

// ---------------------------------------------------------------------------
// FTS5 schema + trigger (M2)
// ---------------------------------------------------------------------------

libsqlOnly('P13 schema: addNode populates nodes_fts via the AFTER INSERT trigger', async () => {
	const { client, g } = await freshGraph();
	await g.addNode({ kind: 'doc', props: { title: 'x' }, body: 'the quick brown fox' });
	const r = await client.execute("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'fox'");
	expect(r.rows.length).toBe(1);
	client.close();
});

libsqlOnly('P13 schema: init() is idempotent with the FTS table + trigger present', async () => {
	const client = makeTestDb().client;
	await init(client, 4);
	await init(client, 4); // must not throw (IF NOT EXISTS on vtable + trigger)
	const g = new Graph(client, SCHEMA);
	await g.addNode({ kind: 'doc', props: { title: 'x' }, body: 'hello world' });
	const r = await client.execute("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH 'hello'");
	expect(r.rows.length).toBe(1);
	client.close();
});

// ---------------------------------------------------------------------------
// MATCH sanitization (M3) — FTS5 query-syntax injection neutralized
// ---------------------------------------------------------------------------

test('P13 sanitize: quotes each token, joins with OR, empty → null', () => {
	expect(sanitizeMatch('red')).toBe('"red"');
	expect(sanitizeMatch('quick brown')).toBe('"quick" OR "brown"');
	expect(sanitizeMatch('')).toBe(null);
	expect(sanitizeMatch('   ')).toBe(null);
	// embedded double-quote is escaped (doubled), not left dangling
	expect(sanitizeMatch('a"b')).toBe('"a""b"');
});

libsqlOnly('P13 sanitize: malicious FTS5 syntax never errors or escapes the query', async () => {
	const { client, g } = await freshGraph();
	await g.addNode({ kind: 'doc', props: { title: 'x' }, body: 'red apple', emb: VECTORS.red });
	const nasty = [
		'"',
		'red OR 1',
		'body: secret',
		'a NEAR b',
		'red*',
		"'); DROP TABLE node_versions; --",
		'foo(bar',
		'^red',
		'-red',
		'""""',
	];
	for (const q of nasty) {
		// must not throw — sanitizer demotes every operator to a literal term
		const res = await hybridRetrieve(client, stubEmbed, { query: q, k: 5 });
		expect(Array.isArray(res)).toBe(true);
		// and the sanitized form is directly usable as a MATCH expression
		const m = sanitizeMatch(q);
		if (m !== null) {
			await client.execute({ sql: 'SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?', args: [m] });
		}
	}
	client.close();
});

// ---------------------------------------------------------------------------
// Hybrid beats vector-only on recall (§19.3 acceptance)
// ---------------------------------------------------------------------------

test('P13 hybrid: recall beats vector-only (lexical finds an ANN-missed doc)', async () => {
	const { client, g } = await freshGraph();
	// A: lexical 'red' AND vector match (emb red).
	const a = await g.addNode({ kind: 'doc', props: { title: 'a' }, body: 'red', emb: VECTORS.red });
	// B: lexical 'red' only — NULL emb so the ANN index can never seed it.
	const b = await g.addNode({ kind: 'doc', props: { title: 'b' }, body: 'red' });
	// C: vector only — emb red but body has no 'red' token.
	const c = await g.addNode({ kind: 'doc', props: { title: 'c' }, body: 'fruit', emb: VECTORS.red });
	const relevant = new Set([a.id, b.id, c.id]);

	const vec = await retrieve(client, stubEmbed, { query: 'red', k: 10 });
	const vecIds = new Set(vec.map((r) => r.id));
	const hyb = await hybridRetrieve(client, stubEmbed, { query: 'red', k: 10 });
	const hybIds = new Set(hyb.map((r) => r.id));

	// vector-only misses the NULL-emb lexical doc B
	expect(vecIds.has(b.id)).toBe(false);
	// hybrid recovers it AND keeps the vector-only doc C
	expect(hybIds.has(a.id)).toBe(true);
	expect(hybIds.has(b.id)).toBe(true);
	expect(hybIds.has(c.id)).toBe(true);

	const recall = (s: Set<string>) => [...relevant].filter((id) => s.has(id)).length / relevant.size;
	expect(recall(hybIds)).toBeGreaterThan(recall(vecIds));
	expect(recall(hybIds)).toBe(1);
	client.close();
});

// ---------------------------------------------------------------------------
// RRF fuses on logical id, not ver — multi-version node (M5)
// ---------------------------------------------------------------------------

test('P13 hybrid: lexical seeds resolve ver→logical id and respect live/temporal filters', async () => {
	const client = makeTestDb().client;
	await init(client, 4);
	const x = '01ARZ3NDEKTSV4RRFFQ69G5FX1';
	const z = '01ARZ3NDEKTSV4RRFFQ69G5FZ1';
	const T1 = 100;
	const T2 = 200;

	// X has TWO versions: v1 'phoenix' (closed at T2), v2 'dragon' (live). NULL emb so
	// only the lexical leg can ever seed X — isolating the ver→id resolution.
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [x] });
	await client.execute({
		sql: 'INSERT INTO node_versions (ver, id, kind, body, valid_from, valid_to) VALUES (?,?,?,?,?,?)',
		args: [1, x, 'doc', 'phoenix', T1, T2],
	});
	await client.execute({
		sql: 'INSERT INTO node_versions (ver, id, kind, body, valid_from, valid_to) VALUES (?,?,?,?,?,?)',
		args: [2, x, 'doc', 'dragon', T2, FOREVER],
	});
	// Z: a decoy with a live embedding so the ANN index is non-empty.
	await client.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [z] });
	await client.execute({
		sql: `INSERT INTO node_versions (ver, id, kind, body, emb, valid_from, valid_to) VALUES (?,?,?,?,${embSql(client)},?,?)`,
		args: [3, z, 'doc', 'zzz', '[0,0,0,1]', T1, FOREVER],
	});

	// current 'dragon' → matches X's LIVE ver (v2) → X seeded exactly once.
	const curDragon = await hybridRetrieve(client, stubEmbed, { query: 'dragon', k: 10 });
	const xHits = curDragon.filter((r) => r.id === x);
	expect(xHits.length).toBe(1);
	expect(xHits[0]!.body).toBe('dragon');

	// current 'phoenix' → only X's HISTORICAL ver (v1) matches; live filter drops it →
	// X NOT seeded (proves we resolve ver→id→live, not blindly seed every matching ver).
	const curPhoenix = await hybridRetrieve(client, stubEmbed, { query: 'phoenix', k: 10 });
	expect(curPhoenix.some((r) => r.id === x)).toBe(false);

	// as-of 150 'phoenix' → v1 is the version valid at :t → X seeded with the v1 body
	// (proves the FTS index covers historical versions and as-of resolves the right ver).
	const pastPhoenix = await hybridRetrieve(client, stubEmbed, { query: 'phoenix', k: 10, asOf: 150 });
	const pastX = pastPhoenix.find((r) => r.id === x);
	expect(pastX).toBeDefined();
	expect(pastX!.body).toBe('phoenix');
	client.close();
});

test('P13 hybrid: a doc matched by BOTH legs outranks single-leg docs (RRF sums on id)', async () => {
	const { client, g } = await freshGraph();
	// M: vector (emb red) AND lexical ('red') — fused score sums both legs.
	const m = await g.addNode({ kind: 'doc', props: { title: 'm' }, body: 'red', emb: VECTORS.red });
	// N: vector only (emb red, body has no 'red').
	await g.addNode({ kind: 'doc', props: { title: 'n' }, body: 'fruit', emb: VECTORS.red });
	// O: lexical only (NULL emb, body 'red').
	await g.addNode({ kind: 'doc', props: { title: 'o' }, body: 'red' });

	// k=1: only the single highest fused-score seed survives truncation. Summing on id
	// lifts M above the single-leg docs.
	const res = await hybridRetrieve(client, stubEmbed, { query: 'red', k: 1, maxDepth: 0 });
	expect(res.length).toBe(1);
	expect(res[0]!.id).toBe(m.id);
	client.close();
});

// ---------------------------------------------------------------------------
// Rerank + MMR (§19.4)
// ---------------------------------------------------------------------------

test('P13 rerank: caller-provided reranker reorders and drops unscored candidates', async () => {
	const { client, g } = await freshGraph();
	const a = await g.addNode({ kind: 'doc', props: { title: 'a' }, body: 'red', emb: VECTORS.red });
	const b = await g.addNode({ kind: 'doc', props: { title: 'b' }, body: 'red', emb: VECTORS.red });
	const c = await g.addNode({ kind: 'doc', props: { title: 'c' }, body: 'red', emb: VECTORS.red });

	// rerank: score b highest, a next, DROP c entirely (no score returned).
	const res = await hybridRetrieve(client, stubEmbed, {
		query: 'red',
		k: 10,
		rerank: async (_q, cands) =>
			cands
				.filter((x) => x.id !== c.id)
				.map((x) => ({ id: x.id, score: x.id === b.id ? 2 : 1 })),
	});
	expect(res.map((r) => r.id)).toEqual([b.id, a.id]);
	expect(res.some((r) => r.id === c.id)).toBe(false);
	client.close();
});

test('P13 MMR: diversifies, dropping a near-duplicate for a distinct doc (λ, k configurable)', async () => {
	const { client, g } = await freshGraph();
	const d1 = await g.addNode({ kind: 'doc', props: { title: 'd1' }, body: 'red', emb: [1, 0, 0, 0] });
	const d2 = await g.addNode({ kind: 'doc', props: { title: 'd2' }, body: 'red', emb: [1, 0, 0, 0] }); // dup of d1
	const d3 = await g.addNode({ kind: 'doc', props: { title: 'd3' }, body: 'red', emb: [0, 1, 0, 0] }); // distinct

	// λ=0.3 favors diversity: after picking d1, the distinct d3 beats the near-dup d2.
	const res = await hybridRetrieve(client, stubEmbed, {
		query: 'a',
		k: 10,
		mmr: { k: 2, lambda: 0.3 },
	});
	const ids = res.map((r) => r.id);
	expect(ids.length).toBe(2);
	// the distinct doc is always kept...
	expect(ids).toContain(d3.id);
	// ...and exactly ONE of the identical-embedding near-dup pair survives (d1/d2 are
	// interchangeable; same-ms ULIDs are non-monotonic so which one is arbitrary).
	expect(Number(ids.includes(d1.id)) + Number(ids.includes(d2.id))).toBe(1);
	client.close();
});

test('P13 MMR: tolerates a candidate with no stored embedding (rel→0, no NaN/crash)', async () => {
	const { client, g } = await freshGraph();
	const e1 = await g.addNode({ kind: 'doc', props: { title: 'e1' }, body: 'red', emb: [1, 0, 0, 0] });
	// e2 has a matching lexical body but NULL emb — it must not crash MMR (cosine→0).
	await g.addNode({ kind: 'doc', props: { title: 'e2' }, body: 'red' });

	const res = await hybridRetrieve(client, stubEmbed, { query: 'red', k: 10, mmr: { k: 2, lambda: 0.5 } });
	// the embedded doc is selected; the run completes without NaN poisoning selection.
	expect(res.some((r) => r.id === e1.id)).toBe(true);
	expect(res.length).toBeGreaterThanOrEqual(1);
	client.close();
});

test('P13 rerank+MMR: reranker dropping every candidate yields [] without error', async () => {
	const { client, g } = await freshGraph();
	await g.addNode({ kind: 'doc', props: { title: 'a' }, body: 'red', emb: [1, 0, 0, 0] });
	const res = await hybridRetrieve(client, stubEmbed, {
		query: 'red',
		k: 10,
		rerank: async () => [], // drop everything
		mmr: { k: 5 },
	});
	expect(res).toEqual([]);
	client.close();
});
