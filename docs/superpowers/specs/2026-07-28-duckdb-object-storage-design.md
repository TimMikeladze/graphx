# DuckDB on Object Storage — a Third Backend

> Status: approved design, pre-implementation. Date: 2026-07-28.
> Scope: add a third graphx backend that stores a graph as immutable Parquet in an
> object-storage bucket and queries it with an embedded DuckDB. Read-mostly graphs,
> infrequent writes, full API parity with the libSQL and Postgres backends.

## 1. Goal

Ship a graph as an artifact. A bucket holds the whole database; any number of Node or Bun
readers query it directly with no server to run, no connection pool, and no ops. Writes are
rare but real — the backend is not a read-only mirror. A single writer commits new snapshots
straight to the bucket, serialized by the object store's own compare-and-swap.

Three drivers, in the user's words: zero-ops distribution, cost at scale, and serverless
readers. Analytics is explicitly not one.

The user-facing API does not change. A consumer who passes `{ driver: 'duckdb', bucket, prefix }`
instead of a libSQL or Postgres config gets the same `Graph`, `Auth`, `retrieve`, `match`,
`journey`, and HTTP surface, with the same JSON wire contracts. This is the same hard
constraint Postgres support was built under (`docs/POSTGRES_SUPPORT.md` §0), and it is met the
same way: a third branch in the existing dialect seam, measured by the existing test suite.

## 2. Requirements settled during brainstorming

| Question | Answer |
|---|---|
| Why object storage | Zero-ops distribution, cost at scale, serverless/edge readers |
| Write model | Direct writes, graphx owns the transaction log — no lakehouse, no catalog DB |
| Runtime | Node/Bun server or container only |
| Scale | Design for ~1M nodes; do not block 10M later |
| Parity scope | Everything: core reads + temporal, retrieval, pattern/journey/algorithms, `serve()`/admin/authz |
| Reader freshness | Resolve the manifest per query, ETag-revalidated |
| Commit unit | Auto-commit per mutation; `graph.write(fn)` groups a body into one commit |

## 3. Non-goals for v1

- **Browser and edge readers.** `@duckdb/node-api` is a native addon. duckdb-wasm is a
  separate build target and is not attempted here.
- **ANN quantization and partitioning.** The manifest carries the fields (`ann_live.quant`,
  a centroid partition column) so they can land without a format break. v1 writes `quant: "f32"`.
- **DuckLake, Iceberg, or Delta interop.** Evaluated and rejected in §4.
- **Replication tooling.** No libSQL↔bucket sync command.
- **Multi-writer throughput work.** Concurrent writers are correct — they rebase and retry —
  but the design targets one writer at a time.

## 4. Approaches considered

**Chosen — DuckDB as a third dialect over a self-managed snapshot store.** A `DuckClient`
implements the existing `DbClient` interface, backed by a local DuckDB materialized from a
manifest in the bucket. Commits write immutable Parquet and claim the next snapshot number with
a create-if-absent PUT. The payoff is that `GRAPHX_TEST_DRIVER=duckdb` runs the existing suite,
so parity is measured rather than promised.

**Rejected — DuckLake as the storage engine.** DuckLake v1.0 is production-ready and offers
ACID, time travel, and compaction for free. It also requires a catalog database — a DuckDB file
limits you to a single client, and multi-client means Postgres — which reintroduces exactly the
server this design exists to remove. Beyond that it has no indexes, no primary keys, no unique
constraints, and no sequences (its docs call these "unlikely ever"), so `node_identity`'s PK,
both edge foreign keys, `ver`, `graph_outbox.seq`, and every index in the schema would have to
be re-implemented above it. We would fight its limits and still hand-roll constraints.

**Rejected — a pure-JS Parquet reader, no DuckDB.** Drops the 123MB native dependency and would
run on edge runtimes, but reimplements the entire query surface in JavaScript. Parity stops
being something the test suite can prove. The runtime requirement rules out the only benefit.

## 5. Amendment to a locked constraint

`initial_spec.md:122-125` sits in the non-negotiable section:

