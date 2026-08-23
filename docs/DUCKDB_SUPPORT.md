# DuckDB Support — Parity Record

## Status (as of this branch)

- **Stages 1–3 (object storage, DuckClient, schema, fragments, bulk/journey/pattern, constraint
  enforcement): DONE.** `packages/graphx/src/core/duck.ts` (`DuckClient implements DbClient` over a
  pooled `@duckdb/node-api` connection), `duckdbSchema()` in `dialect-sql.ts` (real
  `node_versions`/`edge_versions` tables, `nodes`/`edges` views — no live/history split at the
  local-schema layer; that split is a Parquet-layout concern for stage 4), every dialect fragment
  filled in for `duckdb` except full-text, and application-level uniqueness/cardinality
  enforcement (`duck-constraints.ts`) standing in for the partial UNIQUE indexes libSQL/Postgres
  use (DuckDB has none). Graph mutations (`addNode`/`updateNode`/`addEdge`/`deleteEdge`/bulk
  load) work end to end.
- **Stage 4 — third harness arm and the first parity measurement: DONE.**
  `packages/graphx/test/core/harness.ts` gained a `duckdb` branch in `makeTestDb()` (a temp
  `test_<ulid>.duckdb` file, never `:memory:`) and a `duckdb` arm in `tableExistsSql`
  (`duckdb_tables()`/`duckdb_views()`). The whole suite then ran under
  `GRAPHX_TEST_DRIVER=duckdb` for the first time.
- **Stage 4 — object storage round trip (Tasks 14–16): DONE.** `materialize()`
  (`duck-materialize.ts`) loads a snapshot's Parquet files into real local tables;
  `commitSnapshot()` (`duck-commit.ts`) exports the dirty ones back, keyed by content hash,
  and claims the next snapshot number with a create-if-absent PUT. `DuckClient` opens on its
  head snapshot lazily (`getDb` is synchronous, so this mirrors `PgClient.ready`), serializes
  every write on one chain, and `Graph.write(fn)` groups a body into a single commit. A bare
  mutation still commits on its own, so the API is unchanged on every backend.

- **Verification:** libSQL **1178 pass / 6 skip / 0 fail**, Postgres **1162 / 22 / 0**
  (dedicated fresh container), DuckDB **1156 / 26 / 2**. The 2 failures triage exactly to
  the row below; nothing is left uncategorized. `duck-e2e.test.ts` also passes against a real
  MinIO bucket (`GRAPHX_TEST_S3_ENDPOINT=...`), which is the only configuration that exercises
  the genuine create-if-absent CAS the commit protocol is built on.

- **Re-verification, 2026-08-19 (release prep):** all three arms green —
  libSQL **1206 / 8 skip / 0 fail**, Postgres **1190 / 24 / 0**
  (`pgvector/pgvector:pg16` container), DuckDB **1184 / 30 / 0**. The two constraint failures
  above are now **gated rather than failing**: they assert an INDEX-backed rejection of a raw SQL
  insert, which DuckDB structurally cannot provide, so they run under the new
  `indexBackedConstraints` harness gate (libSQL + Postgres only) — same reasoning as
  `sharedWriterOnly`. One further test moved with the data directory: `mcp/test/bin.test.ts` now
  looks for `mygraph.duckdb` under `.graphx-data/` rather than the process cwd (see
  `duckDataDir()`).

