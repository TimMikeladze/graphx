# Admin demo graph at scale — design

**Date:** 2026-07-27
**Status:** approved, ready for implementation planning

## Problem

The admin dev server (`scripts/admin-api.ts`) seeds five nodes and five edges by hand. That is
too small to exercise the explorer UI: the canvas never truncates, filters never matter, search
returns everything, the as-of picker and history tab have nothing to show, and the tenant and
project switchers have one option each.

Goal: a generated demo graph large and varied enough to exercise the whole admin surface, built
in seconds on a normal dev start.

## Target

| Project           | Nodes  | Purpose                                                   |
| ----------------- | ------ | --------------------------------------------------------- |
| Acme / Platform   | 25,000 | The big one. Exceeds the 10k slice cap, so `truncated` fires |
| Acme / Archive    | 2,000  | Fits under the cap, renders whole                          |
| Globex / Research | 200    | Small, readable, good for walking the detail pane          |
| Globex / Scratch  | 40     | Trivially small                                            |
| Initech / Empty   | 0      | Empty states                                              |

Roughly 80,000 edges across all five, concentrated in Platform.

Three tenants, five projects. `SEED_NODES` overrides the Platform size, `SEED_SEED` overrides the
PRNG seed, `SEED_FRESH=1` forces a rebuild.

## Part 1 — core bulk primitives

`bulkLoad` (`packages/core/src/bulk.ts`) loads nodes only. Edges have no bulk path, and
`Graph.addEdge` (`packages/core/src/graph.ts:379`) costs two endpoint SELECTs plus a write batch
per edge — about 240,000 round trips for 80,000 edges. The seed needs a bulk edge path.

### `bulkEdges(raw, schema, rows, opts)`

A sibling of `bulkLoad`, same admin-path contract: fresh ULIDs, single open version, no
cardinality close, no outbox events, not safe to interleave with live writes.

- Chunked multi-row INSERT into `edge_identity` and `edge_versions`, issued as one `raw.batch`.
  Identity rows precede version rows in each chunk so the immediate FK check passes.
- Validates `rel` against the schema and `data` against `def.data`, up front, before any write.
- Endpoint type checks run in memory against an optional `types: Map<string, string>` supplied by
  the caller, who already knows every node's type from the node load. Omit it and endpoint types
  go unchecked, exactly as `bulkLoad` skips them today.
- Throws on a `def.single` rel. The bulk path cannot close a predecessor edge, so single-valued
  cardinality would silently break; refuse instead.

No index deferral. `edge_versions` carries only the two btree indexes, which cost little on
insert, and neither the ANN index nor the FTS trigger touches edges.

### Historical rows on both loaders

`BulkRow` and the new `BulkEdgeRow` gain three optional fields: `id`, `validFrom`, `validTo`.
Supplying `id` reuses an existing identity row rather than minting one, so a single id can carry
several version rows and read back as a real timeline.

This loosens the current "distinct ids never overlap" guarantee, so the loaders validate it
instead. For each supplied id, grouped in input order:

- intervals sorted ascending by `validFrom`,
- no two intervals overlapping,
- exactly one open interval (`validTo` absent or `FOREVER`),
- `validFrom < validTo` on every row.

Any violation throws before a single index is dropped or a row written.

Rejected alternative: have the seed script write `node_versions` and `edge_versions` SQL directly.
It duplicates schema knowledge outside core and rots the moment the DDL changes.

### Tests

Extend `packages/core/test/p13-bulk.test.ts`, which runs under both drivers via
`GRAPHX_TEST_DRIVER`:

- `bulkEdges` inserts the expected count, and the edges read back through the `edges` view.
- Edge endpoints resolve; `neighbors` traverses them.
- Unknown `rel` throws; bad `data` throws; a `single` rel throws.
- Endpoint type violation throws when `types` is supplied.
- Historical rows: one id with three versions reads back as three versions; `asOf` in the middle
  interval returns the middle version; the open version is live.
- Interval validation: overlapping intervals throw, two open versions throw, inverted interval
  throws.

## Part 2 — the generator (`scripts/seed/`)