> **Storage split.** libSQL owns topology, current state, and vectors (native ANN). S3 owns
> content-addressed blobs. Parquet + DuckDB own cold history and analytics. **No LanceDB. No
> Iceberg. No catalog. No separate vector DB.**

This design promotes DuckDB from the cold half to a complete backend. It honors the second half
of the clause — no Iceberg, no catalog, no separate vector database — but it does amend the
storage split, and that is recorded here rather than left to be discovered.

It also subsumes P10 (`initial_spec.md:109`, §13), which is unbuilt (`docs/GAPS.md:30`). P10's
promised Hive-partitioned archive key layout is the history layout in §6, so tiering stops being
a separate subsystem.

## 6. Storage layout

```
s3://bucket/{namespace}/
  _head                       hint only, never authoritative: {"snapshot":42}
  snapshots/00000042.json     manifest — immutable, created with create-if-absent
  data/<sha256>.parquet       content-addressed, immutable, never overwritten
```

`namespace` is a key prefix, so multi-tenancy works the way it does on Postgres, where a
namespace maps to a schema.

### 6.1 The live/history split

> **Amended during implementation.** This section originally made the split a *local schema*
> decision — `node_versions` as a view over two tables. That breaks every write path: DuckDB
> rejects `INSERT` into a `UNION ALL` view, while `Graph`'s five mutation methods, `bulkLoad`,
> `bulkEdges`, and the auth package all write to `node_versions` and `edge_versions` by name,
> because on libSQL and Postgres those are real tables.
>
> The split is now a **storage-layout** decision only. The local materialization keeps single
> tables mirroring the Postgres schema, so no write path changes; the commit step exports live
> and history as separate Parquet files, which is where the benefit actually was — a reader
> needing only current state fetches the live file, and history stays partitionable by close
> time for tiering.
>
> The cost: one-live-row-per-id is no longer backed by a primary key. It is enforced by the
> serialized writer (§8.2) and application-level checks (§11) — already the accepted model for
> constraints DuckDB cannot express.

The layout below describes the **Parquet files in the bucket**, not the local tables:

| manifest key | files | contents |
|---|---|---|
| `node_versions` | `[live, history…]` | live rows first, then closed versions |
| `edge_versions` | `[live, history…]` | same |

Locally both load into one table; `nodes` and `edges` are views filtered to
`valid_to = FOREVER`, exactly as on Postgres.

Every index in graphx is a *partial* index whose predicate is `WHERE valid_to = 8640000000000000`
— `nv_emb_idx`, `ux_single_<rel>`, `ux_<type>_<prop>` (`dialect-sql.ts:424-429`,
`constraints.ts:60-91`) — and DuckDB has no partial indexes. None of the three survives as a SQL
index here, and the file split does not rescue any of them:

- `nv_emb_idx` has no DuckDB counterpart at all (§10.1). ANN is a brute-force scan filtered to
  `valid_to = FOREVER`, and the live Parquet file is what keeps that scan small.
- `ux_single_<rel>` and `ux_<type>_<prop>` become application-level checks under the serialized
  writer (§11).

What the file split buys is therefore about **fetching**, not indexing: a reader that only needs
current state downloads the live file alone, and history stays partitioned by close time so P10
tiering falls out of the layout rather than needing a separate subsystem.

Everything else — `node_identity`, `edge_identity`, `graph_outbox`, `node_analytics`,
`trigger_cursors`, `trigger_dead_letters`, `archival_state`, and the auth tables — is a plain
append-or-rewrite table.

### 6.2 Manifest

One immutable manifest per commit:

```jsonc
{ "v": 1, "snapshot": 42, "parent": 41, "committedAt": 1753660000000,
  "embDim": 768, "schemaHash": "…",
  "verHigh": 102253, "seqHigh": 90210,
  "tables": {
    // Live first, then history — a reader needing only current state takes files[0].
    "node_versions": { "files": ["sha256:live…", "sha256:hist…"] },
    "edge_versions": { "files": [ … ] },
    "graph_outbox":  { "files": [ … ] }
  },
  "indexes": {
    "fts_live":   { "dict": …, "terms": …, "docs": …, "stats": … },
    "fts_history": { … },
    "ann_live":   { "files": [ … ], "quant": "f32" } } }
```

