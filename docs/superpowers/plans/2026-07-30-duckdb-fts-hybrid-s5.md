# DuckDB Full-Text Search and Hybrid Fusion — Stage 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give DuckDB a full-text index we build ourselves at commit time, so `ftsWhere`/`ftsSeedLive`/`ftsSeedAsOf` stop throwing `notYet` and hybrid retrieval works on the object-storage backend.

**Architecture:** Four ordinary tables (`fts_dict`, `fts_terms`, `fts_docs`, `fts_stats`) hold an inverted index keyed on `ver`. A commit rebuilds them in JavaScript from the local `node_versions`, writes them into the local DuckDB, and exports them to Parquet under the manifest's `indexes` field. A reader materializes them like any other table and computes BM25 as a plain SQL join — no `fts` extension, no `ATTACH`, no `USE`.

**Tech Stack:** TypeScript, Bun test, DuckDB (`@duckdb/node-api`), Parquet via `COPY … TO`.

## Global Constraints

- **Stage 4 is merged and green on `main` at `b121d2e`.** libSQL 1133 pass / 6 skip / 0 fail, Postgres 1117 / 22 / 0, DuckDB 1090 / 26 / 23. This plan must not regress libSQL or Postgres — both are verified after every task that touches shared code.
- **The 23 DuckDB failures are 21 full-text + 2 documented raw-SQL constraint bypasses.** This plan closes the 21. The 2 are permanent and documented in `docs/DUCKDB_SUPPORT.md`; do not attempt to close them.
- **No new runtime dependency in `packages/core`.** It is a published library with 6 dependencies. The `fts` DuckDB extension is excluded on evidence (spec §10.2): it cannot index a view or `read_parquet`, never updates incrementally, and its documented tuning parameters do not exist in any released build.
- **Test with `GRAPHX_TEST_DRIVER=duckdb`.** Postgres needs a dedicated fresh container on port 5455 (`pgvector/pgvector:pg17`); a shared one produces spurious timeouts (Task 13 of the stage 1–4 plan established this).
- **Bound-argument counts must match libSQL's exactly** for every fragment, because `hybrid.ts` and `retrieval-legs.ts` bind positionally from one code path for all three dialects.
- **`ver` is the document key**, not `id`. One node has many versions; the index covers every one, which is what makes as-of lexical search exact.
- **Only `body` is indexed.** That is what libSQL's `nodes_fts` trigger mirrors (`INSERT INTO nodes_fts(rowid, body) VALUES (new.ver, new.body)`).

## Scope decisions

Two deviations from spec §10.2, both deliberate, both ruled by the user:

1. **No stemming in v1.** §10.2 argues for owning a stemmer on both sides. Measured: libSQL's `fts5(body, …)` uses the default `unicode61` tokenizer and does **not** stem — `"run"` returns 0 rows against a document containing `running runs`. libSQL is the backend the committed golden rankings in `eval-golden` were measured against, and cross-dialect parity already tolerates Postgres stemming while libSQL does not. Matching libSQL exactly is therefore both the smaller plan and the one most likely to hold parity. The recall gap versus Postgres is documented, not hidden. Adding stemming later is purely additive: writer and reader share one tokenizer module and the index rebuilds on every commit, so there is no migration.
2. **§10.1 is already done.** The spec lists brute-force ANN as stage 5 work, but Task 10 of the stage 1–4 plan already landed `annSeedsLive`, `annSeedsAsOf`, and `vecSeedLive` for `duckdb` using `min_by(id, list_cosine_distance(…), k)`. Nothing in this plan touches vector search. Stage 5 is §10.2 plus the fusion wiring that depends on it.

## File Structure

**Created:**
- `packages/core/src/fts/tokenize.ts` — the one tokenizer, used by the writer to index and by the reader to parse a query. Owning both sides is the whole point; if these ever diverge, search silently returns nothing.
- `packages/core/src/fts/build.ts` — pure, database-free construction of the four index tables from `{ver, body}` rows. Pure so it is testable without DuckDB and so the writer path has no hidden SQL.
- `packages/core/src/fts/index-tables.ts` — the local DDL, the table-name constants, and the rebuild/export plumbing that connects `build.ts` to a `DbClient`.
- `packages/core/test/fixtures/fts-ground-truth.json` — measured BM25 scores and rank orders from DuckDB's own `fts` extension and from libSQL FTS5. Committed so the suite never needs either extension at test time.
- `packages/core/scripts/measure-fts-ground-truth.ts` — regenerates that fixture. Run by hand, not by CI.
- `packages/core/test/fts-tokenize.test.ts`, `fts-build.test.ts`, `fts-bm25.test.ts`, `fts-roundtrip.test.ts`.

**Modified:**
- `packages/core/src/dialect-sql.ts` — `duckdbSchema()` gains the four tables; `ftsWhere`, `ftsSeedLive`, `ftsSeedAsOf` gain `duckdb` arms.
- `packages/core/src/duck-materialize.ts` — load `manifest.indexes` alongside `manifest.tables`.
- `packages/core/src/duck-commit.ts` — rebuild and export the index when `node_versions` is dirty.
- `packages/core/src/hybrid.ts` — `ftsArg(dialect, query)` replaces the two-way `d === 'postgres' ? query : match` ternaries.
- `packages/core/src/graph.ts` — `nodeFilter` uses `ftsArg`.
- `packages/core/test/retrieval-legs.ts` — same.
- `packages/core/src/index.ts` — export `ftsArg`.
- `docs/DUCKDB_SUPPORT.md`, `.github/workflows/ci.yml` — final parity record and the CI gate.

---

### Task 1: Measure the ground truth

Everything downstream is written against measured numbers rather than a recalled formula. Two references get captured: DuckDB's `match_bm25` (validates our arithmetic) and libSQL FTS5's rank order (the ranking the committed golden files were built against).

Both references need extensions that the test suite must never require, so this task produces a **committed fixture** and a script that regenerates it.

**Files:**
- Create: `packages/core/scripts/measure-fts-ground-truth.ts`
- Create: `packages/core/test/fixtures/fts-ground-truth.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `fts-ground-truth.json`, shape:
  ```ts
  interface FtsGroundTruth {
    corpus: { ver: number; body: string }[];
    /** DuckDB fts tables, for structural comparison. */
    duckdb: {
      dict: { term: string; df: number }[];
      docs: { docid: number; len: number }[];
      stats: { num_docs: number; avgdl: number };
      /** query -> [{ver, score}] from match_bm25, score DESC. */
      bm25: Record<string, { ver: number; score: number }[]>;
    };
    /** query -> ver[] in FTS5 rank order. The ranking parity target. */
    libsql: Record<string, number[]>;
  }
  ```

- [ ] **Step 1: Write the measurement script**

The corpus is deliberately stem-invariant — every word is already its own stem — so the two engines' tokenizers agree and the only variable left is the BM25 arithmetic. Terms repeat at different frequencies so `tf`, `df`, and `len` all vary.

```ts
// packages/core/scripts/measure-fts-ground-truth.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { createDuckClient } from '../src/duck.ts';

/**
 * Regenerate test/fixtures/fts-ground-truth.json.
 *
 * Run by hand (`bun packages/core/scripts/measure-fts-ground-truth.ts`), never by CI: it
 * needs DuckDB's `fts` extension, which downloads on first use. The whole point of
 * committing the output is that the suite needs neither extension.
 */

const CORPUS = [
  { ver: 1, body: 'graph database with temporal edges' },
  { ver: 2, body: 'temporal graph query language' },
  { ver: 3, body: 'vector search over a graph' },
  { ver: 4, body: 'full text search with bm25 ranking' },
  { ver: 5, body: 'graph graph graph repeated term document' },
  { ver: 6, body: 'a document about storage and object storage' },
  { ver: 7, body: 'edges connect nodes in a graph database' },
  { ver: 8, body: 'nothing in common here' },
];

const QUERIES = ['graph', 'graph database', 'temporal search', 'storage', 'missing'];

