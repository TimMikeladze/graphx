# DuckDB Support — Parity Record

## Status (as of this branch)

- **Stages 1–3 (object storage, DuckClient, schema, fragments, bulk/journey/pattern, constraint
  enforcement): DONE.** `packages/core/src/duck.ts` (`DuckClient implements DbClient` over a
  pooled `@duckdb/node-api` connection), `duckdbSchema()` in `dialect-sql.ts` (real
  `node_versions`/`edge_versions` tables, `nodes`/`edges` views — no live/history split at the
  local-schema layer; that split is a Parquet-layout concern for stage 4), every dialect fragment
  filled in for `duckdb` except full-text, and application-level uniqueness/cardinality
  enforcement (`duck-constraints.ts`) standing in for the partial UNIQUE indexes libSQL/Postgres
  use (DuckDB has none). Graph mutations (`addNode`/`updateNode`/`addEdge`/`deleteEdge`/bulk
  load) work end to end.
- **Stage 4 (this task) — third harness arm + first parity measurement: DONE.**
  `packages/core/test/harness.ts` gained a `duckdb` branch in `makeTestDb()` (a temp
  `test_<ulid>.duckdb` file, never `:memory:`, so `sibling()` can open a genuine second
  connection) and a `duckdb` arm in `tableExistsSql` (`duckdb_tables()`/`duckdb_views()`). The
  whole ~1071-test suite then ran under `GRAPHX_TEST_DRIVER=duckdb` for the first time.
- **Verification:** libSQL **1068 pass / 3 skip / 0 fail** (unchanged from before this task —
  the duckdb branch is additive and sits ahead of the postgres/libsql branches in the
  if-chain). DuckDB: **1022 pass / 22 skip / 27 fail**. The 22 skips are the 18
  `libsqlOnly`-gated libSQL-internals probes, the 3 `outbox.test.ts` tests already gated
  `skipIf(TEST_DRIVER !== 'postgres')`, and 1 `cli.test.ts` test now gated to libSQL only (see
  below) — none of which have a DuckDB analog to run. The 27 failures triage exactly to the
  rows below; nothing was left uncategorized.

| category | count | resolved by |
|---|---|---|
| full-text: `ftsWhere`/`ftsSeedLive`/`ftsSeedAsOf` throw `notYet`, and hybrid retrieval (which fuses a lexical leg) inherits the same gap | 21 | stage 5 |
| constraint enforcement is application code, not a DB index — a raw-SQL insert that bypasses `Graph.addNode`/`addEdge` is not rejected (see the parity note below) | 2 | N/A — design, not a gap |
| `p14-concurrency` — asserts lock contention that does not exist on this backend | 4 | Task 16 rewrite |
| outbox ordering and trigger-runner cursors | 0 | already gated `postgres`-only; none ran or failed under duckdb |
| auth package read-modify-write idempotency | 0 | `packages/auth` does not import the harness; unaffected by this arm |
| multi-tenant `getDb` suites needing a bucket per namespace | 0 | already pass — `getDb`'s duckdb factory falls back to one local file per namespace, which is sufficient until stage 4/Task 15 moves it to object storage |
| libSQL-internals probes | 0 | already skipped by `libsqlOnly` (and the 3 `outbox.test.ts`/1 `cli.test.ts` driver-pinned tests) |

Two rows above differ from the plan's expected shape and are explained here:

- **Outbox and multi-tenant `getDb` rows are 0, not the plan's estimate.** `outbox.test.ts`'s
  three tests were already `skipIf(TEST_DRIVER !== 'postgres')` — a genuine allowlist, so they
  correctly skip under duckdb rather than fail. The multi-tenant suites (`p11-serving`,
  `admin-app`, `admin-list`, authz, cdc) all pass: `getDb`'s duckdb factory
  (`packages/core/src/duck.ts`'s `registerDuckDriver` call) already resolves one local
  `<namespace>.duckdb` file per tenant, which is enough for these tests today. The bucket-per
  namespace requirement is a stage-4/Task-15 concern (object storage), not something these
  suites currently exercise.
- **auth package is 0/unaffected.** `packages/auth`'s tests obtain a client directly (not via
  `packages/core/test/harness.ts`) and were not touched by adding the third arm.

## Real bugs fixed (Tasks 1–12), not parity gaps

Investigating every failure surfaced six defects that had nothing to do with full-text or
concurrency — each is a genuine bug in earlier stages, fixed as part of closing this task (all
verified against libSQL and, where applicable, Postgres to confirm no regression):

