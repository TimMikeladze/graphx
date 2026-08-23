# graphx — Gaps & Missing Work

> What is spec'd or implied but **not built**. Original audit 2026-06-14 (`main` @ d1e459d, plus the unmerged `examples/file-ingest` admin work); **re-verified 2026-06-29** (`fix/ingest-top3-risks`).
> Scope: `packages/core`, `packages/auth`, `packages/admin`, the specs in `docs/`, and `initial_spec.md`.
>
> **2026-06-29 corrections:** §1 P9 (blob layer) is now **BUILT** (`packages/core/src/blob.ts`, commit `bc3b467`) — the original "MISSING" below was stale. §2 (SDK ops with no HTTP route) is **RESOLVED** — every listed op, including `neighborsPage`, is now in `serve.ts`. The full react-query R0 HTTP surface is live.

Code hygiene is clean — no abandoned `TODO`/`FIXME`, no skipped tests, no stubbed `throw new Error('not implemented')`. The gaps below are **whole features that were never started** or **SDK capabilities not yet reachable from a client**, not half-finished code.

---

## 1. Spec phases never implemented

`initial_spec.md` defines P0–P15. **13 of 15 built. Two are entirely absent** — no source file, no test, no exports.

### P9 — Blob layer (§12) — ✅ BUILT (2026-06-29 correction)

`packages/core/src/blob.ts` (commit `bc3b467`, `core/blob` subpath) ships this. The "MISSING" text below is the original stale audit, retained for context.

Content-addressed object storage. Promised:

- `put(bytes, contentType) → { uri, hash }` with SHA256 key (`blobs/{prefix}/{hash}`)
- Dedup via S3 `IfNoneMatch` (412 handling)
- `presign(uri, ttl=900)` read URLs
- `get(uri) → bytes` (server-side, rare)
- Inline policy: blobs <32KB → `body`, else S3
- GC off by default (lifecycle tiering instead)

**State:** no `blob.ts`, no S3 dep, no exports, no test. The `content_hash` / `uri` node columns exist (`schema.ts`) but nothing populates them durably. The userland `examples/file-upload-ingest.ts` injects a `put` port precisely because core ships none — that example is the _workaround_ for this gap, not the feature.

### P10 — Tiering / cold archive (§13) — MISSING

Hot→cold Parquet archival + federated reads. Promised:

- Watermark job (external cron) — time-slice export, not row-LIMIT
- Deterministic Parquet keys (`s3://archive/{table}/vt_year=Y/vt_month=M/part-{wm}-{sliceEnd}.parquet`)
- Verify row count → atomic delete + watermark update
- DuckDB federation (hot: `valid_to >= wm OR FOREVER`; cold: `read_parquet(...)`)
- `dropVectorsOnArchive` option
- Crash idempotency (re-export overwrites same key)

**State:** no `archive.ts`/`tiering.ts`, and `archival_state` in `schema.ts` is still **never read or written**. Consequence unchanged: vector indices grow unbounded; no data-retention path.

> **Correction, 2026-08-19.** "no DuckDB dep, no test" is stale. graphx now has a full **DuckDB
> backend** (`duck.ts` + `objstore/`, `@duckdb/node-api` as an optional peer) whose durable state
> is content-addressed Parquet in an object store behind a snapshot manifest — most of the
> machinery P10 called for (Parquet export, deterministic keys, DuckDB federation) exists and is
> tested. What P10 still means is the **hot→cold watermark job** that moves aged versions out of a
> libSQL/Postgres graph and reads them back federated. See `docs/DUCKDB_SUPPORT.md`.

### Spec sections blocked on the above

- **§19.11 backup/restore/DR** — implies P10 cold durability + WAL streaming. Not implemented.
- **§19.9 embedding-model versioning** — partial: read-time upcasting (P12) works, but re-embedding has no blob layer to lean on.

---

## 2. SDK operations with no HTTP route — ✅ RESOLVED (2026-06-29)

These were backend-only; **all are now exposed in `serve.ts`** with zod wire schemas, `requireGraph(op)`, and tests on both backends (libSQL + Postgres). See `docs/react-query-spec.md` §3 for the full route table.