async function duckdbTruth() {
  const c = createDuckClient();
  await c.execute('INSTALL fts');
  await c.execute('LOAD fts');
  await c.execute('CREATE TABLE docs (ver BIGINT, body VARCHAR)');
  for (const d of CORPUS) {
    await c.execute({ sql: 'INSERT INTO docs VALUES (?, ?)', args: [d.ver, d.body] });
  }
  // stemmer := 'none' isolates the arithmetic from the stemmer, matching our v1 tokenizer.
  await c.execute(`PRAGMA create_fts_index('docs', 'ver', 'body', stemmer := 'none')`);

  const rows = async (sql: string) => (await c.execute(sql)).rows;
  const dict = (await rows('SELECT term, df FROM fts_main_docs.dict ORDER BY term')).map((r) => ({
    term: String(r.term),
    df: Number(r.df),
  }));
  const docs = (await rows('SELECT docid, len FROM fts_main_docs.docs ORDER BY docid')).map((r) => ({
    docid: Number(r.docid),
    len: Number(r.len),
  }));
  const s = (await rows('SELECT num_docs, avgdl FROM fts_main_docs.stats'))[0];
  const stats = { num_docs: Number(s?.num_docs), avgdl: Number(s?.avgdl) };

  const bm25: Record<string, { ver: number; score: number }[]> = {};
  for (const q of QUERIES) {
    const r = await c.execute({
      sql: `SELECT ver, fts_main_docs.match_bm25(ver, ?) AS score
            FROM docs
            WHERE score IS NOT NULL
            ORDER BY score DESC, ver`,
      args: [q],
    });
    bm25[q] = r.rows.map((row) => ({ ver: Number(row.ver), score: Number(row.score) }));
  }
  await c.end();
  return { dict, docs, stats, bm25 };
}

async function libsqlTruth() {
  const c = createClient({ url: ':memory:' });
  await c.execute(`CREATE VIRTUAL TABLE d USING fts5(body)`);
  for (const doc of CORPUS) {
    await c.execute({ sql: 'INSERT INTO d(rowid, body) VALUES (?, ?)', args: [doc.ver, doc.body] });
  }
  const out: Record<string, number[]> = {};
  for (const q of QUERIES) {
    // The same OR-of-quoted-tokens shape sanitizeMatch produces.
    const match = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    const r = await c.execute({
      sql: `SELECT rowid FROM d WHERE d MATCH ? ORDER BY rank`,
      args: [match],
    });
    out[q] = r.rows.map((row) => Number(row.rowid));
  }
  return out;
}

const truth = { corpus: CORPUS, duckdb: await duckdbTruth(), libsql: await libsqlTruth() };
const path = join(import.meta.dir, '../test/fixtures/fts-ground-truth.json');
writeFileSync(path, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`wrote ${path}`);
```

- [ ] **Step 2: Run it**

```bash
mkdir -p packages/core/test/fixtures
bun packages/core/scripts/measure-fts-ground-truth.ts
```

Expected: the file is written. If `INSTALL fts` fails (no network), stop and report — do not hand-write the fixture. A fabricated ground truth is worse than none, because every downstream task would be verified against a guess.

- [ ] **Step 3: Read the fixture and record what it says**

Open the JSON and confirm three things by eye, because the next four tasks assume them:

1. `duckdb.stats.avgdl` equals the mean token count over the corpus. If DuckDB counts tokens differently than a naive whitespace split (it lowercases and strips non-alphanumerics), the tokenizer in Task 2 must match whatever this shows.
2. `duckdb.dict` contains lowercase terms only, and no stopwords were dropped (we passed no stopword list).
3. `duckdb.bm25.missing` is an empty array — a query whose terms are absent scores nothing rather than erroring.

Write what you found into the task report. Task 4 derives the BM25 constants from `duckdb.bm25` by fitting, so anything surprising here changes that task.

- [ ] **Step 4: Commit**

```bash
git add packages/core/scripts/measure-fts-ground-truth.ts packages/core/test/fixtures/fts-ground-truth.json
git commit -m "test(core): measure DuckDB and libSQL full-text ground truth

Committed so the suite never needs either engine's FTS extension. The
corpus is stem-invariant on purpose: with the stemmer removed as a
variable, a mismatch downstream can only be tokenization or arithmetic."
```

---

### Task 2: The tokenizer

One module, used by the writer to build the index and by the reader to parse a query. If these ever diverge, search returns nothing and no test outside this file would notice — which is why the module exists at all rather than two inline splits.

**Files:**
- Create: `packages/core/src/fts/tokenize.ts`
- Test: `packages/core/test/fts-tokenize.test.ts`

**Interfaces:**
- Consumes: `test/fixtures/fts-ground-truth.json` (Task 1).
- Produces:
  - `export function tokenize(text: string): string[]` — lowercase terms in document order, duplicates kept (the caller counts them).
  - `export const TOKEN_SPLIT: RegExp` — exported for the golden test to assert the exact boundary rule.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/fts-tokenize.test.ts
import { describe, expect, test } from 'bun:test';
import truth from './fixtures/fts-ground-truth.json';
import { tokenize } from '../src/fts/tokenize.ts';

describe('tokenize', () => {
  test('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Graph-Database, v2!')).toEqual(['graph', 'database', 'v2']);
  });

  test('keeps duplicates in document order — the caller counts them', () => {
    expect(tokenize('graph graph node')).toEqual(['graph', 'graph', 'node']);
  });

  test('yields nothing for text with no usable characters', () => {
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!! ??? ---')).toEqual([]);
  });

  test('does not stem — v1 matches libSQL unicode61, which does not either', () => {
    expect(tokenize('running runs')).toEqual(['running', 'runs']);
  });

  test('agrees with DuckDB on every document length in the ground truth', () => {
    // avgdl and len come straight from token counts, so a tokenizer that disagrees
    // silently shifts every BM25 score. This pins it against a measured reference.
    const lenByVer = new Map(truth.duckdb.docs.map((d) => [d.docid, d.len]));
    for (const doc of truth.corpus) {
      expect(tokenize(doc.body).length).toBe(lenByVer.get(doc.ver) as number);
    }
  });

  test('agrees with DuckDB on the exact vocabulary', () => {
    const ours = new Set(truth.corpus.flatMap((d) => tokenize(d.body)));
    const theirs = new Set(truth.duckdb.dict.map((d) => d.term));
    expect([...ours].sort()).toEqual([...theirs].sort());
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/fts-tokenize.test.ts`
Expected: FAIL — `Cannot find module '../src/fts/tokenize.ts'`.

- [ ] **Step 3: Write the tokenizer**

```ts
// packages/core/src/fts/tokenize.ts
/**
 * The one tokenizer, shared by the writer that builds the index and the reader that parses
 * a query.
 *
 * Sharing is the entire design constraint. An index built with one tokenization and queried
 * with another returns nothing at all — not fewer results, none — and no test outside this
 * module's own would catch it, because both halves would look individually reasonable.
 *
 * v1 does not stem. libSQL's `fts5(body, …)` uses the default `unicode61` tokenizer, which
 * does not stem either (measured: `"run"` matches no document containing `running runs`),
 * and libSQL is the backend the committed golden rankings were measured against. Matching it
 * keeps ranking parity honest. Postgres does stem, so its lexical recall is genuinely higher
 * on inflected queries; that difference is recorded in docs/DUCKDB_SUPPORT.md rather than
 * papered over. Adding a stemmer later is additive — the index is rebuilt on every commit,
 * so writer and reader change together and there is nothing to migrate.
 */

/**
 * Term boundary: any run of characters that is neither a letter nor a number, Unicode-aware.
 * Matches `unicode61`'s default class, which treats everything outside those two categories
 * as a separator.
 */
export const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/** Lowercase terms in document order. Duplicates are kept — term frequency is the caller's. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(TOKEN_SPLIT).filter((t) => t.length > 0);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/fts-tokenize.test.ts`
Expected: PASS, 6 tests.

If the two ground-truth tests fail, the tokenizer disagrees with DuckDB — fix the tokenizer, never the fixture. Common cause: DuckDB strips diacritics, so `café` becomes `cafe`. If the fixture shows that, add `.normalize('NFD').replace(/\p{M}+/gu, '')` before lowercasing and note it in the module comment.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/fts/tokenize.ts packages/core/test/fts-tokenize.test.ts
git commit -m "feat(core): add the shared full-text tokenizer

