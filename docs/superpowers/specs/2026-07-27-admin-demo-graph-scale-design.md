# Admin demo graph at scale — design

**Date:** 2026-07-27
**Status:** implemented. Three decisions changed during the build; each is marked **As built**
below.

## Problem

The admin dev server (`scripts/admin-api.ts`) seeds five nodes and five edges by hand. That is
too small to exercise the explorer UI: the canvas never truncates, filters never matter, search
returns everything, the as-of picker and history tab have nothing to show, and the tenant and
project switchers have one option each.

Goal: a generated demo graph large and varied enough to exercise the whole admin surface, built
in seconds on a normal dev start.

## Target

| Project           | Nodes  | Purpose                                                      |
| ----------------- | ------ | ------------------------------------------------------------ |
| Acme / Platform   | 25,000 | The big one. Exceeds the 10k slice cap, so `truncated` fires |
| Acme / Archive    | 2,000  | Fits under the cap, renders whole                            |
| Globex / Research | 200    | Small, readable, good for walking the detail pane            |
| Globex / Scratch  | 40     | Trivially small                                              |
| Initech / Empty   | 0      | Empty states                                                 |

Roughly 80,000 edges across all five, concentrated in Platform. Actual: 70,767 edges and 30,688
node version rows over 27,240 identities, built in 6.5s.

Three tenants, five projects. `SEED_NODES` overrides the Platform size, `SEED_SEED` overrides the
PRNG seed, `SEED_EMBED` the embedding cap, and `SEED_FRESH=1` forces a rebuild.

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
instead. For each supplied id:

- no two intervals overlapping,
- at most one open interval (`validTo` absent or `FOREVER`),
- `validFrom < validTo` on every row.

Any violation throws before a single index is dropped or a row written.

**As built:** the rule is _at most_ one open version, not exactly one. A fully closed timeline
means the entity existed and ended — which is precisely how the temporal pass closes an edge, so
requiring an open version would have made the common case illegal.

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

**As built:** `applyPlan` embeds a capped sample rather than every live node (`maxEmbedded`,
default 5000). Building libSQL's vector index turned out to dominate the seed by two orders of
magnitude, and to grow superlinearly in the number of vectors — at 256 dims, 2k vectors cost ~6s,
5k ~16s, 10k ~36s and 25k ~108s, against about a second for everything else combined. Capping the
sample took a full build from 133s to 24s. The cost is that `/retrieve` and `/hybrid` see a sample
of the graph above the cap; the sample is an even stride over the type-interleaved load order, so
it stays representative.

The generator also gives every node a creation time spread across the temporal window, not just
the versioned 5%, so scrubbing the as-of picker shows the graph growing (167 nodes at 80 days
back, 4,879 at 40, the full slice at 10) rather than appearing all at once.

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

The dev embedder drops from `hashEmbed()` (768 dims) to a narrower width, and the script `init`s
each namespace at that width before `graphForProject`'s lazy init would bake the 768 default.

**As built:** 128 dims, not 256. Width drives both the vector index build and its disk footprint,
because the index stores neighbor lists of full vectors: at 5,000 vectors, 256 dims costs ~16s and
~315MB against ~4s and ~111MB at 128. The generated corpus has a vocabulary of a few hundred
words, so 128 hash buckets still separate it. Combined with the embedding cap, a full build runs
in 6.5s and the whole estate occupies ~180MB.

The startup log reports per-project node and edge counts and whether the build was cached.

## Part 4 — the cache

A sidecar `.seed-cache.json` at the repo root records a fingerprint plus the namespace list. The
fingerprint hashes the schema version constant, the PRNG seed, the embedding width, the embedding
cap, and the per-project sizes.

**As built:** the embedding width belongs in the key and was nearly left out. The `emb` column's
width is baked at first init and immutable, so reusing a database built at another width does not
degrade — it throws on start. Changing the width surfaced this immediately.

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