| category                                                                                                                                                          | count | resolved by                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| full-text: `ftsWhere`/`ftsSeedLive`/`ftsSeedAsOf`, and hybrid retrieval (which fuses a lexical leg)                                                               | 0     | stage 5 — done                                                                                                                                           |
| constraint enforcement is application code, not a DB index — a raw-SQL insert that bypasses `Graph.addNode`/`addEdge` is not rejected (see the parity note below) | 0     | design, not a gap — gated `indexBackedConstraints` on 2026-08-19 so the arm is green                                                                     |
| `p14-concurrency` — asserted lock contention that does not exist on this backend                                                                                  | 0     | Task 16: gated `sharedWriterOnly`, and the same invariants re-asserted through the write mutex and the manifest CAS in a `duckdbOnly` block              |
| outbox ordering and trigger-runner cursors                                                                                                                        | 0     | already gated `postgres`-only; none ran or failed under duckdb                                                                                           |
| auth package read-modify-write idempotency                                                                                                                        | 0     | `packages/auth` does not import the harness; unaffected by this arm                                                                                      |
| multi-tenant `getDb` suites needing a bucket per namespace                                                                                                        | 0     | already pass — `getDb`'s duckdb factory falls back to one local file per namespace, which is sufficient until stage 4/Task 15 moves it to object storage |
| libSQL-internals probes                                                                                                                                           | 0     | already skipped by `libsqlOnly` (and the 3 `outbox.test.ts`/1 `cli.test.ts` driver-pinned tests)                                                         |

Two rows above differ from the plan's expected shape and are explained here:

- **Outbox and multi-tenant `getDb` rows are 0, not the plan's estimate.** `outbox.test.ts`'s
  three tests were already `skipIf(TEST_DRIVER !== 'postgres')` — a genuine allowlist, so they
  correctly skip under duckdb rather than fail. The multi-tenant suites (`p11-serving`,
  `admin-app`, `admin-list`, authz, cdc) all pass: `getDb`'s duckdb factory
  (`packages/graphx/src/core/duck.ts`'s `registerDuckDriver` call) already resolves one local
  `<namespace>.duckdb` file per tenant, which is enough for these tests today. The bucket-per
  namespace requirement is a stage-4/Task-15 concern (object storage), not something these
  suites currently exercise.
- **auth package is 0/unaffected.** `packages/auth`'s tests obtain a client directly (not via
  `packages/graphx/test/core/harness.ts`) and were not touched by adding the third arm.

## Real bugs fixed (Tasks 1–12), not parity gaps

Investigating every failure surfaced six defects that had nothing to do with full-text or
concurrency — each is a genuine bug in earlier stages, fixed as part of closing this task (all
verified against libSQL and, where applicable, Postgres to confirm no regression):

1. **`duckdbSchema()` was missing every foreign key** (`packages/graphx/src/core/dialect-sql.ts`).
   `node_versions.id`, `edge_versions.id`, `edge_versions.src`, and `edge_versions.dst` had no
   `REFERENCES` clause at all, unlike the libSQL and Postgres schemas — so an edge to a
   non-existent node silently inserted instead of failing (`P11: edge to a non-existent endpoint
(FK violation) -> 400, not 500` got a 201). DuckDB enforces `REFERENCES` natively; the fix
   just adds the same four clauses libSQL/Postgres already have. This was an oversight in Task
   9, not a documented/intentional gap — nothing in `duckdbSchema`'s own "differences from
   libSQL" doc comment or in `duck-schema.test.ts` claimed FKs were dropped (contrast with the
   partial-unique-index gap, which is both documented and pinned by a test).
2. **`updateNode`'s emb carry-forward threw on DuckDB** (`packages/graphx/src/core/graph.ts`). A
   data-only patch (no new `emb`) rebinds the current row's embedding forward via
   `embRebindExpr(dialect)`, which for duckdb is `from_json(?, '["FLOAT"]')` — it expects a JSON
   _string_. But the value read back from a `FLOAT[]` column comes back as a genuine JS array,
   and binding an array where a string is expected made `@duckdb/node-api` throw "Cannot create
   values of type ANY." Fixed by running the read-back value through `embParam()` (already built
   for exactly this in `duck-value.ts`, previously only used by tests) before binding, mirroring
   the `JSON.stringify` already done for a freshly-supplied `emb`.