1. **`duckdbSchema()` was missing every foreign key** (`packages/core/src/dialect-sql.ts`).
   `node_versions.id`, `edge_versions.id`, `edge_versions.src`, and `edge_versions.dst` had no
   `REFERENCES` clause at all, unlike the libSQL and Postgres schemas — so an edge to a
   non-existent node silently inserted instead of failing (`P11: edge to a non-existent endpoint
   (FK violation) -> 400, not 500` got a 201). DuckDB enforces `REFERENCES` natively; the fix
   just adds the same four clauses libSQL/Postgres already have. This was an oversight in Task
   9, not a documented/intentional gap — nothing in `duckdbSchema`'s own "differences from
   libSQL" doc comment or in `duck-schema.test.ts` claimed FKs were dropped (contrast with the
   partial-unique-index gap, which is both documented and pinned by a test).
2. **`updateNode`'s emb carry-forward threw on DuckDB** (`packages/core/src/graph.ts`). A
   data-only patch (no new `emb`) rebinds the current row's embedding forward via
   `embRebindExpr(dialect)`, which for duckdb is `from_json(?, '["FLOAT"]')` — it expects a JSON
   *string*. But the value read back from a `FLOAT[]` column comes back as a genuine JS array,
   and binding an array where a string is expected made `@duckdb/node-api` throw "Cannot create
   values of type ANY." Fixed by running the read-back value through `embParam()` (already built
   for exactly this in `duck-value.ts`, previously only used by tests) before binding, mirroring
   the `JSON.stringify` already done for a freshly-supplied `emb`.
3. **Constraint violations always mapped to 500, never 400** (`packages/core/src/admin.ts`,
   `packages/core/src/serve.ts`). Both error mappers recognized libSQL's `SQLITE_CONSTRAINT*`
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
   `packages/cli/test/cli.test.ts` had `const PG = ... === 'postgres'; test.skipIf(PG)(...)` on
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
   - `packages/mcp/src/bin.ts` (production): the local-mode bootstrap now imports
     `@graphx/core/pg` or `@graphx/core/duck` based on `GRAPHX_DB_DRIVER`, mirroring the
     config-driven `await import('@graphx/core/pg')` `packages/cli/src/cli.ts`'s `loadConfig`
     already does for postgres configs.
   - `packages/mcp/test/server.test.ts`: added unconditional side-effect imports of both
     adapter subpaths (test-only; both are already dev dependencies of the workspace), mirroring
     why `core/test/harness.ts` imports `duck.ts`/`pg.ts` unconditionally.
   - `packages/mcp/test/bin.test.ts`: one assertion hard-coded the libSQL `<namespace>.db`
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

## Files changed

- `packages/core/test/harness.ts` — third `makeTestDb()` arm, `tableExistsSql` duckdb case,
  `GRAPHX_DB_DRIVER` env wiring.
- `packages/core/src/dialect-sql.ts` — added the missing `REFERENCES` clauses to `duckdbSchema()`
  (bug #1 above).
- `packages/core/src/graph.ts` — fixed the `updateNode` emb carry-forward bind for duckdb (bug
  #2).
- `packages/core/src/admin.ts`, `packages/core/src/serve.ts` — recognize DuckDB's `"Constraint
  Error:"` message shape (bug #3).
- `packages/core/test/retrieval-legs.ts` — duckdb branch for `annScored`'s distance expression
  (bug #4).
- `packages/cli/test/cli.test.ts` — allowlist the libSQL-only `buildServeApp` skip gate (bug #5).
- `packages/mcp/src/bin.ts`, `packages/mcp/test/server.test.ts`,
  `packages/mcp/test/bin.test.ts` — register the pg/duck adapters; driver-aware filename
  assertion (bug #6).
- `.gitignore` — `*.duckdb`/`*.duckdb.wal`.
- `.github/workflows/ci.yml` — new `test-duckdb` job (`continue-on-error: true` until stage 5–7
  close the full-text gap; see the job's comment for the exact removal condition).

## What's left before the CI gate can go green (`continue-on-error: true` comes off)

- **Stage 5** builds the DuckDB full-text path (an inverted index built at commit time — the
  design note in `dialect-sql.ts` explains why DuckDB's FTS extension and HNSW index can't be
  used directly: neither can index a view, and HNSW can't be partial). This closes 21 of the 27
  failures: `ftsWhere`/`ftsSeedLive`/`ftsSeedAsOf`, hybrid retrieval, and everything that depends
  on them (`eval-parity`, `eval-golden`, `admin-list`'s full-text filters, `p14-limits`'s
  hybrid-fanout/cap tests, the React `useHybrid` FTS test).
- **Task 16** rewrites `p14-concurrency.test.ts` to assert what DuckDB actually guarantees (a
  serialized single writer via Task 16's write-session mutex) instead of lock-contention retry
  behavior that has no DuckDB analog. Closes 4 failures.
- The 2 raw-SQL-bypass constraint tests are not expected to close — they pin a real,
  permanent difference between DuckDB's application-level enforcement and libSQL/Postgres's
  DB-level partial indexes (see above).
