# Follow-ups

Known, deliberately-deferred work. Each entry says what it is, why it was not done at the
time, and what would make it worth doing. Nothing here is a correctness bug in shipped
behavior; anything that was is already fixed.

## DuckDB full-text (stage 5, branch `feat/duckdb-fts`)

Carried out of the stage 5 execution ledger, which is deleted with its workspace. The
reviews that produced these are summarized in `docs/DUCKDB_SUPPORT.md`.

### F1 — Give `rebuildIndex` ownership of the freshness markers

`packages/graphx/src/core/duck.ts`, `packages/graphx/src/core/fts/index-tables.ts`

The index's staleness markers (`ftsStale`, `ftsSignature`) must be captured **before**
`rebuildIndex` reads `node_versions`. Capture them after, and a write landing in that window
is counted in the recorded signature while absent from the index — the row becomes
permanently unsearchable, silently.

That exact defect was found and fixed three times during stage 5, once per call site, because
each fix and each regression test pinned the _call site_ rather than the contract. Both call
sites are correct today and each has a delay-swept regression test, but a third call site
added later would reintroduce it and nothing would catch that.

The structural fix is the one already applied to atomicity: move the discipline into
`rebuildIndex`, so a caller cannot forget it. `rebuildIndex` already owns its own transaction
for exactly this reason — have it own the marker capture too (e.g. by taking an
`FtsIndexOwner` and doing capture-before-read itself).

**Do it when:** a third caller of `rebuildIndex` is added, or sooner if this area is being
touched anyway.

### F2 — Tighten the commit failure path

`packages/graphx/src/core/duck.ts`, in `commit()`

`this.ftsStale = false` is set before `commitSnapshot` runs; the signature is assigned after.
If `commitSnapshot` throws — a `SnapshotConflictError` from a lost CAS race is reachable — the
flag is cleared while the signature is not updated. The residual is contrived (it needs a raw
in-place body `UPDATE`, which graphx never performs, combined with a delete-only write and a
commit failure), and the early-captured signature covers the writers this mechanism exists
for.

Moving `this.ftsStale = false` down beside the signature assignment closes it at no cost. This
was validated during review but deliberately not taken in the final fix wave: the wave was
closed, and unrequested changes at merge time are how regressions land.

### F3 — Lock the optional-peer import boundary with a test

`packages/graphx/src/core/graph.ts`, `hybrid.ts`, `bulk.ts`

None of these may import `duck.ts`, directly or transitively, or the optional
`@duckdb/node-api` peer (~123MB installed) lands on the import path of every consumer who
never opted into that backend. The `ManagedWriter` and `FtsIndexOwner` structural probes in
`db.ts` exist solely to preserve this.

The boundary holds today — re-verified during the final review — but nothing enforces it. One
import-graph assertion would turn a silent packaging regression into a failing test. Worth
doing because the failure mode is invisible in development and only shows up as install
weight for downstream users.

### F4 — Minor hygiene

- `packages/graphx/scripts/measure-fts-ground-truth.ts` — the `docs` query is `ORDER BY len`
  with no tiebreaker, and several documents share a length, so the array's order is not
  guaranteed stable across regenerations. Values are stable; only ordering is not. Use
  `ORDER BY len, name` if the script is touched.
- `packages/graphx/test/core/fts-args.test.ts` — the libSQL case asserts `ftsArg('libsql', q)` equals
  `sanitizeMatch(q)`, which is how it is implemented, so it cannot fail. Assert the expected
  string instead.
- `packages/graphx/src/core/duck-materialize.ts` — `manifest.indexes` is dereferenced without a
  `?? {}` fallback. Unreachable for manifests this codebase writes; a hand-written or
  older-format manifest would throw rather than degrade.
- `packages/graphx/src/core/fts/index-tables.ts` — `rebuildIndex` loads the whole corpus into JS to
  build the index. Acknowledged in its own doc comment. The scaling answer is a per-file delta
  in the manifest (`TableRef.files` is already a list), not incremental mutation of the local
  tables.

### F5 — Two known parity differences, documented rather than open

Recorded here so they are not rediscovered as bugs. Both are in `docs/DUCKDB_SUPPORT.md`.

- **No stemming.** The DuckDB tokenizer matches libSQL's `unicode61`, which does not stem.
  Postgres does, so its lexical recall on inflected queries is genuinely higher. Adding a
  stemmer later is additive — writer and reader share one tokenizer module and the index is
  rebuilt on every commit, so there is nothing to migrate.
- **Diacritics.** Our `[^\p{L}\p{N}]+` tokenizer keeps diacritics; SQLite's `unicode61` strips
  them by default. So "matches `unicode61`" is exact for stopwords and digits but not for
  diacritics, and no corpus body in the ground-truth fixture contains one, so the difference
  is untested.

## Cross-cutting

### F6 — Two DuckDB tests fail permanently, so CI cannot gate on that backend

`.github/workflows/ci.yml`, `test-duckdb`

`P14 cardinality` and `P14 unique` assert DB-level partial-index enforcement that DuckDB does
not have — its uniqueness and single-valued-rel constraints are enforced in application code,
so a raw-SQL write that bypasses `Graph` is not rejected. They are correct tests of a real
difference, not bugs.

Because they cannot pass, the job carries `continue-on-error: true` and therefore gates
nothing. The repo already has `libsqlOnly` and `sharedWriterOnly` for "this backend genuinely
lacks this capability"; a similar gate would let the job drop `continue-on-error` and start
catching real DuckDB regressions.

Left alone deliberately: converting a documented failure into a skip is a test-suite policy
decision, not an implementation one.