`verHigh` and `seqHigh` are the allocation high-water marks for `node_versions.ver` and
`graph_outbox.seq`. The writer allocates from the manifest, not from a live sequence, because
DuckDB sequences are non-transactional — an aborted commit would burn values and reorder them.

`schemaHash` covers the embedding dimension and every declared constraint. A writer whose
in-memory schema hashes differently from the manifest refuses to commit, which catches the case
where two application versions with different `defineGraphSchema` output write to one bucket.

`indexes.fts_*` lists four of the six tables the FTS index needs — `dict`, `terms`, `docs`,
`stats`. `fields` is constant because graphx indexes one field (`body`), and `stopwords` is a
build-time input, not a query-time one.

`files` is an array so live can be **base + delta parts + a tombstone file**. That keeps a commit
O(changed rows) rather than O(live rows) — the difference between 200ms and 5s once the graph is
large. A reader resolves live as the parts minus the tombstones, deduplicated by id on the
greatest `valid_from`. Compaction rewrites the base when either 16 delta parts have accumulated
or the deltas exceed a quarter of the base row count, whichever comes first; both are
configurable and neither affects read correctness.

## 7. Commit protocol

1. **Resolve head.** `GET _head`, read that manifest, then probe `n+1` until 404. Usually zero
   extra requests; `_head` being stale or racy is harmless because it is only a hint.
2. **Apply.** Mutations run against a local DuckDB materialized from snapshot *n*.
3. **Upload.** Changed tables are written to Parquet and PUT under their content hash. Unchanged
   tables reuse their existing refs. Content addressing makes every PUT idempotent, so a
   retried or duplicated upload is a no-op and a lost acknowledgement cannot corrupt anything.
4. **Claim.** `putIfAbsent snapshots/{n+1}.json`. Success commits. Failure means another writer
   took *n+1*: refetch, rebase the buffered mutations, retry under the existing
   `WRITE_MAX_RETRIES = 50` bound and jittered backoff (`graph.ts:290,315`).
5. **Sweep.** Objects orphaned by a lost race are unreferenced garbage, removed by a GC pass.

The only primitive required is create-if-absent. No `If-Match`, no lease, no catalog.

### 7.1 Provider support for create-if-absent

| provider | supported | mechanism |
|---|---|---|
| AWS S3 | yes — verified live; 12 threads racing one key gave exactly 1 winner and 11×412 | `If-None-Match: *` |
| Cloudflare R2 | yes, since 2022 | `If-None-Match: *` |
| MinIO | yes — verified live, identical to S3 on all 11 probes | `If-None-Match: *`; pin a ≥2025 build, older ones accepted `*` without enforcing it |
| Tigris | yes | `If-None-Match: *` |
| GCS (S3-compat) | yes, with a different header | `x-goog-if-generation-match: 0`. Google documents `If-None-Match` on PUT for GET/HEAD only, and whether GCS rejects or *silently ignores* it is unknown — silent-ignore would degrade the guard to an unconditional overwrite returning 200 |
| Backblaze B2 | **no** — neither the S3 API nor the native API has a conditional write | unsupported; throws at config time |

S3 also documents 409 `ConditionalRequestConflict` when a delete races an in-flight conditional
PUT, so 409 is treated as a retryable conflict alongside 412.

Because two of those rows rest on documentation rather than a live test, the client runs a
**startup CAS probe**: `putIfAbsent` a temporary key twice and assert the second fails. That
converts the GCS unknown and the MinIO version question into a runtime fact at connect time
instead of a silent data-loss mode under contention.

## 8. Runtime architecture

A new subpath export `@graphx/core/duck`, mirroring `./pg`: importing it calls
`registerDuckDriver()` as a side effect, which keeps the 123MB `@duckdb/node-api` an optional
peer dependency.

