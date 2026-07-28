# Performance benchmark harness

Date: 2026-07-27

## Purpose

Find where graphx is slow. The repo has a retrieval-*quality* harness
(`packages/core/test/eval-golden.test.ts`, `eval-metrics.ts`) but nothing that
measures time. This spec covers a performance harness whose job is to expose
bottlenecks — missing indexes, N+1 query shapes, walk blowups, superlinear
index builds — at three graph sizes.

Explicitly out of scope: CI regression gating, committed baselines, threshold
assertions, published marketing numbers. Those are later decisions and would
change the rigor required. Building them now would slow the loop this harness
exists to speed up.

## Layout

```
scripts/bench/
  corpus.ts    # seeded DB at scale N, cached, restored per case
  runner.ts    # warmup, iterate, percentile stats
  report.ts    # stdout table + JSON to bench/results/
  index.ts     # CLI entry
  suites/
    write.ts
    retrieval.ts
    traversal.ts
    temporal.ts
    ann.ts
```

Plain scripts, sibling to `scripts/seed/`, which they reuse. No new workspace
package, no new dependency.

Root `package.json` gains `"bench": "bun scripts/bench/index.ts"`.

```
bun run bench
bun run bench retrieval traversal
bun run bench --scale 1k,10k --iters 30
GRAPHX_BENCH_DRIVER=postgres bun run bench
```

Suite files export a case list. A case is:

```ts
interface BenchCase {
  name: string;
  /** Scales this case runs at. Defaults to all. */
  scales?: Scale[];
  /** Whether the case mutates the database — decides state restore. */
  mutates?: boolean;
  /** Per-scale one-time preparation, outside the timed region. */
  setup?: (ctx: BenchContext) => Promise<unknown>;
  /** The timed call. `i` is the iteration index, for input variation. */
  run: (ctx: BenchContext, i: number) => Promise<unknown>;
}
```

`BenchContext` carries the client, the demo schema, the embed function, the
corpus statistics, and a seeded PRNG. Suites own the call being measured and
nothing else; the runner owns all timing.

## Corpus

`scripts/seed/generate.ts` already produces a deterministic plan with skewed
degree (preferential attachment), communities, and a temporal spread; `apply.ts`
loads it through `bulkLoad` / `bulkEdges`. The bench harness calls both.

Scales: **1k, 10k, 100k nodes**, fixed PRNG seed. Three points are enough to
distinguish linear from log from quadratic.

Seeding is cached. The cache key is `(scale, seed, DEMO_SCHEMA_VERSION,
driver)`, following the fingerprint shape in `scripts/seed/cache.ts`. A seeded
libSQL file lands in `bench/.corpus/<fingerprint>-<scale>.db` and is reused by
every later run; changing the demo schema or the generator invalidates it.

### Embedding cap

`applyPlan`'s own measurements: building libSQL's vector index is superlinear
and dominates the seed — 2k vectors ≈ 6s, 5k ≈ 16s, 10k ≈ 36s, 25k ≈ 108s,
while generating and inserting 25k nodes plus 65k edges together take about a
second.

So embedding scales with node count would make the 100k corpus impractical and
would tie every suite's cost to the slowest component in the system.

Decision: **hold the embedded-node cap at 5000 for all three scales**
(`applyPlan`'s default). The retrieval suite therefore measures seed lookup,
fusion, and walk cost against a growing graph with a fixed-size vector index.
The vector index gets its own axis in a dedicated `ann` suite that varies
vector count (1k / 5k / 25k) at a fixed node count, so its cost is measured
directly rather than smeared across everything else.

Consequence worth stating: at 100k nodes, semantic search sees a 5k-node sample
of the graph. `applyPlan` takes that sample by an even stride over a load order
already interleaved by type and community, so it stays representative — but
retrieval *recall* numbers from this harness are not meaningful, only timings.
Recall is the quality harness's job.

## Timing method

For each case at each scale:

1. Run `setup` if present, outside the timed region.
2. Run 3 warmup iterations and discard them. They pay for the SQLite page cache
   and prepared query plans, which would otherwise land entirely in the first
   measured sample.
3. Iterate until 2s of measured time has elapsed or `--iters` is reached,
   whichever comes first, with a floor of 5 iterations. `--iters` defaults to
   100. Slow ops therefore get few samples and fast ops get many, without
   per-case tuning.
4. Record every sample.

Reported per case: **p50 and p95**, plus min, max, iteration count, and
ops/sec derived from p50. Mean is not reported — it hides GC pauses and lock
waits behind an average, and those pauses are exactly what a bottleneck hunt
wants to see.

Inputs vary per iteration. Each case draws its arguments — node ids, query
strings, time points — from the context's seeded PRNG using the iteration
index, so repeated iterations do not measure one hot row with a warm cache.
The seed is fixed, so two runs of the same case use the same input sequence.

Timing uses `performance.now()`. Every reported row carries the corpus
statistics alongside it (node count, version count, edge count, embedded
count); a latency without its corpus size is not interpretable.

## State restore

Read-only suites (retrieval, traversal, temporal, ann) share one connection to
the cached corpus for the whole run.

Write cases mutate, so each needs independent, repeatable starting state:

- **libSQL**: before each write case, copy the cached corpus file to a scratch
  path and open that. A file copy is cheap and gives an exact restore.
- **Postgres** (opt-in): re-seed the bench schema before each write case. This
  is slow, and only the opt-in path pays it.

## Backends

`GRAPHX_BENCH_DRIVER` selects the backend, mirroring the existing
`GRAPHX_TEST_DRIVER` pattern in `packages/core/test/harness.ts`.

- `libsql` (default) — **file-backed, not `:memory:`**. An in-memory database
  hides IO cost entirely and gives a write path that does not resemble
  production.
- `postgres` — same suites through the dialect seam, run against a live PG.

The harness does not run both in one invocation.

## Suites

**write** — `upsertNode`, `addEdge`, `updateNode` (the version-close path),
`deleteNode`, `bulkLoad` at chunk size 200 vs 1000, `bulkEdges` at chunk size
200 vs 1000.

**retrieval** — `retrieve` at maxDepth 1, 2, and 3; `hybridRetrieve` at
maxDepth 1 and 2; the `rrf` fusion step in isolation.

**traversal** — `neighbors`, `neighborsPage`, `graphSlice`, `shortestPath`,
`pagerank`, `community`, `centrality`, and `buildCSR` measured on its own,
since the CSR build is the suspected dominant cost of the algorithm family.

**temporal** — `retrieve` with `asOf` in the past against `asOf` live (the
half-open-predicate path against the live path), `history`, `diff`,
`changeFeed`, and one `match()` pattern with a three-hop chain.

**ann** — `retrieve` seed lookup only, at 1k / 5k / 25k embedded vectors and a
fixed 10k-node corpus. Isolates the vector index from everything else.

## Output

Stdout is a table grouped by suite, one row per case per scale: name, scale,
p50, p95, min, max, iterations, ops/sec.

The same data is written to `bench/results/<driver>-<ISO timestamp>.json`,
including the corpus statistics and the harness configuration, so two runs can
be diffed by hand. `bench/results/` and `bench/.corpus/` are gitignored.

## Testing

`runner.ts` gets unit tests for its statistics: percentile selection on known
sample sets, the iterate-until-elapsed loop's respect for the floor and cap,
and warmup exclusion.

`corpus.ts` gets unit tests for cache-key behavior: the same inputs produce the
same fingerprint, and a schema-version or scale change produces a different
one.

Both follow the style of the existing `scripts/seed/*.test.ts`. The benchmark
cases themselves are not tested — they are the measurement.