3. **Constraint violations always mapped to 500, never 400** (`packages/graphx/src/core/admin.ts`,
   `packages/graphx/src/core/serve.ts`). Both error mappers recognized libSQL's `SQLITE_CONSTRAINT*`
   `.code` and Postgres's SQLSTATE class 23, but DuckDB constraint violations (UNIQUE, FK, CHECK)
   are a plain `Error` with neither a `.code` nor a SQLSTATE — only a message starting
   `"Constraint Error:"`. Added that as a third recognized shape in both mappers.
4. **`retrieval-legs.ts`'s `annScored` used a libSQL-only distance function for any non-Postgres
   driver.** `vector_distance_cos(emb, vector(?))` is libSQL-specific; DuckDB has no such
   function (`Catalog Error: ... Did you mean "vector_type"?`). The ternary was binary
   (`postgres` vs. everything else) and never learned about the third driver. Added a `duckdb`
   branch using the same `list_cosine_distance(emb, from_json(?, '["FLOAT"]'))` expression
   `dialect-sql.ts` already uses for the real ANN seed queries. Fixed `ANN tie order is NOT
stable, but the tie GROUPS are` outright; the other callers (`ranking parity`, `ablation`,
   etc.) still fail, now for the correct reason — `ftsSeedLive` — since they also exercise the
   lexical leg.
5. **A postgres-only test skip gate silently ran (and broke) under the third driver.**
   `packages/graphx/test/cli/cli.test.ts` had `const PG = ... === 'postgres'; test.skipIf(PG)(...)` on
   its "(libSQL)" `buildServeApp` test — a denylist, not an allowlist, exactly the shape the
   Task 2 harness fix already corrected once for `libsqlOnly`. Under duckdb this ran and threw
   `getDb: duckdb driver selected but the duck adapter is not registered`. Rewritten to
   `NOT_LIBSQL = (GRAPHX_TEST_DRIVER ?? 'libsql') !== 'libsql'` — an allowlist, matching
   `libsqlOnly`'s precedent.
6. **`packages/mcp` never registered the postgres/duckdb adapters**, in both production code and
   tests, so any non-libSQL `GRAPHX_DB_DRIVER` reaching it threw "adapter is not registered."
   This reproduces under the live Postgres leg too (confirmed empirically against a running
   `pgvector` container — same root cause, same 13 tests), so it predates this branch and is not
   duckdb-specific, but it was fixed here because it was blocking an honest parity read:
   - `packages/graphx/src/mcp/bin.ts` (production): the local-mode bootstrap now imports
     `graphx/pg` or `graphx/duck` based on `GRAPHX_DB_DRIVER`, mirroring the
     config-driven `await import('graphx/pg')` `packages/graphx/src/cli.ts`'s `loadConfig`
     already does for postgres configs.
   - `packages/graphx/test/mcp/server.test.ts`: added unconditional side-effect imports of both
     adapter subpaths (test-only; both are already dev dependencies of the workspace), mirroring
     why `core/test/harness.ts` imports `duck.ts`/`pg.ts` unconditionally.
   - `packages/graphx/test/mcp/bin.test.ts`: one assertion hard-coded the libSQL `<namespace>.db`
     filename; made it driver-aware (`<namespace>.duckdb`, or no local file at all under
     postgres).

Also added: `*.duckdb`/`*.duckdb.wal` to `.gitignore`, mirroring the existing `*.db`/`*.db-wal`
libSQL entry — every `makeTestDb()` duckdb test now opens a real file (never `:memory:`, see
below), and this entry was simply missing.

## Parity difference (not a bug): constraint enforcement is application code, not a DB constraint

`duck-constraints.ts` (Task 12) enforces uniqueness and single-valued-rel cardinality in
**application code** inside `Graph.addNode`/`updateNode`/`addEdge`, because DuckDB has no partial
index (the libSQL/Postgres mechanism is a `UNIQUE` index scoped to `WHERE valid_to = FOREVER`).
This means:

- **`declareUniqueNodeProp`** only guards writes that go through `Graph`. Raw SQL against
  `node_versions` that bypasses `Graph` is not rejected — libSQL/Postgres reject it via their
  index; DuckDB does not. Pinned by `P14 unique: two (type,prop) pairs that share an
underscore-join do NOT collapse to one index`, which inserts via raw SQL specifically to
  probe the DB-level constraint.