```
DuckClient implements DbClient          dialect: 'duckdb'
  ├─ DuckDBInstance + connection pool
  ├─ SnapshotStore    manifest resolve / commit CAS
  └─ ObjectStore      putIfAbsent · get · list · delete   ← provider seam
```

`DbConfig` gains `bucket`, `prefix`, `cacheDir`, `endpoint`, `region`, `credentials`, and an
optional `snapshot` for pinned, reproducible reads.

### 8.1 Reader path

Resolve the manifest, ensure files are local, query.

Resolution is a conditional `GET _head` carrying the previously seen ETag: a 304 reuses the
cached manifest, a 200 swaps in a new one. A query pins whichever manifest it resolved and reads
that snapshot to completion — a commit landing mid-query cannot disturb it, because the files
that query names are immutable and are never overwritten or deleted while referenced.

Files are content-addressed, so the local cache is `cacheDir/<sha256>.parquet` and needs no
invalidation logic at all. Table references are `read_parquet([...])` over a *mixed* local and
remote file list — a single scan across `s3://`, `http://`, and local paths works, with
`filename=true` giving per-file provenance — so a file that is not yet cached stays remote and
the query still runs while the cache warms.

The reader then sets `validate_external_file_cache = NO_VALIDATION`. Measured: a repeat query
drops from 1 HEAD request to **zero requests and zero bytes**. That setting is dangerous in
general — it was demonstrated serving stale bytes when a URL's content changed — and it is sound
here for exactly one reason: content addressing guarantees a URL's bytes never change.

The on-disk cache has to be ours because DuckDB will not do it. Its external file cache is
**in-memory and scoped to the `DuckDBInstance`, not the process**: measured 54 requests and
0.48MB cold, 1 HEAD and 0 bytes on repeat, and a second instance in the same process pays full
price again. Three consecutive processes against a persistent database file each paid full
price, and the file stayed at 12KB. Nothing survives a cold start. (`cache_httpfs` is a
community extension, not core, and is treated as unsupported.)

### 8.2 Writer path

One writer per namespace, serialized by an in-process async mutex. That mutex — not SQL
isolation — is what makes `runConditionalClose`'s `rowsAffected === 1` compare-and-swap sound
again (`graph.ts:996-1001`, `1101-1105`, `1148-1152`). DuckDB's `rowsChanged` is verified
reliable per statement: an `UPDATE` matching 0 rows reports 0, matching 2 reports 2,
`ON CONFLICT DO NOTHING` on a duplicate reports 0.

`graph.write(fn)` opens a write session: materialize the needed tables into local base tables,
run the body, commit once. A bare `addNode()` outside a session commits on its own. A nested
`write` joins the enclosing session rather than opening a second one, so the outermost call owns
the commit. A body that throws commits nothing.

Serialization also disposes of three problems at once. `seq` order equals commit order by
construction, so `PG_OUTBOX_VISIBLE` (`temporal.ts:254-264`) has nothing to do and is omitted.
The in-transaction reads that the M6 monotonic-clock bump depends on (`graph.ts:983-988`,
`536-541`) are genuinely serialized. And the auth package's `INSERT … WHERE NOT EXISTS`
idempotency guards (`auth/store.ts:21-27,66-89`) get back the single-writer assumption they were
written under.

### 8.3 Adapter landmines

Every one of these is silent, and every one was reproduced against `@duckdb/node-api@1.5.5-r.2`.

1. **`COMMIT` on an aborted transaction resolves successfully and discards the writes.** An
   adapter that treats a resolved `commit()` as durability will lie to its caller. Track an
   `aborted` flag; any in-transaction error marks it fatal; `commit()` on an aborted transaction
   throws.
2. Only conversion, constraint, and out-of-range errors abort a transaction. Parser, catalog,
   and binder errors throw but leave it live. `1/0` does not throw at all — it returns NULL.
3. **A transaction must own a dedicated connection.** One connection is serialized but shared,
   so two interleaving async tasks silently merge transactions: in the reproduction, task B's
   autocommit insert was swallowed into task A's rollback, leaving the table empty with no error
   raised. `transaction()` checks a connection out of the pool exclusively for its lifetime.