Dev tooling. Not published, not part of any package's public surface.

### `scripts/seed/schema.ts`

Eight node types — `person`, `team`, `org`, `project`, `document`, `ticket`, `repo`, `tag` — and
ten rels: `knows`, `member_of`, `works_at`, `owns`, `authored`, `mentions`, `blocks`,
`assigned_to`, `tagged`, `depends_on`. Enough type variety that the legend, the type filter, and
the per-type colors all have something to distinguish.

No `single` rels, since `bulkEdges` refuses them.

### `scripts/seed/generate.ts`

Pure and deterministic. A seeded mulberry32 PRNG, never `Math.random`. Takes a config
(`{ nodes, seed }`) and returns a plan — arrays of node and edge rows — touching no database.

- **Degree distribution:** preferential attachment, so a few hub nodes carry many edges and most
  nodes carry few. A uniform random graph looks like noise on the canvas; a power-law one shows
  structure.
- **Clusters:** nodes are assigned to communities, and edges land within a community far more
  often than across one, so the force layout resolves into visible groups.
- **Bodies:** assembled from a phrase bank keyed by node type, so full-text search returns
  meaningful subsets and `hashEmbed`, which is lexical, produces neighbors that actually relate.

Same seed always yields the same graph, so the generator is unit-testable without a database.

### `scripts/seed/temporal.ts`

Turns a slice of the plan into history. About 5% of nodes get two to five versions; about 2% of
edges get closed. `validFrom` values spread across a synthetic 90-day window ending at load time,
so the as-of picker has a meaningful range and the history tab has rows.

This runs through the Part 1 historical fields rather than the live `Graph` API, because
`Graph.now()` is `Math.max(Date.now(), lastTs + 1)` (`graph.ts:300`) with no injection seam —
live writes cannot be backdated.

### `scripts/seed/apply.ts`

Takes a plan and a `Graph`, calls `bulkLoad` then `bulkEdges` in chunks, and returns counts. The
node load's returned ids feed the `types` map that the edge load validates against.

### Tests

`scripts/seed/generate.test.ts`, no database:

- Same seed yields identical plans; different seeds differ.
- Requested node count is produced; every edge endpoint refers to a node in the plan.
- Every edge's `rel` is valid for its endpoint types under the demo schema.
- Degree distribution is skewed, not uniform — the top-decile node degree clears a multiple of the
  median.
- Temporal pass: version intervals per id are contiguous, non-overlapping, and exactly one is open.

## Part 3 — wiring `scripts/admin-api.ts`

Replace the hand-written seed block with a fixture table driving the five projects above. Each
project gets its own namespace and DB file, created through `createTenant` / `createProject` /
`graphForProject` as today. The control plane stays `:memory:` and is rebuilt on every start
regardless of cache state.

The dev embedder drops from `hashEmbed()` (768 dims) to `hashEmbed(256)`. At 27,000 nodes, 768
dims costs roughly 83MB of vectors against 28MB at 256, and lexical hash embeddings lose nothing
meaningful at 256 for a demo. `createApp` derives `dim` from the embedder and the DBs are rebuilt
whenever the fingerprint changes, so the vector column cannot disagree.

The startup log reports per-project node and edge counts and whether the build was cached.

## Part 4 — the cache

A sidecar `.seed-cache.json` at the repo root records a fingerprint plus the namespace list. The
fingerprint hashes the generator version constant, the demo schema, the PRNG seed, and the
per-project sizes.

On start: if the file parses, its fingerprint matches, and every listed DB file exists, skip
generation entirely. Otherwise delete the listed DB files (and their `-wal` / `-shm` siblings),
regenerate, and rewrite the file. `SEED_FRESH=1` skips the check and always rebuilds.

The file is git-ignored, alongside the `dev_*.db` files.

## Out of scope

- Server-side canvas sampling. A 25,000-node project truncates at the existing 10,000-row cap and
  the UI already surfaces that; this work does not change `graphSlice`.
- Changes to the admin UI. If the truncation banner or the empty state turns out to be missing or
  wrong once there is real data behind it, that is separate work.
- Any change to the live `addEdge` / `addNode` write paths.