- **`declareSingleValuedRel`** is similarly **inert** unless the schema also marks the rel
  `single: true` (which routes cardinality enforcement through `Graph.addEdge`'s app-level
  check instead). Calling `declareSingleValuedRel` alone and then inserting a raw duplicate live
  edge succeeds silently on DuckDB, where libSQL/Postgres fail loudly via their index. Pinned by
  `P14 cardinality: the partial unique index hard-rejects a raw duplicate live edge`.

Both failures are the intended, already-documented behavior (flagged during Task 12's review and
carried here explicitly) — not bugs, and not something stage 5–7 changes. Every `Graph`-mediated
write path is still protected; only a raw-SQL bypass of `Graph` differs from libSQL/Postgres.

## The writer model, and the one thing it does not do

DuckDB has neither libSQL's `BEGIN IMMEDIATE` nor Postgres's `SERIALIZABLE`, so nothing in the
database serializes two writers. Two mechanisms stand in:

1. **In-process: a write mutex on the client.** `DuckClient.serializeWrite` chains every
   mutation and every commit. It lives on the _client_, not on `Graph`, so all `Graph`
   instances over one client — including the siblings `withEventSource` mints — share it.
   Without it, two concurrent conditional closes both see `rowsAffected === 1` and both insert
   a successor, leaving two rows with `valid_to = FOREVER`.
2. **Across processes: the manifest CAS.** A commit claims `snapshots/<n+1>.json` with a
   create-only PUT. One writer wins the number; the loser rebases onto the winner and rebuilds.

`Graph.write(fn)` groups a body into one snapshot commit — a commit is a set of object PUTs
plus that CAS, so committing per mutation is untenable for anything but a single write. A bare
`addNode()` still commits on its own, so the API is identical on all three backends. A body that
throws commits nothing: the local database is a materialization of the last snapshot, so
`DuckClient.reload()` (discard and re-materialize) is the rollback.

**The limitation:** two writers in _different processes_ mutating the _same table_ of one
namespace cannot merge. The loser's rebase would export a local database that never saw the
winner's rows, silently deleting them. `commitSnapshot` detects exactly that case — a rebase
where the winner changed a table this commit is also rewriting — and raises
`SnapshotConflictError` instead. The write does not land, and the caller is told so; reload the
head snapshot and re-apply. Writers touching _disjoint_ tables rebase cleanly and both land.
Retrying inside `isRetryableContention` would not help, because the local mutation has already
been applied — which is why a lost commit race is deliberately not in that predicate. At the
HTTP layer, `serve.ts` maps an exhausted contention budget (`…: too much contention`) to **409**
rather than 500.

The practical shape: **one writer process per namespace**, with readers unbounded. That is what
the snapshot chain is designed around.

## Files changed

- `packages/graphx/test/core/harness.ts` — third `makeTestDb()` arm, `tableExistsSql` duckdb case,
  `GRAPHX_DB_DRIVER` env wiring.