4. Multi-statement `run()` returns the *first* SELECT's result if any statement is a SELECT and
   the last statement's otherwise, and scrambles `rowsChanged`. `executeMultiple` uses
   `extractStatements` with prepare and run in lockstep.
5. `RETURNING` zeroes `rowsChanged`, because the statement's return type flips to a query
   result. Never combine it with the compare-and-swap path.
6. `listValue([1.0, 0.5, 0.25])` infers `INTEGER[]` from the **first element alone** and yields
   `[1, 0, 0]` with no error. Embeddings bind as `JSON.stringify(vec)` with `$1::FLOAT[dim]`,
   which is bit-exact (verified for 1/3, 1e-8, and FLT_MAX), costs 21.8ms per query on 20k×768,
   and is structurally immune to the inference bug.
7. `BIGINT` always returns a JS `bigint`, even for small values — the same `Number(vf)`
   normalization Postgres already required.
8. An `INTERNAL Error` escalates to a FATAL that kills **every connection on the instance**,
   including connections opened afterward. Detect `database has been invalidated`, discard the
   instance, rebuild the pool.

## 9. The `duckdb` dialect branch

`Dialect` gains `'duckdb'`. Before anything else, `dialectOf` is made to return an exhaustive
union and every branch becomes a `switch` with a `never` check. The 12 inline
`dialectOf(...) === 'postgres'` tests scattered through `schema.ts`, `constraints.ts`,
`temporal.ts`, `algorithms.ts`, `db.ts`, `bulk.ts`, `journey.ts`, and `pattern.ts` have no
default case today, so a third dialect silently takes the libSQL arm and throws at `init()`.
This refactor converts that class of bug into a type error.

### 9.1 Fragments in `dialect-sql.ts`

| fragment | duckdb | note |
|---|---|---|
| `scalarMax`, `epochIntType`, `distinctSelect`, `jsonEqArg` | reuse the Postgres branch | `GREATEST`; `BIGINT`, since DuckDB's `INTEGER` is 32-bit and epoch-ms overflows it; real `DISTINCT ON`; `String()` coercion |
| `insertOrIgnore` | reuse the libSQL branch | DuckDB accepts SQLite's `INSERT OR IGNORE` |
| `jsonField`, `jsonEqExpr` | new — `json_extract_string(col, '$.k')` | `json_extract` returns *JSON*, so `= 'foo'` is silently false. Highest silent-corruption risk in the port; it reaches every `.where()` in `pattern.ts` |
| `jsonArrayRows` | new — `unnest(from_json(?::JSON, '["VARCHAR"]'))` | a naive `unnest(json_extract(…))` yields quoted strings and joins to zero rows |
| `embColumnType` | `FLOAT[]` | Parquet cannot preserve `FLOAT[N]` — even a pyarrow `fixed_size_list` reads back as `FLOAT[]` — so a variable-length list is the honest storage type |
| `embFreshExpr`, `embRebindExpr` | `from_json(?, '["FLOAT"]')` | needs no `dim`, so the existing signature holds |
| `embExtract` | `to_json(emb)` | a bare `::VARCHAR` cast renders non-finite floats as `nan`/`inf` and breaks `JSON.parse` at `hybrid.ts:318` |
| `annSeedsLive`, `annSeedsAsOf`, `vecSeedLive` | Postgres branch shape with `list_cosine_distance` | measured faster than casting to `FLOAT[N]` (0.183s vs 0.406s). As-of ranking improves on libSQL's `MIN(v.id)` rowid proxy — it becomes true distance |
| `ftsWhere`, `ftsSeedLive`, `ftsSeedAsOf` | own BM25, §10.2 | |
| `vectorIndexDDL`, `ftsTableDDL`, `ftsTriggerDDL` | `''` | no ANN index, no FTS virtual table, no triggers |
| `postgresSchema` | new `duckdbSchema(dim)` sibling, ~250 lines | `CREATE SEQUENCE` plus `DEFAULT nextval()` for `ver` and `seq`; live/history tables per §6.1 |

### 9.2 Inline branches