One tokenizer for the writer and the reader. Divergence between the two
returns nothing at all rather than degrading, and nothing outside this
module would notice, which is why it is a module. No stemming in v1:
libSQL's unicode61 does not stem either, and it is the reference the
committed golden rankings were measured against."
```

---

### Task 3: Build the index tables in memory

Pure and database-free, so the arithmetic is testable without DuckDB and the writer path has no hidden SQL.

**Files:**
- Create: `packages/core/src/fts/build.ts`
- Test: `packages/core/test/fts-build.test.ts`

**Interfaces:**
- Consumes: `tokenize` (Task 2).
- Produces:
  ```ts
  export interface FtsDoc { ver: number; len: number; live: boolean }
  export interface FtsTerm { ver: number; term: string; tf: number; live: boolean }
  export interface FtsDictEntry { term: string; df: number }
  export interface FtsStats { num_docs: number; avgdl: number }
  export interface FtsIndex {
    docs: FtsDoc[];
    terms: FtsTerm[];
    dict: FtsDictEntry[];
    stats: FtsStats;
  }
  export function buildIndex(rows: { ver: number; body: string | null; live: boolean }[]): FtsIndex;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/fts-build.test.ts
import { describe, expect, test } from 'bun:test';
import { buildIndex } from '../src/fts/build.ts';

const rows = [
  { ver: 1, body: 'graph database', live: true },
  { ver: 2, body: 'graph graph query', live: true },
  { ver: 3, body: 'unrelated', live: false },
];