- `packages/graphx/src/core/dialect-sql.ts` — added the missing `REFERENCES` clauses to `duckdbSchema()`
  (bug #1 above).
- `packages/graphx/src/core/graph.ts` — fixed the `updateNode` emb carry-forward bind for duckdb (bug
  #2).
- `packages/graphx/src/core/admin.ts`, `packages/graphx/src/core/serve.ts` — recognize DuckDB's `"Constraint
Error:"` message shape (bug #3).
- `packages/graphx/test/core/retrieval-legs.ts` — duckdb branch for `annScored`'s distance expression
  (bug #4).
- `packages/graphx/test/cli/cli.test.ts` — allowlist the libSQL-only `buildServeApp` skip gate (bug #5).
- `packages/graphx/src/mcp/bin.ts`, `packages/graphx/test/mcp/server.test.ts`,
  `packages/graphx/test/mcp/bin.test.ts` — register the pg/duck adapters; driver-aware filename
  assertion (bug #6).
- `packages/graphx/src/core/duck-materialize.ts`, `duck-commit.ts` — snapshot load and publish
  (Tasks 14–15).
- `packages/graphx/src/core/duck.ts` — bucket-backed lifecycle: lazy `open()`, `snapshot()`,
  `commit()`, `reload()`, the write mutex, and an `S3ObjectStore` built by dynamic import so
  `@aws-sdk/client-s3` stays off the `core/duck` import path.
- `packages/graphx/src/core/db.ts` — the `ManagedWriter` structural seam plus the DuckDB bucket
  fields on `DbConfig`.
- `packages/graphx/src/core/graph.ts` — `Graph.write(fn)` write sessions, per-mutation `touched()`
  publishing, the serialize wrapper on both write envelopes, and DuckDB's conflict signals in
  `isRetryableContention`.
- `packages/graphx/src/core/bulk.ts` — one publish per bulk load rather than one per row.
- `packages/graphx/src/core/serve.ts` — `…: too much contention` → 409.
- `packages/graphx/test/core/duck-e2e.test.ts`, `duck-commit.test.ts` — the round trip, against
  memory or a real bucket via `GRAPHX_TEST_S3_ENDPOINT`.
- `.gitignore` — `*.duckdb`/`*.duckdb.wal`.
- `.github/workflows/ci.yml` — new `test-duckdb` job (`continue-on-error: true` until stage 5–7
  close the full-text gap; see the job's comment for the exact removal condition).

## What's left before the CI gate can go green (`continue-on-error: true` comes off)

- **Stage 5 — done.** DuckDB now has its own full-text index (see "Full-text index" below), built
  and rebuilt in application code at commit time rather than via DuckDB's `fts` extension.
  `ftsWhere`/`ftsSeedLive`/`ftsSeedAsOf`, hybrid retrieval, and everything that depends on them
  (`eval-golden`, `admin-list`'s full-text filters, `p14-limits`'s hybrid-fanout/cap tests, the
  React `useHybrid` FTS test) now pass. **The index is unstemmed by design** — its tokenizer
  matches libSQL's default FTS5 `unicode61` tokenizer, which also does not stem. That match is
  exact for stopwords and digits but not for diacritics: our `[^\p{L}\p{N}]+` tokenizer KEEPS
  them, while `unicode61` strips them by default — a genuine, currently untested difference,
  since no corpus body in the ground-truth fixture contains one. Postgres's
  `tsvector`/`tsquery` path does stem and drop stopwords, so Postgres's lexical recall on
  inflected queries (e.g. a query for "running" matching a document that only says "runs") is
  genuinely higher than either DuckDB's or libSQL's. Nothing here forecloses adding a stemmer
  later — the index is rebuilt from scratch on every dirty commit, so a tokenizer change is
  additive, not a migration.
- **Task 16 — done.** `p14-concurrency.test.ts` now asserts what DuckDB actually guarantees
  (a serialized single writer via the client's write mutex, and the manifest CAS across
  processes) instead of lock-contention retry behavior that has no DuckDB analog. Closed 4
  failures.
- The 2 raw-SQL-bypass constraint tests are not expected to close — they pin a real,
  permanent difference between DuckDB's application-level enforcement and libSQL/Postgres's
  DB-level partial indexes (see above).

## Why `ranking-golden.json`'s `shared` section was left untouched

`packages/graphx/test/core/fixtures/ranking-golden.json` has a `shared` section (dialect-independent
cosine distances, asserted against every driver with `expect.closeTo`) and a per-driver
`byDialect` section. Regenerating the file for a new driver is documented in
`eval-parity.test.ts` as `UPDATE_RANKING_GOLDEN=1 GRAPHX_TEST_DRIVER=<driver> bun test
packages/graphx/test/core/eval-parity.test.ts`, and that path rewrites `shared` unconditionally —
whichever driver runs last "owns" the committed `shared` values.

Running that regeneration under DuckDB produced the expected `byDialect.duckdb` entry, but it
also rewrote 44 of `shared`'s distance values by roughly `1e-8` each (e.g. the `colossus`
distance for "who designed the analytical engine" moved from `0.692206494` to `0.692206502` —
the exact pair of numbers used as the illustrative example in the test file's own doc comment
about cross-kernel float drift). `shared` is computed via each dialect's own SQL distance
function (`list_cosine_distance` for DuckDB vs. `vector_distance_cos` for libSQL), so different
engines landing on slightly different floats for the same cosine distance is expected, not a bug.

The fix actually applied: **only `byDialect.duckdb` was added; `shared` and the other two
`byDialect` entries are byte-identical to what was committed before this branch.** This works
because `shared` is compared with `expect.closeTo(want, DIST_PLACES)` (`DIST_PLACES = 5`, i.e.
`1e-5`) rather than exact equality — libSQL's existing `shared` values already pass comfortably
against DuckDB's own computation, three orders of magnitude inside tolerance. Rewriting 44
reference values to chase sub-tolerance float noise would have been pure churn, and worse, it
would have silently rebased the cross-dialect reference onto DuckDB's kernel the next time
someone ran the regeneration script without noticing — a change nobody asked for and invisible
in a future diff. Splicing in only the new key keeps the reference exactly as libSQL originally
measured it, while still giving DuckDB its own recorded `byDialect` entry.

## Full-text index

DuckDB has no queryable-view-compatible FTS extension (see the design note in `dialect-sql.ts`
for why `fts`/HNSW were ruled out), so full-text is a small inverted index built and maintained
in application code, in four tables:

- **`fts_dict`** — the term vocabulary: `term → docFreq`.
- **`fts_docs`** — per-document stats needed for BM25: `docId → length` (token count).
- **`fts_terms`** — the postings list: `term, docId → termFreq`.
- **`fts_stats`** — corpus-wide scalars BM25 needs: document count and average document length.

`fts_dict` and `fts_stats` span **live and history together** — a term's document frequency and
the corpus average are computed over every version ever committed, matching how libSQL's FTS5
virtual table and Postgres's `tsvector` column are never pruned when a row's `valid_to` closes.
The **exported Parquet file sets are split** the same way every other table is: a `fts_*_live`
set for the current head and a `fts_*_history` set for everything before it, mirroring
`node_versions`/`edge_versions`.

**Build/rebuild timing.** The index is rebuilt from scratch, in one transaction, whenever a
commit's dirty-table set includes `node_versions`; if `node_versions` was not touched, the
existing index is carried forward unchanged rather than rebuilt. This is a full rebuild rather
than an incremental update — acceptable because DuckDB commits are already whole-snapshot
exports, and it avoids the bookkeeping an incremental postings-list update would need. The
rebuild runs inside a transaction of its own, opened and committed by `rebuildIndex` — not the
commit's transaction, since a DuckDB commit is Parquet exports plus a manifest CAS, not a
transaction at all. Readers never observe a half-built index: a reader on another connection
sees the previous complete index until `rebuildIndex`'s transaction commits, and the new
complete one after — never an in-between state.

**Local (non-bucket) clients.** A client with no bucket configured never calls `commitSnapshot`,
so it needs its own way to notice when the index has gone stale relative to writes. It keeps a
staleness flag backed by a corpus signature — `count(*)` and `max(ver)` over `node_versions` —
and rebuilds when the signature no longer matches what the index was built against. This gives
the same coverage as libSQL's `AFTER INSERT` trigger (every write that changes the corpus is
eventually reflected) without needing a trigger DuckDB doesn't have.

**Readers need no `fts` extension, no `ATTACH`, and no `USE`.** The index lives in ordinary
tables queried with plain SQL (`bm25Cte` in `fts/index-tables.ts`), so any DuckDB connection that can
read `node_versions` can read the full-text index too.