`applyConnPragmas` (`db.ts:15`) becomes a no-op. `ensureColumn` (`schema.ts:167`) drops its
`PRAGMA table_xinfo` probe entirely — DuckDB has `ADD COLUMN IF NOT EXISTS`. `readEmbDim` reads
`embDim` from the manifest instead of regexing `sqlite_master`. `algorithms.ts:341` takes the
`isPg` branch verbatim, because DuckDB rejects `ORDER BY` in a recursive term exactly as
Postgres does. `temporal.ts:294,320` omits the outbox visibility gate per §8.2.
`bulk.ts:200,238,246` loses its drop-index/drop-trigger/rebuild/`ANALYZE` sequence, which has
nothing to operate on, in favour of the Neo **Appender** (~5.5M rows/s against ~17k/s for
batched inserts) plus one index build at commit.

Two need real care. `journey.ts:104-106` projects bare `?` parameters in a CTE anchor and DuckDB
has nothing to infer a type from, so those need explicit `?::VARCHAR`. And `pattern.ts:403`'s
row-value keyset `(a,b) > (?,?)` with untyped parameters is unverified on DuckDB; it falls back
to the OR-form already written at `temporal.ts:139`.

## 10. Retrieval

### 10.1 Vector search — brute force, no index

The `vss` extension is excluded on evidence. It cannot index a view or Parquet (`can only create
an index on a base table`); it is RAM-only, unbuffered, and its size does not count toward
`memory_limit`; it roughly doubles storage; its persistence flag is documented as risking index
corruption on unclean shutdown; and it **silently returns fewer rows than `LIMIT` when combined
with a `WHERE` filter**, because the filter is applied above the index scan. Every graphx ANN
query carries a `WHERE` filter. Attaching a 931MB HNSW-indexed database over HTTP transferred
932MB — it is "download the whole index into RAM, then query", not an object-storage-native
index.

Brute force over the live rows costs roughly 0.5s per million vectors at 384 dimensions on 8 cores;
20k×768 measured 21.8ms per query. The §8.1 local cache is what makes this viable: served
purely remotely, every ANN query re-egresses the entire embedding column (1M×768 ≈ 3GB), and the
in-memory cache does not survive a cold start.

The seed fragments use `min_by(id, dist, k)` rather than `ORDER BY dist LIMIT k`. Verified
identical top-k, but it reads a remote Parquet **once instead of twice** (1.0× the file size
against 2.0×) and is faster locally as well. Ranks come from the unnest position.

Scaling levers are in the manifest and unbuilt: `ann_live.quant` (int8 shrinks the scan four-fold)
and a centroid partition column for probing top-p files.

### 10.2 Full-text search — our own inverted index

DuckDB's `fts` extension cannot index a view or `read_parquet`, never updates incrementally, and
its `incremental=`, `tokenizer=`, and `layered_search=` parameters exist only in the upstream
README and not in any released build. What it *does* give us is the shape: its index is six
ordinary tables (`dict`, `docs`, `terms`, `stats`, `fields`, `stopwords`). Exporting those to
Parquet and computing BM25 as a plain SQL join reproduced `match_bm25` to the last digit with
extensions fully disabled.

We build that index ourselves, in JavaScript and SQL, at commit time.

The reason not to build it with `PRAGMA create_fts_index` and merely export the tables is
stemming. A reader must stem query terms exactly as the writer stemmed document terms. Using
DuckDB's C++ Porter stemmer on the write side and a JavaScript stemmer on the read side means
two implementations that must agree forever — a silent divergence waiting to happen. Owning both
sides means one stemmer. The BM25 formula stays the verified one; only tokenization becomes
ours, and a golden test asserts our index tables match `create_fts_index`'s on the same corpus.

Readers therefore need no `fts` extension, no `ATTACH`, and no `USE <catalog>` — the extension
route forces all three, and the `match_bm25` macro references `fts_main_<table>` unqualified, so
it cannot be queried cross-catalog at all.