describe('buildIndex', () => {
  test('counts term frequency per version', () => {
    const ix = buildIndex(rows);
    const t = ix.terms.find((x) => x.ver === 2 && x.term === 'graph');
    expect(t?.tf).toBe(2);
  });

  test('document frequency counts versions, not occurrences', () => {
    const ix = buildIndex(rows);
    // 'graph' appears 3 times total but in 2 documents.
    expect(ix.dict.find((d) => d.term === 'graph')?.df).toBe(2);
  });

  test('document length is the token count, including duplicates', () => {
    const ix = buildIndex(rows);
    expect(ix.docs.find((d) => d.ver === 2)?.len).toBe(3);
  });

  test('stats cover live and history together', () => {
    const ix = buildIndex(rows);
    // A per-scope avgdl would make the same document score differently depending on
    // whether the query was live-only, which is not a property anyone wants.
    expect(ix.stats.num_docs).toBe(3);
    expect(ix.stats.avgdl).toBeCloseTo((2 + 3 + 1) / 3, 10);
  });

  test('carries the live flag through, so the export can split the files', () => {
    const ix = buildIndex(rows);
    expect(ix.docs.find((d) => d.ver === 3)?.live).toBe(false);
    expect(ix.terms.filter((t) => !t.live).map((t) => t.term)).toEqual(['unrelated']);
  });

  test('skips a null body without counting it as a document', () => {
    const ix = buildIndex([{ ver: 9, body: null, live: true }, ...rows]);
    expect(ix.stats.num_docs).toBe(3);
    expect(ix.docs.some((d) => d.ver === 9)).toBe(false);
  });

  test('skips a body with no usable tokens', () => {
    const ix = buildIndex([{ ver: 9, body: '!!!', live: true }, ...rows]);
    expect(ix.stats.num_docs).toBe(3);
  });

  test('an empty corpus yields avgdl 0 rather than NaN', () => {
    // A division by zero here propagates NaN into every BM25 score, and NaN sorts
    // unpredictably rather than erroring — a silent wrong answer.
    const ix = buildIndex([]);
    expect(ix.stats).toEqual({ num_docs: 0, avgdl: 0 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/fts-build.test.ts`
Expected: FAIL — `Cannot find module '../src/fts/build.ts'`.

- [ ] **Step 3: Write the builder**

```ts
// packages/core/src/fts/build.ts
import { tokenize } from './tokenize.ts';

/**
 * Building the inverted index from `node_versions` rows.
 *
 * Pure and database-free: the arithmetic that decides every search ranking is testable
 * without a DuckDB instance, and the writer path holds no SQL of its own.
 *
 * The index is keyed on `ver`, not `id`. One node has many versions and each is indexed
 * separately, which is what makes as-of lexical search exact rather than best-effort — the
 * property `ftsSeedAsOf` relies on.
 */

/** One indexed document. `live` drives the Parquet file split, not the scoring. */
export interface FtsDoc {
  ver: number;
  len: number;
  live: boolean;
}

/** One (document, term) posting. */
export interface FtsTerm {
  ver: number;
  term: string;
  tf: number;
  live: boolean;
}

/** Corpus-wide document frequency for a term. */
export interface FtsDictEntry {
  term: string;
  df: number;
}

/** Corpus-wide BM25 normalizers. */
export interface FtsStats {
  num_docs: number;
  avgdl: number;
}

export interface FtsIndex {
  docs: FtsDoc[];
  terms: FtsTerm[];
  dict: FtsDictEntry[];
  stats: FtsStats;
}

/**
 * Build the four index tables from every version that has indexable text.
 *
 * `dict` and `stats` are computed over live and history TOGETHER. A per-scope `avgdl` would
 * make one document score differently depending on whether the caller asked for live-only or
 * as-of results, which is not a property any caller wants and would break the golden rankings
 * the moment history grew.
 */
export function buildIndex(
  rows: { ver: number; body: string | null; live: boolean }[],
): FtsIndex {
  const docs: FtsDoc[] = [];
  const terms: FtsTerm[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const row of rows) {
    if (row.body === null) continue;
    const tokens = tokenize(row.body);
    if (tokens.length === 0) continue; // nothing to match; not a document

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    docs.push({ ver: row.ver, len: tokens.length, live: row.live });
    totalLen += tokens.length;
    for (const [term, n] of tf) {
      terms.push({ ver: row.ver, term, tf: n, live: row.live });
      // Once per document, not once per occurrence — df counts documents.
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const dict = [...df.entries()]
    .map(([term, n]) => ({ term, df: n }))
    .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

  return {
    docs,
    terms,
    dict,
    // Guard the empty corpus: 0/0 is NaN, and a NaN score sorts unpredictably instead of
    // erroring, so it would surface as a silently wrong ranking rather than a failure.
    stats: { num_docs: docs.length, avgdl: docs.length === 0 ? 0 : totalLen / docs.length },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/fts-build.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/fts/build.ts packages/core/test/fts-build.test.ts
git commit -m "feat(core): build the full-text index tables in memory

Pure and database-free, so the arithmetic behind every ranking is
testable without a DuckDB instance. df and avgdl span live and history
together: a per-scope avgdl would score one document differently
depending on whether the caller asked for live or as-of results."
```

---

### Task 4: The BM25 SQL, verified against the ground truth

The scoring join, checked against DuckDB's own `match_bm25` output from Task 1. This task deliberately lands *before* any commit or materialize plumbing, so the arithmetic is proven against a fixture on hand-built tables — with nothing else that could be at fault.

**Files:**
- Create: `packages/core/src/fts/index-tables.ts`
- Test: `packages/core/test/fts-bm25.test.ts`

**Interfaces:**
- Consumes: `FtsIndex` (Task 3).
- Produces:
  - `export const FTS_TABLES: readonly string[]` — `['fts_dict', 'fts_docs', 'fts_terms', 'fts_stats']`.
  - `export const FTS_DDL: string` — the four `CREATE TABLE IF NOT EXISTS` statements.
  - `export function bm25Cte(scope: 'live' | 'asof' | 'any'): string` — a `scored(ver, score)` CTE body.
  - `export const BM25_K1 = 1.2`, `export const BM25_B = 0.75`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/fts-bm25.test.ts
import { describe, expect, test } from 'bun:test';
import truth from './fixtures/fts-ground-truth.json';
import { createDuckClient } from '../src/duck.ts';
import { buildIndex } from '../src/fts/build.ts';
import { bm25Cte, FTS_DDL } from '../src/fts/index-tables.ts';
import { tokenize } from '../src/fts/tokenize.ts';

/** A DuckDB loaded with our index over the ground-truth corpus. No fts extension involved. */
async function indexed() {
  const c = createDuckClient();
  await c.executeMultiple(FTS_DDL);
  const ix = buildIndex(truth.corpus.map((d) => ({ ver: d.ver, body: d.body, live: true })));
  for (const d of ix.docs) {
    await c.execute({ sql: 'INSERT INTO fts_docs VALUES (?,?,?)', args: [d.ver, d.len, d.live] });
  }
  for (const t of ix.terms) {
    await c.execute({
      sql: 'INSERT INTO fts_terms VALUES (?,?,?,?)',
      args: [t.ver, t.term, t.tf, t.live],
    });
  }
  for (const d of ix.dict) {
    await c.execute({ sql: 'INSERT INTO fts_dict VALUES (?,?)', args: [d.term, d.df] });
  }
  await c.execute({
    sql: 'INSERT INTO fts_stats VALUES (?,?)',
    args: [ix.stats.num_docs, ix.stats.avgdl],
  });
  return c;
}

async function score(c: Awaited<ReturnType<typeof indexed>>, query: string) {
  const r = await c.execute({
    sql: `WITH scored AS (${bm25Cte('any')}) SELECT ver, score FROM scored ORDER BY score DESC, ver`,
    args: [JSON.stringify(tokenize(query))],
  });
  return r.rows.map((row) => ({ ver: Number(row.ver), score: Number(row.score) }));
}

describe('bm25', () => {
  test('reproduces DuckDB match_bm25 to within floating-point noise', async () => {
    // The whole reason Task 1 exists. If this drifts, the formula is wrong - not the fixture.
    const c = await indexed();
    for (const [query, expected] of Object.entries(truth.duckdb.bm25)) {
      const got = await score(c, query);
      expect(got.map((g) => g.ver)).toEqual(expected.map((e) => e.ver));
      for (let i = 0; i < expected.length; i++) {
        expect(got[i]?.score).toBeCloseTo(expected[i]?.score as number, 6);
      }
    }
    await c.end();
  });

  test('a query whose terms are all absent scores nothing rather than erroring', async () => {
    const c = await indexed();
    expect(await score(c, 'missing')).toEqual([]);
    await c.end();
  });

  test('an empty term list scores nothing', async () => {
    // sanitizeMatch returns null here and the caller skips the leg, but the SQL must not
    // blow up if it is ever reached with an empty array.
    const c = await indexed();
    const r = await c.execute({
      sql: `WITH scored AS (${bm25Cte('any')}) SELECT count(*) AS n FROM scored`,
      args: ['[]'],
    });
    expect(r.rows[0]?.n).toBe(0);
    await c.end();
  });

  test('a repeated term outranks a single mention of it', async () => {
    const c = await indexed();
    const ranked = await score(c, 'graph');
    // ver 5 is 'graph graph graph repeated term document'.
    expect(ranked[0]?.ver).toBe(5);
    await c.end();
  });

  test('the live scope excludes history rows', async () => {
    const c = await indexed();
    await c.execute(`UPDATE fts_docs SET live = false WHERE ver = 5`);
    await c.execute(`UPDATE fts_terms SET live = false WHERE ver = 5`);
    const r = await c.execute({
      sql: `WITH scored AS (${bm25Cte('live')}) SELECT ver FROM scored ORDER BY score DESC`,
      args: [JSON.stringify(tokenize('graph'))],
    });
    expect(r.rows.map((row) => Number(row.ver))).not.toContain(5);
    await c.end();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/fts-bm25.test.ts`
Expected: FAIL — `Cannot find module '../src/fts/index-tables.ts'`.

- [ ] **Step 3: Write the DDL and the scoring CTE**

```ts
// packages/core/src/fts/index-tables.ts
/**
 * The local shape of the full-text index, and the BM25 join that reads it.
 *
 * Four ordinary tables, materialized from Parquet like any other. Readers need no `fts`
 * extension, no `ATTACH`, and no `USE <catalog>` — the extension route forces all three, and
 * its `match_bm25` macro references `fts_main_<table>` unqualified, so it cannot be queried
 * across catalogs at all.
 */

/** Every table the index occupies. Load order is irrelevant — no foreign keys between them. */
export const FTS_TABLES = ['fts_dict', 'fts_docs', 'fts_terms', 'fts_stats'] as const;

/**
 * BM25 saturation and length-normalization constants. These are DuckDB's `match_bm25`
 * defaults, pinned by the ground-truth comparison in fts-bm25.test.ts rather than by faith.
 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * `live` is denormalized onto both `fts_docs` and `fts_terms` so a live-only query never
 * joins the two just to filter, and so the export can split each into live and history file
 * sets without a second pass.
 */
export const FTS_DDL = `
CREATE TABLE IF NOT EXISTS fts_dict (term VARCHAR PRIMARY KEY, df BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS fts_docs (ver BIGINT PRIMARY KEY, len BIGINT NOT NULL, live BOOLEAN NOT NULL);
CREATE TABLE IF NOT EXISTS fts_terms (ver BIGINT NOT NULL, term VARCHAR NOT NULL, tf BIGINT NOT NULL, live BOOLEAN NOT NULL);
CREATE INDEX IF NOT EXISTS fts_terms_term ON fts_terms(term);
CREATE TABLE IF NOT EXISTS fts_stats (num_docs BIGINT NOT NULL, avgdl DOUBLE NOT NULL);
`;

/**
 * A `scored(ver, score)` CTE body. Consumes ONE bound arg: a JSON array of query terms.
 *
 * The terms arrive as JSON rather than as N placeholders because every caller binds
 * positionally from one code path shared with libSQL and Postgres, and those two spend
 * exactly one argument on the query. A variable placeholder count here would force every
 * caller to branch on dialect just to count arguments.
 *
 * `scope` picks the document set: `live` for current-time queries, `asof`/`any` for the rest.
 * As-of filtering happens in the caller against `node_versions`, not here — the index covers
 * every version, so restricting it by time is the caller's temporal predicate to apply.
 */
export function bm25Cte(scope: 'live' | 'asof' | 'any'): string {
  const liveFilter = scope === 'live' ? 'AND t.live AND d.live' : '';
  return `
  SELECT t.ver AS ver,
         sum(
           ln(((s.num_docs - dc.df + 0.5) / (dc.df + 0.5)) + 1)
           * (t.tf * (${BM25_K1} + 1))
           / (t.tf + ${BM25_K1} * (1 - ${BM25_B} + ${BM25_B} * d.len / s.avgdl))
         ) AS score
  FROM (SELECT unnest(from_json(?, '["VARCHAR"]')) AS term) q
  JOIN fts_terms t ON t.term = q.term
  JOIN fts_dict dc ON dc.term = q.term
  JOIN fts_docs d ON d.ver = t.ver
  CROSS JOIN fts_stats s
  WHERE TRUE ${liveFilter}
  GROUP BY t.ver`;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/core/test/fts-bm25.test.ts`
Expected: PASS, 5 tests.

If the first test fails on scores while the rank order matches, the constants or the IDF form are wrong. Fit them from the fixture rather than guessing: a single-term query over a document of known `len` reduces the formula to one unknown at a time. Do NOT relax `toBeCloseTo` to make it pass — the tolerance is what makes this test worth having.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/fts/index-tables.ts packages/core/test/fts-bm25.test.ts
git commit -m "feat(core): add the BM25 scoring join over our own index

Verified against DuckDB's own match_bm25 output on a committed fixture,
so the arithmetic is proven before any commit or materialize plumbing
exists to be blamed for a mismatch. Query terms arrive as one JSON array
rather than N placeholders: every caller binds positionally from a path
shared with libSQL and Postgres, which spend one argument each."
```

---

### Task 5: Materialize the index, and rebuild it on commit

The round trip. The index becomes part of a snapshot: rebuilt from the local `node_versions` when it is dirty, exported to Parquet under `manifest.indexes`, and loaded back by any reader.

**Files:**
- Modify: `packages/core/src/dialect-sql.ts` (`duckdbSchema` — append `FTS_DDL`)
- Modify: `packages/core/src/duck-materialize.ts` (load `manifest.indexes`)
- Modify: `packages/core/src/duck-commit.ts` (rebuild + export)
- Modify: `packages/core/src/fts/index-tables.ts` (add `rebuildIndex`)
- Test: `packages/core/test/fts-roundtrip.test.ts`

**Interfaces:**
- Consumes: `buildIndex` (Task 3); `FTS_TABLES`, `FTS_DDL` (Task 4); `exportTable`, `buildManifest` (stage 4, `duck-commit.ts`); `materialize`, `LoadTarget` (stage 4, `duck-materialize.ts`).
- Produces:
  - `export async function rebuildIndex(client: Pick<DbClient, 'execute'>): Promise<void>` — in `fts/index-tables.ts`. Truncates and repopulates the four tables from `node_versions`.
  - `manifest.indexes` gains three groups: `fts_live` and `fts_history` (each `{ fts_docs: [key], fts_terms: [key] }`), and `fts_global` (`{ fts_dict: [key], fts_stats: [key] }`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/fts-roundtrip.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { createDuckClient, type DuckClient } from '../src/duck.ts';
import { Graph } from '../src/graph.ts';
import { MemoryObjectStore } from '../src/objstore/memory.ts';

const root = mkdtempSync(join(tmpdir(), 'graphx-fts-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SCHEMA = defineGraphSchema({
  nodes: { Doc: z.object({ slug: z.string().optional() }) },
  edges: {},
});

function client(store: MemoryObjectStore): DuckClient {
  return createDuckClient({ store, cacheDir: mkdtempSync(join(root, 'c-')) });
}

describe('full-text round trip', () => {
  test('a committed index is readable by a second client', async () => {
    const store = new MemoryObjectStore();
    const w = client(store);
    const g = new Graph(w, SCHEMA);
    await g.write(async (s) => {
      await s.addNode({ type: 'Doc', body: 'temporal graph database', data: {} });
      await s.addNode({ type: 'Doc', body: 'vector search engine', data: {} });
    });
    await w.end();

    const r = client(store);
    await r.open();
    const rows = await r.execute({
      sql: `SELECT count(*) AS n FROM fts_terms WHERE term = ?`,
      args: ['graph'],
    });
    expect(rows.rows[0]?.n).toBe(1);
    await r.end();
  });

  test('the manifest splits live and history index files', async () => {
    const store = new MemoryObjectStore();
    const c = client(store);
    const g = new Graph(c, SCHEMA);
    const n = await g.addNode({ type: 'Doc', body: 'original text', data: {} });
    await g.updateNode(n.id, { body: 'replacement text' });
    const m = c.snapshot();
    // The superseded version is history; the successor is live. Both are indexed.
    expect(m?.indexes.fts_live?.fts_docs?.length).toBe(1);
    expect(m?.indexes.fts_history?.fts_docs?.length).toBe(1);
    expect(m?.indexes.fts_global?.fts_dict?.length).toBe(1);
    await c.end();
  });

  test('the index tracks an update — the old body stops matching live', async () => {
    const store = new MemoryObjectStore();
    const c = client(store);
    const g = new Graph(c, SCHEMA);
    const n = await g.addNode({ type: 'Doc', body: 'sphinx', data: {} });
    await g.updateNode(n.id, { body: 'griffin' });
    const live = await c.execute({
      sql: `SELECT term FROM fts_terms WHERE live AND term IN ('sphinx','griffin')`,
    });
    expect(live.rows.map((r) => String(r.term))).toEqual(['griffin']);
    // ...but history still carries it, which is what makes as-of lexical search exact.
    const all = await c.execute({
      sql: `SELECT count(*) AS n FROM fts_terms WHERE term = 'sphinx'`,
    });
    expect(all.rows[0]?.n).toBe(1);
    await c.end();
  });

  test('a commit that does not touch node_versions leaves the index files alone', async () => {
    const store = new MemoryObjectStore();
    const c = client(store);
    await c.open();
    await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
    const first = await c.commit(new Set(['node_identity']));
    await c.execute({
      sql: 'INSERT INTO archival_state VALUES (?,?,?)',
      args: ['node_versions', 1, 1],
    });
    const second = await c.commit(new Set(['archival_state']));
    // Rebuilding an index nobody invalidated would make every commit cost the whole corpus.
    expect(second.indexes).toEqual(first.indexes);
    await c.end();
  });

  test('an empty corpus commits an index with no files rather than empty ones', async () => {
    const store = new MemoryObjectStore();
    const c = client(store);
    await c.open();
    await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: ['n1'] });
    const m = await c.commit(new Set(['node_versions']));
    expect(m.indexes.fts_live?.fts_docs ?? []).toEqual([]);
    await c.end();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `GRAPHX_TEST_DRIVER=duckdb bun test packages/core/test/fts-roundtrip.test.ts`
Expected: FAIL — `Catalog Error: Table with name fts_terms does not exist`.

- [ ] **Step 3: Add the tables to the local schema**

In `packages/core/src/dialect-sql.ts`, import the DDL and append it to `duckdbSchema`'s returned string, just before the closing backtick:

```ts
import { FTS_DDL } from './fts/index-tables.ts';
```

```ts
CREATE INDEX IF NOT EXISTS na_degree ON node_analytics(degree);
${FTS_DDL}
`;
}
```

- [ ] **Step 4: Add the rebuild**

Append to `packages/core/src/fts/index-tables.ts`:

```ts
import type { DbClient } from '../dialect.ts';
import { buildIndex } from './build.ts';
import { FOREVER } from '../db.ts';

/**
 * Rebuild the whole index from the local `node_versions`.
 *
 * A full rebuild, not an incremental update. The index is a derived artifact republished on
 * every commit that touches `node_versions`, so an incremental path would buy nothing but a
 * second code path that can disagree with the first — and the disagreement would surface as
 * silently missing search results. When corpus size makes this cost real, the fix is a
 * per-file delta in the manifest (`TableRef.files` is already a list), not incremental
 * mutation of a local table.
 */
export async function rebuildIndex(client: Pick<DbClient, 'execute'>): Promise<void> {
  const r = await client.execute(
    `SELECT ver, body, valid_to FROM node_versions WHERE body IS NOT NULL`,
  );
  const ix = buildIndex(
    r.rows.map((row) => ({
      ver: Number(row.ver),
      body: row.body === null ? null : String(row.body),
      live: Number(row.valid_to) === FOREVER,
    })),
  );

  for (const t of FTS_TABLES) await client.execute(`DELETE FROM ${t}`);
  if (ix.docs.length === 0) return; // nothing indexable; leave the tables empty

  // Chunked multi-row inserts: a statement per posting is thousands of round trips on a
  // corpus of any size.
  const chunk = <T>(xs: T[], n: number): T[][] =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

  for (const part of chunk(ix.docs, 500)) {
    await client.execute({
      sql: `INSERT INTO fts_docs (ver, len, live) VALUES ${part.map(() => '(?,?,?)').join(',')}`,
      args: part.flatMap((d) => [d.ver, d.len, d.live]),
    });
  }
  for (const part of chunk(ix.terms, 500)) {
    await client.execute({
      sql: `INSERT INTO fts_terms (ver, term, tf, live) VALUES ${part.map(() => '(?,?,?,?)').join(',')}`,
      args: part.flatMap((t) => [t.ver, t.term, t.tf, t.live]),
    });
  }
  for (const part of chunk(ix.dict, 500)) {
    await client.execute({
      sql: `INSERT INTO fts_dict (term, df) VALUES ${part.map(() => '(?,?)').join(',')}`,
      args: part.flatMap((d) => [d.term, d.df]),
    });
  }
  await client.execute({
    sql: `INSERT INTO fts_stats (num_docs, avgdl) VALUES (?,?)`,
    args: [ix.stats.num_docs, ix.stats.avgdl],
  });
}
```

- [ ] **Step 5: Export the index on commit**

In `packages/core/src/duck-commit.ts`, add the import and a helper, then call it from `buildManifest`:

```ts
import { FTS_TABLES, rebuildIndex } from './fts/index-tables.ts';
```

```ts
/**
 * Rebuild and export the full-text index. Runs only when `node_versions` changed — the index
 * is derived from it and from nothing else, so a commit that did not touch it carries the
 * previous index files forward untouched. Without that gate every commit would cost the whole
 * corpus regardless of what changed.
 */
async function buildFtsIndexes(
  client: ExportSource,
  base: Manifest | null,
  cache: FileCache,
  tmpDir: string,
  dirty: Set<string>,
): Promise<Manifest['indexes']> {
  if (!dirty.has('node_versions')) return base?.indexes ?? {};
  await rebuildIndex(client);

  const group = async (
    where: string | undefined,
    suffix: string,
    tables: readonly string[],
  ): Promise<Record<string, string[]>> => {
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const key = await exportTable(client, t, cache, tmpDir, where, suffix);
      out[t] = key === null ? [] : [key];
    }
    return out;
  };

  return {
    fts_live: await group('live', 'live', ['fts_docs', 'fts_terms']),
    fts_history: await group('NOT live', 'history', ['fts_docs', 'fts_terms']),
    // dict and stats span both scopes — see buildIndex on why avgdl is not per-scope.
    fts_global: await group(undefined, 'global', ['fts_dict', 'fts_stats']),
  };
}
```

Then in `buildManifest`, replace `indexes: base?.indexes ?? {},` with a value computed before the `return`:

```ts
  const indexes = await buildFtsIndexes(client, base, cache, tmpDir, dirty);
```

```ts
    tables,
    indexes,
  };
```

`FTS_TABLES` is imported for the materialize side; if the linter flags it as unused here, import only `rebuildIndex` in this file.

- [ ] **Step 6: Load the index on materialize**

In `packages/core/src/duck-materialize.ts`, after the `manifest.tables` loop and before the `emb_dim` restatement:

```ts
	// The index groups are flat table->files maps, loaded exactly like the data tables. Live
	// and history are separate file sets so a remote live-only query need not fetch history
	// terms; locally they land in one table, distinguished by the `live` column.
	for (const group of Object.values(manifest.indexes)) {
		for (const [table, files] of Object.entries(group)) {
			if (files.length === 0) continue;
			const paths = await cache.resolve(files);
			await client.execute(
				`INSERT OR REPLACE INTO ${table} BY NAME SELECT * FROM read_parquet(${pathList(paths)}, union_by_name = true)`,
			);
		}
	}
```

Also add the four tables to the drop loop so a materialize is a load rather than a merge. Change the drop loop to:

```ts
	for (const t of [...SNAPSHOT_TABLES, ...FTS_TABLES].reverse()) {
		await client.execute(`DROP TABLE IF EXISTS ${t}`);
	}
```

with `import { FTS_TABLES } from './fts/index-tables.ts';` at the top.

- [ ] **Step 7: Run the tests**

Run: `GRAPHX_TEST_DRIVER=duckdb bun test packages/core/test/fts-roundtrip.test.ts`
Expected: PASS, 5 tests.

Then confirm nothing in stage 4 regressed:

Run: `GRAPHX_TEST_DRIVER=duckdb bun test packages/core/test/duck-*.test.ts packages/core/test/objstore`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/fts/index-tables.ts packages/core/src/dialect-sql.ts \
  packages/core/src/duck-commit.ts packages/core/src/duck-materialize.ts \
  packages/core/test/fts-roundtrip.test.ts
git commit -m "feat(core): publish the full-text index with the snapshot

The index becomes part of a snapshot: rebuilt from node_versions when it
is dirty, exported to Parquet under manifest.indexes, and materialized by
any reader. A commit that did not touch node_versions carries the previous
index files forward - otherwise every commit would cost the whole corpus.

Live and history are separate file sets so a remote live-only query need
not fetch history terms; dict and stats span both, because a per-scope
avgdl would score one document differently depending on the query's
temporal scope."
```

---

### Task 6: The dialect fragments

Replace the three `notYet` throws. Argument counts must match libSQL's exactly.

**Files:**
- Modify: `packages/core/src/dialect-sql.ts` (`ftsWhere`, `ftsSeedLive`, `ftsSeedAsOf`)
- Modify: `packages/core/test/dialect-sql.test.ts:29` (the assertion that `ftsWhere('duckdb')` throws)
- Test: `packages/core/test/fts-fragments.test.ts`

**Interfaces:**
- Consumes: `bm25Cte` (Task 4).
- Produces: `duckdb` arms with these bound-argument contracts, identical in count to libSQL's:
  - `ftsWhere(dialect, alias)` — 1 arg: terms JSON.
  - `ftsSeedLive(dialect)` — 2 args: terms JSON, k.
  - `ftsSeedAsOf(dialect)` — 4 args: terms JSON, t, t, k.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/fts-fragments.test.ts
import { describe, expect, test } from 'bun:test';
import { FOREVER } from '../src/db.ts';
import { ftsSeedAsOf, ftsSeedLive, ftsWhere } from '../src/dialect-sql.ts';
import { createDuckClient, type DuckClient } from '../src/duck.ts';
import { duckdbSchema } from '../src/dialect-sql.ts';
import { rebuildIndex } from '../src/fts/index-tables.ts';
import { tokenize } from '../src/fts/tokenize.ts';

const terms = (q: string): string => JSON.stringify(tokenize(q));

/** Two live nodes and one superseded version, indexed. */
async function seeded(): Promise<DuckClient> {
  const c = createDuckClient();
  await c.executeMultiple(duckdbSchema(4));
  for (const id of ['a', 'b']) {
    await c.execute({ sql: 'INSERT INTO node_identity VALUES (?)', args: [id] });
  }
  const rows: [number, string, string, number, number][] = [
    [1, 'a', 'temporal graph database', 0, 100],   // superseded at t=100
    [2, 'a', 'rewritten beyond recognition', 100, FOREVER],
    [3, 'b', 'vector search engine', 0, FOREVER],
  ];
  for (const [ver, id, body, from, to] of rows) {
    await c.execute({
      sql: `INSERT INTO node_versions (ver, id, type, body, valid_from, valid_to)
            VALUES (?,?,?,?,?,?)`,
      args: [ver, id, 'Doc', body, from, to],
    });
  }
  await rebuildIndex(c);
  return c;
}

describe('duckdb fts fragments', () => {
  test('ftsSeedLive returns live ids best-first', async () => {
    const c = await seeded();
    const r = await c.execute({ sql: ftsSeedLive('duckdb'), args: [terms('vector search'), 10] });
    expect(r.rows.map((row) => String(row.id))).toEqual(['b']);
    await c.end();
  });

  test('ftsSeedLive does not match a superseded body', async () => {
    // ver 1 says 'temporal graph database' but is closed; live search must not see it.
    const c = await seeded();
    const r = await c.execute({ sql: ftsSeedLive('duckdb'), args: [terms('temporal'), 10] });
    expect(r.rows).toEqual([]);
    await c.end();
  });

  test('ftsSeedLive honors k', async () => {
    const c = await seeded();
    const r = await c.execute({ sql: ftsSeedLive('duckdb'), args: [terms('rewritten vector'), 1] });
    expect(r.rows.length).toBe(1);
    await c.end();
  });

  test('ftsSeedAsOf matches the version live at t — the exactness ANN cannot give', async () => {
    const c = await seeded();
    const r = await c.execute({
      sql: ftsSeedAsOf('duckdb'),
      args: [terms('temporal'), 50, 50, 10],
    });
    expect(r.rows.map((row) => String(row.id))).toEqual(['a']);
    await c.end();
  });

  test('ftsSeedAsOf does not match a version that had not been written yet', async () => {
    const c = await seeded();
    const r = await c.execute({
      sql: ftsSeedAsOf('duckdb'),
      args: [terms('rewritten'), 50, 50, 10],
    });
    expect(r.rows).toEqual([]);
    await c.end();
  });

  test('ftsWhere filters a node_versions scan', async () => {
    const c = await seeded();
    const r = await c.execute({
      sql: `SELECT nv.id FROM node_versions nv
            WHERE nv.valid_to = ${FOREVER} AND ${ftsWhere('duckdb', 'nv')}`,
      args: [terms('vector')],
    });
    expect(r.rows.map((row) => String(row.id))).toEqual(['b']);
    await c.end();
  });

  test('every fragment binds the same number of args as the libsql arm', () => {
    // The callers bind positionally from one code path shared with libSQL and Postgres.
    const count = (sql: string): number => (sql.match(/\?/g) ?? []).length;
    expect(count(ftsWhere('duckdb', 'nv'))).toBe(count(ftsWhere('libsql', 'nv')));
    expect(count(ftsSeedLive('duckdb'))).toBe(count(ftsSeedLive('libsql')));
    expect(count(ftsSeedAsOf('duckdb'))).toBe(count(ftsSeedAsOf('libsql')));
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/fts-fragments.test.ts`
Expected: FAIL — `dialect-sql: ftsSeedLive(duckdb) not implemented yet`.

- [ ] **Step 3: Write the three arms**

In `packages/core/src/dialect-sql.ts`, add `import { bm25Cte } from './fts/index-tables.ts';` and replace each `notYet` call:

```ts
		// Membership only — no scoring. This is a filter on a scan the caller already
		// orders, so computing BM25 here would be work whose result is discarded.
		case 'duckdb':
			return `${alias}.ver IN (
				SELECT t.ver FROM fts_terms t
				WHERE t.term IN (SELECT unnest(from_json(?, '["VARCHAR"]')))
			)`;
```

```ts
		// BM25 over the live index, joined back to logical ids. Args: terms JSON, k.
		case 'duckdb':
			return `WITH scored AS (${bm25Cte('live')})
SELECT n.id AS id
FROM scored
JOIN node_versions n ON n.ver = scored.ver
WHERE n.valid_to = ${FOREVER_LIT}
ORDER BY scored.score DESC, n.id
LIMIT ?`;
```

```ts
		// The index covers every version, so the as-of match is exact rather than the
		// over-fetch-and-filter the live-only ANN index forces. Args: terms JSON, t, t, k.
		case 'duckdb':
			return `WITH scored AS (${bm25Cte('any')})
SELECT n.id AS id
FROM scored
JOIN node_versions n ON n.ver = scored.ver
WHERE n.valid_from <= ? AND ? < n.valid_to
ORDER BY scored.score DESC, n.id
LIMIT ?`;
```

- [ ] **Step 4: Update the stale assertion**

`packages/core/test/dialect-sql.test.ts:29` asserts `ftsWhere('duckdb', 'n')` throws. Replace it with an assertion that it no longer does:

```ts
	test('ftsWhere has a duckdb arm now that the index exists', () => {
		expect(ftsWhere('duckdb', 'n')).toContain('fts_terms');
	});
```

Check the surrounding block for sibling assertions about `ftsSeedLive`/`ftsSeedAsOf`/`ftsTableDDL` throwing and update any that are now wrong. Leave the Postgres `notYet` assertions alone.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/core/test/fts-fragments.test.ts packages/core/test/dialect-sql.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/dialect-sql.ts packages/core/test/fts-fragments.test.ts \
  packages/core/test/dialect-sql.test.ts
git commit -m "feat(core): fill in the duckdb full-text fragments

ftsWhere, ftsSeedLive, and ftsSeedAsOf stop throwing notYet. Argument
counts match the libSQL arms exactly, because hybrid.ts and
retrieval-legs.ts bind positionally from one path shared by all three
dialects. ftsSeedAsOf is exact rather than over-fetch-and-filter: the
index covers every version, not only the live ones."
```

---

### Task 7: Wire the callers

Three call sites currently branch with `d === 'postgres' ? query : match`, which silently sends an FTS5 expression to DuckDB. Replace the ternary with a dialect-aware argument builder so a fourth dialect cannot reintroduce the bug.

**Files:**
- Modify: `packages/core/src/hybrid.ts` (`sanitizeMatch` neighborhood, `seedsCurrent`, `seedsAsOf`)
- Modify: `packages/core/src/graph.ts` (`ftsMatch`, `nodeFilter`)
- Modify: `packages/core/test/retrieval-legs.ts` (`ftsSeeds`)
- Modify: `packages/core/src/index.ts` (export `ftsArg`)
- Test: `packages/core/test/fts-args.test.ts`

**Interfaces:**
- Consumes: `tokenize` (Task 2).
- Produces: `export function ftsArg(dialect: Dialect, query: string): string | null` in `hybrid.ts` — the bound argument for every full-text fragment, or `null` when the query has no usable tokens (caller skips the leg entirely).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/fts-args.test.ts
import { describe, expect, test } from 'bun:test';
import { ftsArg, sanitizeMatch } from '../src/hybrid.ts';

describe('ftsArg', () => {
  test('libsql gets the FTS5 expression sanitizeMatch already produced', () => {
    expect(ftsArg('libsql', 'graph db')).toBe(sanitizeMatch('graph db'));
  });

  test('postgres gets the raw query — tsQueryOr parses it itself', () => {
    expect(ftsArg('postgres', 'graph db')).toBe('graph db');
  });

  test('duckdb gets a JSON array of tokens', () => {
    expect(ftsArg('duckdb', 'Graph DB')).toBe('["graph","db"]');
  });

  test('every dialect returns null for a query with no usable tokens', () => {
    // The caller skips the lexical leg entirely on null; returning "[]" instead would run a
    // scoring join guaranteed to match nothing.
    for (const d of ['libsql', 'postgres', 'duckdb'] as const) {
      expect(ftsArg(d, '   ')).toBeNull();
      expect(ftsArg(d, '!!! ---')).toBeNull();
    }
  });

  test('duckdb survives hostile input that would be FTS5 syntax', () => {
    // Operators are not escaped, they are tokenized away — there is no grammar to inject into.
    expect(ftsArg('duckdb', 'a" OR b NEAR(c)')).toBe('["a","or","b","near","c"]');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/core/test/fts-args.test.ts`
Expected: FAIL — `ftsArg is not a function`.

- [ ] **Step 3: Add `ftsArg`**

In `packages/core/src/hybrid.ts`, below `sanitizeMatch`:

```ts
import { tokenize } from './fts/tokenize.ts';
```

```ts
/**
 * The bound argument every full-text fragment expects, for the dialect in hand. `null` when
 * the query has no usable tokens — the caller skips the lexical leg rather than running a
 * match guaranteed to return nothing.
 *
 * This exists because the three dialects want three different things from the same user text:
 * libSQL an FTS5 expression, Postgres the raw text (its `tsquery` is built in SQL), DuckDB a
 * JSON array of tokens. The call sites used to spell that as `d === 'postgres' ? query :
 * match`, which quietly handed an FTS5 expression to DuckDB the moment a third dialect
 * existed.
 */
export function ftsArg(dialect: Dialect, query: string): string | null {
	switch (dialect) {
		case 'libsql':
			return sanitizeMatch(query);
		case 'postgres':
			// tsQueryOr parses the raw text itself; pre-tokenizing would double the work and
			// throw away the dictionary's own stopword handling.
			return sanitizeMatch(query) === null ? null : query;
		case 'duckdb': {
			// No grammar to inject into: operators tokenize to ordinary terms.
			const terms = tokenize(query);
			return terms.length === 0 ? null : JSON.stringify(terms);
		}
		default:
			return assertNever(dialect, 'ftsArg');
	}
}
```

Import `assertNever` from wherever `dialect-sql.ts` gets it, or inline the exhaustive default as `throw new Error(...)` if `assertNever` is not exported to this module.

- [ ] **Step 4: Replace the call sites**

In `hybrid.ts`, `seedsCurrent` and `seedsAsOf` both take a `match: string | null` parameter and compute `d === 'postgres' ? query : match`. Change both to take the already-resolved argument. In `seedsCurrent`:

```ts
	let ftsIds: string[] = [];
	if (arg !== null) {
		const fts = await raw.execute({ sql: ftsSeedLive(d), args: [arg, fetchK] });
		ftsIds = fts.rows.map((r) => String(r.id));
	}
```

and in `seedsAsOf`:

```ts
	let ftsIds: string[] = [];
	if (arg !== null) {
		const fts = await raw.execute({ sql: ftsSeedAsOf(d), args: [arg, t, t, fetchK] });
		ftsIds = fts.rows.map((r) => String(r.id));
	}
```

Update their signatures from `(raw, qEmbJson, query, match, fetchK[, t])` to `(raw, qEmbJson, arg, fetchK[, t])` — `query` becomes dead once `arg` carries everything — and update the single caller in `hybridRetrieve` (around `hybrid.ts:386`) to compute `const arg = ftsArg(dialectOf(raw), opts.query);` in place of `const match = sanitizeMatch(opts.query);`.

In `graph.ts`, `nodeFilter` becomes:

```ts
		if (opts.q !== undefined) {
			const d = dialectOf(this.raw);
			const arg = ftsArg(d, opts.q);
			if (arg === null) return null;
			where.push(ftsWhere(d, 'nv'));
			args.push(arg);
		}
```

and the private `ftsMatch` method is deleted — its only caller was this branch, and `ftsArg` now covers all three dialects. Import `ftsArg` from `./hybrid.ts`; if that reintroduces the import cycle the old comment warned about (hybrid → retrieve → graph), move `ftsArg` and `sanitizeMatch` into `fts/tokenize.ts` instead and re-export both from `hybrid.ts` so the public API is unchanged. Check for the cycle by running the tests — Bun reports it as an undefined import at call time, not at load.

In `packages/core/test/retrieval-legs.ts`, `ftsSeeds` becomes:

```ts
export async function ftsSeeds(raw: DbClient, query: string, k: number): Promise<string[]> {
	const d = dialectOf(raw);
	const arg = ftsArg(d, query);
	if (arg === null) return [];
	const r = await raw.execute({ sql: ftsSeedLive(d), args: [arg, k] });
	return r.rows.map((row) => String(row.id));
}
```

In `packages/core/src/index.ts`, add `ftsArg` beside the existing `sanitizeMatch` export (line ~183).

- [ ] **Step 5: Run the tests**

Run: `bun test packages/core/test/fts-args.test.ts`
Expected: PASS, 5 tests.

Run: `bun test --timeout 30000`
Expected: libSQL unchanged — 1133 pass / 6 skip / 0 fail. The ternary replacement touches the shared path, so a libSQL regression here is the whole risk of this task.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/hybrid.ts packages/core/src/graph.ts packages/core/src/index.ts \
  packages/core/test/retrieval-legs.ts packages/core/test/fts-args.test.ts
git commit -m "feat(core): resolve the full-text bound arg by dialect

The call sites spelled this as 'd === postgres ? query : match', which
handed an FTS5 expression to DuckDB the moment a third dialect existed.
ftsArg makes the three-way explicit and exhaustive, and graph.ts's
duplicated ftsMatch goes away with it."
```

---

### Task 8: Full parity, docs, and the CI gate

The measurement that says whether stage 5 did what it claimed, and the two artifacts that record it.

**Files:**
- Modify: `docs/DUCKDB_SUPPORT.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: an updated parity record and, if the number is zero, a CI job that no longer tolerates failure.

- [ ] **Step 1: Measure all three backends**

```bash
bun run build
bun test --timeout 30000 2>&1 | tail -5
GRAPHX_TEST_DRIVER=duckdb bun test --timeout 60000 2>&1 | tail -5
docker run -d --name graphx-pg-s5 -p 5455:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=graphx_test pgvector/pgvector:pg17
# wait for readiness before running
GRAPHX_TEST_DRIVER=postgres bun test --timeout 60000 2>&1 | tail -5
docker rm -f graphx-pg-s5
```

Expected: libSQL and Postgres unchanged from the stage-4 baseline (1133/6/0 and 1117/22/0, plus this plan's new tests). DuckDB down to **2 failures** — the documented raw-SQL constraint bypasses and nothing else.

- [ ] **Step 2: Triage every remaining DuckDB failure**

```bash
GRAPHX_TEST_DRIVER=duckdb bun test --timeout 60000 2>&1 | grep '^(fail)' | sort
```

Every line must be one of the two known constraint tests (`P14 unique: …underscore-join…`, `P14 cardinality: …partial unique index…`). For anything else, do not file it under an existing category to make the number look right — diagnose it. The most likely genuine failures and what they mean:

- **`eval-golden` ranking parity** — our BM25 order differs from the committed golden. Compare against `truth.libsql` from the Task 1 fixture first: if libSQL's own order differs from the golden too, the golden is per-driver and needs a duckdb entry rather than a code fix.
- **`the lexical leg carries comparable weight on both dialects`** — a recall shortfall. Check whether the query relies on stemming; if so, this is the documented v1 gap and the test needs a driver-aware expectation, which is a change to make deliberately and record, not quietly.
- **`hybrid: FTS leg returns body matches`** — most likely the index was never built because the mutation path did not mark `node_versions` dirty. Check that the test's writes go through `Graph`, not raw SQL.

- [ ] **Step 3: Update the parity record**

In `docs/DUCKDB_SUPPORT.md`:

- Replace the counts in the **Verification** bullet with the measured ones.
- Change the full-text row of the triage table from `| … | 21 | stage 5 |` to `| … | 0 | stage 5 — done |`.
- In **What's left before the CI gate can go green**, replace the stage 5 bullet with a statement of what shipped and what did not: the index is unstemmed by design, matching libSQL's `unicode61`; Postgres stems, so its lexical recall on inflected queries is genuinely higher; adding a stemmer later is additive because the index rebuilds on every commit.
- Add a short **Full-text index** section covering: the four tables, that `dict`/`stats` span live and history while the file sets do not, that a commit rebuilds the whole index when `node_versions` is dirty and carries it forward otherwise, and that readers need no `fts` extension.

- [ ] **Step 4: Take the CI gate off `continue-on-error`**

Only if step 2 came back with exactly the two documented constraint failures. In `.github/workflows/ci.yml`, remove `continue-on-error: true` from the `test-duckdb` job and add the two known failures to whatever exclusion the job uses — or, if it has none, leave `continue-on-error: true` in place and say so plainly in the task report rather than inventing a filter.

- [ ] **Step 5: Commit**

```bash
git add docs/DUCKDB_SUPPORT.md .github/workflows/ci.yml
git commit -m "docs: record the stage 5 parity number

Full-text closes the 21 failures it was scoped to. The index is
unstemmed by design: libSQL's unicode61 does not stem either, and it is
the backend the committed golden rankings were measured against.
Postgres does stem, so its lexical recall on inflected queries is higher;
that difference is recorded rather than hidden."
```

---

## Self-Review

**Spec coverage (§10.2, sentence by sentence):**

| Spec requirement | Task |
|---|---|
| Own inverted index, not the `fts` extension | 3, 5 |
| Six-table shape reduced to what we actually query | 4 (`FTS_TABLES`) |
| BM25 reproduces `match_bm25` | 1, 4 |
| Built in JavaScript and SQL at commit time | 3, 5 |
| Golden test against `create_fts_index` | 1 (fixture), 2 (vocabulary + lengths), 4 (scores) |
| Readers need no extension, no `ATTACH`, no `USE` | 4, 6 |
| Index covers live and history, keyed on `ver` | 3, 5 |
| `fts_live`/`fts_history` separate file sets | 5 |
| `sanitizeMatch`'s FTS5 grammar becomes tokenize | 2, 7 |
| Disjunctive by default, matching `tsQueryOr`'s OR semantics | 4 (`term IN`/join is a union) |
| One stemmer on both sides | **Deliberately deferred** — see Scope decisions; v1 has no stemmer, so there are no two sides to disagree |
| §10.1 brute-force ANN | **Already landed** in Task 10 of the stage 1–4 plan |

**Placeholder scan:** No `TBD`, no "add error handling", no "similar to Task N". Every code step carries the code. Task 8's step 4 is conditional rather than vague — it states the condition and what to do when it does not hold.

**Type consistency:** `FtsIndex`/`FtsDoc`/`FtsTerm`/`FtsDictEntry`/`FtsStats` are defined in Task 3 and used unchanged in Tasks 4 and 5. `buildIndex` returns them; `rebuildIndex` consumes them. `bm25Cte(scope)` is defined in Task 4 with the exact `'live' | 'asof' | 'any'` union used in Task 6. `ftsArg(dialect, query)` is defined in Task 7 and used at all four call sites named there. `FTS_TABLES` is defined in Task 4 and consumed by Task 5's drop loop and export.

**Two risks the implementer should know going in.** First, Task 1 needs network for `INSTALL fts`; if it fails, stop rather than hand-writing the fixture — every downstream verification depends on it being measured. Second, Task 7 edits the code path all three dialects share, so a libSQL regression is the real hazard there; its step 5 runs the full libSQL suite for exactly that reason.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-30-duckdb-fts-hybrid-s5.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