| SDK op                                                            | File          | Route added                                                                                                                          |
| ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Graph.updateNode()`                                              | graph.ts      | `PATCH /nodes/:id` (write)                                                                                                           |
| `Graph.deleteEdge()`                                              | graph.ts      | `DELETE /edges/:id` (write)                                                                                                          |
| `hybridRetrieve()`                                                | hybrid.ts     | `POST /hybrid` (read; `rerank` omitted — not wire-serializable)                                                                      |
| `bulkLoad()`                                                      | bulk.ts       | `POST /bulk` (write)                                                                                                                 |
| `match()` / `PatternBuilder`                                      | pattern.ts    | `POST /match` (read; JSON-serialized step program)                                                                                   |
| `diff()`                                                          | temporal.ts   | `GET /diff?t1=&t2=` (read)                                                                                                           |
| `changeFeed()`                                                    | temporal.ts   | `GET /changes?nodes=&edges=&limit=` (read) — **the headline CDC/live-sync route**                                                    |
| `shortestPath`, `pagerank`, `community`, `centrality`, `topNodes` | algorithms.ts | `POST /algorithms/shortest-path` (read), `/pagerank` `/community` `/centrality` (write — they persist), `GET /algorithms/top` (read) |

Also added: `neighborsPage` → `GET /nodes/:id/neighborsPage` (read) — the keyset-paginated neighbors that backs the infinite-scroll `useNeighbors`, completing react-query R0. And `deleteNode` → `DELETE /nodes/:id` (write; the SDK op was added on the ingest branch after the original audit, so it wasn't in the table above) — caught in the post-build review.

**Still SDK-only (intentional):**

- `buildCSR`, `snapshotCSR`, CSR `neighbors` (internal accel; fine SDK-only).
- `declareUniqueNodeProp`, `declareSingleValuedRel`, `materializeConstraints` (schema setup; reasonably SDK-only).

**Exposed and fine:** addNode, addEdge, getNode, neighbors, neighborsPage, listNodes, graphSlice, history, retrieve, journey; all control-plane admin routes; all auth routes (check/tuples/expand/list-objects).

---

## 3. `graphx-react` — ✅ BUILT (2026-06-29)

`packages/react` (`graphx-react`) ships the full hook set over the §2 HTTP surface. 32 tests, both backends (in-process app). Built/publishable via bunup (`dts.inferTypes`).

- `createGraphHooks<S>(schema)` factory (schema-parameterized, no codegen) — single closure binding `S`.
- Query hooks: `useNode`, `useNeighbors` (infinite), `useListNodes` (infinite), `useGraphSlice`, `useHistory`, `useRetrieve`, `useHybrid`, `useJourney`, `useMatch`, `useDiff`, `useShortestPath`, `useTopNodes`.
- Mutation hooks: `useAddNode`, `useAddEdge`, `useUpdateNode`, `useDeleteEdge`, `useDeleteNode`, `useBulkLoad`, `usePagerank`, `useCommunity`, `useCentrality` — invalidate-on-settle.
- `useChangeFeedSync` — CDC-driven cache invalidation (the differentiator), incremental keyset cursor.
- `<GraphProvider>`, `graphKeys`/`useKeys` query-key factory, `GraphError`, `GraphTransport`.

**Remaining (react-query-spec §13 R3):** runtime response validation, CDC cursor persistence, the `valid_to` close-feed companion.

---

## 4. Admin frontend (`packages/admin`) — missing capabilities

> **Correction, 2026-08-19.** This whole section predates the admin authoring work and is stale in
> three places. Node and edge **mutation UI + hooks exist** (`node-editor-dialog.tsx`,
> `edge-editor-dialog.tsx`, `delete-node-dialog.tsx`, `delete-edge-dialog.tsx`, and the
> `useAddNode`/`useUpdateNode`/`useAddEdge`/`useDeleteEdge` family in `hooks/use-graph.ts`), so the
> SPA is no longer read-only for the graph realm. **Component/DOM tests exist**
> (`graph-canvas.test.tsx`, `timeline/timeline-bar.test.tsx`, `hooks/use-graph.test.ts`) — React
> Testing Library is wired up. And the explorer **does** call retrieve/hybrid (`lib/api.ts`,
> `lib/explorer-search.ts`). What remains genuinely absent: lazy canvas expansion, `journey` /
> `match` / algorithm visualizations, CDC live-sync in the SPA, and E2E coverage.

The admin SPA is **read-only for the graph realm**. Writes exist only for the control plane.

### Explicitly deferred (README.md:43-45)

- Lazy canvas expansion (double-click node → merge neighbors into canvas)
- DOM / component tests
- match / hybrid / algorithm visualizations
- CDC live-sync

### Absent graph-mutation UI + hooks

- No `useAddNode` / `useUpdateNode` / `useAddEdge` / `useDeleteEdge` (`use-graph.ts` is all reads; `use-admin.ts` is control-plane only)
- No create/edit/delete UI for nodes or edges
- (Also blocked on the missing PATCH/DELETE routes in §2)

### Absent search/retrieval UI

- Only FTS `q` + `kind` + `asOf` filters on the node list (`api.ts:128`)
- No GraphRAG `retrieve` UI, no `journey` UI, no `hybridRetrieve` / `match` (the `retrieve` route exists server-side but the admin client doesn't call it)

### Absent tests

- Only `lib/` unit tests (`api.test.ts`, `explorer-search.test.ts`, `cosmograph-adapter.test.ts`)
- Zero component / DOM tests, no React Testing Library, no vitest component config, no E2E (Playwright/Cypress)

---

## 5. Documentation gaps

- ~~**`packages/core` — no README.**~~ ✅ written 2026-06-29.
- ~~**`packages/react` — no README.**~~ ✅ written 2026-06-29 (with the package).
- ~~**`packages/auth` — no README.**~~ ✅ written 2026-08-19 (release prep).
- ~~**`packages/cli` — no README.**~~ ✅ written 2026-08-19 (release prep) — this one was never listed here.
- ~~**Root `README.md` is a 25-line stub**~~ ✅ full README since; the DuckDB backend and the npm install path were added 2026-08-19.
- ~~**`docs/react-query-spec.md` §3/§4 tables are stale**~~ ✅ refreshed 2026-06-29 (all live routes listed; R0 marked done).

---

## Priority shortlist

1. ~~**`/changes` + PATCH/DELETE + the rest of §2**~~ — ✅ DONE (2026-06-29): changeFeed/diff/hybrid/bulk/match/algorithms **and** neighborsPage. Full react-query R0 HTTP surface is live.
2. ~~**`packages/core` README**~~ — ✅ DONE (2026-06-29). ~~`packages/auth` README + root README~~ ✅ DONE (2026-08-19); every published package now has one.
3. ~~**P9 blob layer**~~ — ✅ already built (`blob.ts`, `bc3b467`).
4. ~~**Expose `hybridRetrieve` + `retrieve` UI in admin**~~ — ✅ DONE; the explorer calls both (`lib/explorer-search.ts`). `journey` / `match` / algorithm visualizations are what is left.
5. ~~**`graphx-react` package**~~ — ✅ DONE (2026-06-29). Only §13 R3 polish remains (response validation, cursor persistence, close-feed).
6. **P10 tiering** — the DuckDB/Parquet substrate now exists (2026-08-19 correction above); what remains is the hot→cold watermark job. Only when graph size demands it.