The index covers live and history, keyed on `ver`, which keeps as-of lexical search exact — the
property `ftsSeedAsOf` relies on today. `fts_live` and `fts_history` are separate file sets so a
live-only query does not scan history terms. `sanitizeMatch`'s FTS5 grammar becomes tokenize and
stem, and BM25 is disjunctive by default, which is exactly the OR semantics `tsQueryOr` was
written to restore on Postgres.

## 11. Constraints

`declareSingleValuedRel` gets no index either. `src` and `rel` are plain columns, but the libSQL
and Postgres arms scope their unique index to *one* rel, and DuckDB has no partial index to scope
with — an unconditional `UNIQUE(src, rel)` would silently make every rel single-valued. The
declaration is recorded in `graph_meta` and the invariant is upheld by `addEdge`'s existing
close-then-insert path.

`declareUniqueNodeProp` cannot be backed by the store. DuckDB indexes no JSON extraction, either
directly or through a generated column — verified on both 1.4.4 and 1.5.5. It is enforced in
application code inside the write mutex: a single `GROUP BY … HAVING count(*) > 1` in the same
local transaction, which is exact under serialization.

The alternative — materializing the constrained property into a real column and putting a plain
`UNIQUE(type, prop, valid_to)` on it — is store-backed but needs a DDL migration per declared
constraint and a rewrite of every historical file, and it false-conflicts when two different
nodes close in the same millisecond. Not worth it.

The honest cost of the chosen option is that nothing backstops a writer outside graphx. A
`graphx verify <snapshot>` command checks the invariants over any snapshot, which is worth having
regardless since it also catches a corrupt or truncated manifest.

## 12. Outbox, CDC, and triggers

`seq` is allocated from the manifest's `seqHigh` rather than from a live sequence, because
DuckDB sequences are non-transactional and an aborted commit would burn and reorder values. With
one serialized writer, commit order is seq order by construction.

`TriggerRunner` polls for new snapshots instead of polling a table. Its cursor stays in
`trigger_cursors` but checkpoints every N events or T seconds rather than on every delivery — one
commit per delivered event would be untenable on object storage. A restart redelivers from the
last checkpoint, which is the at-least-once contract the runner already documents. No API change.

One fix that is not DuckDB-specific: `algorithms.persist`'s `ON CONFLICT DO UPDATE` silently
keeps the first row on duplicate keys within a single batch, where Postgres raises. Deduplicate
in JavaScript before the upsert, on every backend.

## 13. Error handling

`isRetryableContention` (`graph.ts:297-313`) gains the DuckDB signals — `TransactionContext
Error: Conflict on …` and `transaction is aborted` — plus the storage-level CAS failures, 412 and
409. None of them match today's fallback regex, so without this every conflict falls through
`if (!isRetryableContention(e)) throw e` and surfaces as a 500. A commit conflict refetches the
head, rebases, and retries within the existing bound.

`"…: too much contention"` is unmapped in `serve.ts:687-715` and currently falls to 500. On
object storage it stops being theoretical, so it maps to 409. That is a pre-existing gap this
port makes visible.

A FATAL instance invalidation discards the instance and pool, rebuilds, and retries once.
`commit()` on an aborted transaction throws rather than resolving.

## 14. Testing

`GRAPHX_TEST_DRIVER=duckdb` becomes the third arm of `packages/core/test/harness.ts`, alongside
the helper branches for `embSql`, `embReadSql`, `jsonFieldSql`, `tableExistsSql`, and
`insertOrIgnoreSql`.

A harness bug blocks this and is fixed first. The skip gate is
`TEST_DRIVER === 'postgres' ? test.skip : test`, so any driver value that is not literally
`'postgres'` **runs** the 18 libSQL-internals probes — PRAGMA, `sqlite_master`,
`EXPLAIN QUERY PLAN`, `vector_top_k`, FTS5 mechanics. It becomes an allowlist: run only under
libSQL.

`p14-concurrency` cannot be ported as written. Its 5 tests open 8 connections to one database
file and rely on lock contention to prove version intervals stay contiguous. The DuckDB
equivalent proves the same invariant through the commit protocol: N writer processes race, each
snapshot number has exactly one winner, and intervals remain contiguous and non-overlapping.
Rewritten, not skipped.

Backend-specific tests beyond the ported suite: manifest CAS race; crash between object PUT and
manifest PUT, leaving orphans but no corruption; a reader pinned to snapshot *n* while a writer
commits *n+1*; cache correctness under `NO_VALIDATION`; BM25 golden against `create_fts_index`;
and `graphx verify`.

Parity target is the Postgres pass count on the suite as it stands when each stage lands, less
the libSQL-internals probes. It is defined relatively on purpose — `docs/POSTGRES_SUPPORT.md`
records 344 pass / 18 skip for Postgres, but the suite has grown well past that since, so a
fixed number would be stale before the first stage ships. The gate is: no test that passes on
Postgres may fail on DuckDB.

The test object store is a filesystem `ObjectStore` for speed plus MinIO in a container for the
real S3 path. Pin the MinIO image: `minio/minio` was archived in April 2026.

## 15. Delivery stages

Each stage ends green and committed.

1. **Seam hardening.** `Dialect` union plus `switch`/`never` exhaustiveness; harness skip-gate
   fix. Zero behavior change; both existing backends stay green.
2. **Storage layer.** `ObjectStore` and `SnapshotStore`, manifest, commit CAS, startup CAS probe.
   Filesystem and S3 implementations. Testable with no DuckDB involved.
3. **`DuckClient` over local DuckDB only.** Pool, transactions, the eight landmine defenses,
   `rowsChanged`. Most dialect fragments land here, and parity is measured for the first time.
4. **Snapshots wired in.** Live/history split, materialize-from-manifest, commit path,
   `graph.write()`.
5. **Retrieval.** Brute-force ANN, the BM25 index, hybrid fusion.
6. **Constraints, outbox, CDC, trigger runner, auth.**
7. **Serving and tooling.** `serve()`/admin, `graphx verify`, GC sweep, CLI publish and inspect.

This is more than one implementation plan's worth of work. Stages 1–4 form the first plan and
end at a backend that passes the core suite against a real bucket. Stages 5–7 get their own
plans, written once stage 4 is green and the parity number is known rather than estimated.

## 16. Verified facts this design rests on

Recorded so a future reader can tell measurement from assumption. Everything below was executed
against DuckDB 1.5.5 and `@duckdb/node-api@1.5.5-r.2`, or against live S3 and MinIO.

- `vss` HNSW cannot index a view or Parquet; is RAM-only outside `memory_limit`; and returns 0
  rows for a filtered top-k query that brute force answers with 10.
- `array_cosine_distance` and `list_cosine_distance` are core, needing no extension. `<=>`
  aliases cosine distance, `<->` L2.
- `min_by(id, dist, k)` returns the same top-k as `ORDER BY dist LIMIT k` at half the remote read.
- Parquet cannot round-trip `FLOAT[N]`; it reads back as `FLOAT[]`.
- The `fts` index is six plain tables, and a hand-written BM25 join over their Parquet exports
  reproduces `match_bm25` exactly.
- `PRAGMA create_fts_index` on a view fails with `Catalog Error: … is not an table`.
- `ORDER BY` and `LIMIT` in a recursive CTE term are parser errors, matching Postgres and
  breaking from SQLite.
- DuckDB has no triggers, no partial indexes, no `AUTOINCREMENT`, no rowid on views, and no index
  over a JSON extraction.
- `enable_external_file_cache` is in-memory and scoped to the `DuckDBInstance`; nothing persists
  across processes. `NO_VALIDATION` reduces a warm repeat query to zero requests.
- One `read_parquet([...])` list may mix `s3://`, `http://`, and local paths.
- `rowsChanged` is reliable per statement, and zeroed by `RETURNING`.
- `COMMIT` on an aborted transaction resolves and discards.
- Two async tasks sharing one connection silently merge transactions.
- `listValue` infers element type from the first element only, truncating floats without error.
- S3 conditional PUT: 12-way race, exactly one winner. MinIO identical on all 11 probes.
- B2 has no conditional write in either its S3 or native API.
