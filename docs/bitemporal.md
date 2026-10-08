# Bitemporal graphx — spec

graphx says "every write is bitemporal". It isn't. Every version carries one interval
(`valid_from`, `valid_to`), whose meaning depends on how the row was written, and the import path
that sets it can corrupt a node. This spec covers the core only (`packages/graphx`): what is wrong,
the target model, and the order to fix it in. Examples are out of scope.

## 1. Findings (verified 2026-10-08)

| #   | Finding                                                                                                                                                                   | Severity | Evidence                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | One time axis. No column records when a row was written.                                                                                                                  | design   | `schema.ts:40,63` (libSQL/SQLite), `dialect-sql.ts:175,194` (Postgres, DuckDB): only `valid_from`/`valid_to`. `graph_outbox.ts` exists only for live writes with the outbox on.                                                                |
| F2  | `valid_from` means two things. Live writes stamp the write clock (transaction time); `bulkLoad` with `validFrom` stamps a world date (valid time). Nothing records which. | design   | `Graph.now()` (`graph.ts:1310`) for `addNode`/`updateNode`/`addEdge`; `BulkRow.validFrom` (`bulk.ts:58`).                                                                                                                                      |
| F3  | `bulkLoad`/`bulkEdges` with explicit ids create overlapping **open** versions when the id already exists. Reads return the stale row; a later `updateNode` is hidden.     | **bug**  | Overlap check is per batch only (`bulk.ts:135` `validateIntervals`). No index enforces one open row per id. Repro: load `H1 {yield: .9}` from 1992, load `H1 {yield: .88}` from 1992, `getNode` → `.9`; `updateNode(.95)` → `getNode` → `.88`. |
| F4  | `changeFeed` misses rows whose `valid_from` is older than the consumer's cursor (any backdated `bulkLoad`). `useChangeFeedSync` inherits it.                              | **bug**  | Keyset is `(valid_from, ver)` (`temporal.ts` changeFeed). Repro: poll → cursor at a live write; `bulkLoad` a row with `validFrom` 1992; poll again → only later live writes, never the 1992 row.                                               |
| F5  | No way to state a fact about the past or correct one through the write API or HTTP.                                                                                       | gap      | `AddNodeInput`, `UpdateNodePatch`, `AddEdgeInput` have no time field. `POST /bulk` rows have no `id`/`validFrom` (`serve.ts:460`).                                                                                                             |
| F6  | `upcastAll` records a representation change as a world change: it opens a new version at _now_.                                                                           | design   | `upcastAll` → `updateNode` (README "Evolving data").                                                                                                                                                                                           |
| F7  | Docs overstate. README §"Every write is bitemporal", line 5, line 392; repo's own note defines bitemporal as two axes.                                                    | docs     | `README.md`, `examples/vault-ingest/vault/note/bitemporal.md`.                                                                                                                                                                                 |

Already fixed this session: a `Graph.fork` branch now starts its write clock after the fork point
(`graph.ts` `latestInstant`, test in `fork.test.ts`).

## 2. Target model

Two independent axes on every version row:

- **valid time** `[valid_from, valid_to)`: when the fact holds in the world. Caller may set it.
- **recorded time** `[recorded_from, recorded_to)`: when the database held this belief. **Always
  system-assigned** from the monotonic write clock; never settable by a caller, an import, or HTTP.

A row with `recorded_to = FOREVER` is a **current belief**. Rules:

1. **Append-only on recorded time.** No write ever changes `data`, `valid_from` or `valid_to` of
   an existing row. The only in-place change is closing `recorded_to` (that _is_ transaction time).
2. **Per id, current beliefs never overlap in valid time.**
3. **Live** = current belief whose valid interval contains now. Because of decision D3 below, that is
   exactly `valid_to = FOREVER AND recorded_to = FOREVER`, so the `nodes`/`edges` views stay cheap.
4. **Purge** stays the one hard delete (`purgeNode`, erasure requests). Documented as the exception.

### Decisions

- **D1 — `asOf` always means valid time.** Recorded time is always spelled `recordedAsOf`. A read
  takes `{ asOf?: number; recordedAsOf?: number }`; omitted means "now" on each axis. For data
  written only by live writes the two axes are equal, so every existing `asOf` call keeps its answer.
- **D2 — one write primitive with SQL:2011 "FOR PORTION OF" semantics.** `assert(id, patch,
{ validFrom, validTo })` replaces the entity's content over `[validFrom, validTo)`: every
  overlapping current belief gets `recorded_to = now`, its non-overlapping remainders are
  re-inserted as new current beliefs, then the new row is inserted. All existing writes become
  special cases:
  - `addNode` / `addEdge`: assert over `[validFrom ?? now, FOREVER)` on a new id.
  - `updateNode`: assert over `[validFrom ?? now, FOREVER)`.
  - `deleteNode` / `deleteEdge`: retract over `[validFrom ?? now, FOREVER)` (remainders only, no new row).
  - `correctNode` / `correctEdge` (new): assert over any explicit `[validFrom, validTo)`.
  - `retractNode` / `retractEdge` over an interval (new): remove a fact for a past period.
- **D3 — no future dating.** `validFrom ≤ now` is enforced. Future-dated facts would make "live"
  depend on the clock and break the cheap views and constraint indexes. Scheduled changes are a
  non-goal; use a trigger.
- **D4 — cost.** A current-time update is now 1 recorded-close + 2 inserts (trimmed predecessor +
  successor) instead of 1 close + 1 insert, about 2× version rows for update-heavy graphs. Accepted:
  it is what makes "what did we believe then" answerable and CDC append-only (D7). No optimisation
  in v1 of this work.
- **D5 — imports record at load time.** `bulkLoad`/`bulkEdges` take `validFrom`/`validTo` per row
  (rename the batch default `loadTs` → `validFrom`); `recorded_from` is the load instant. A row that
  overlaps a current belief is **refused** by default; `mode: 'correct'` applies D2 instead. History
  brought in from elsewhere is recorded when graphx learned it, which is the truth.
- **D6 — authz evaluates current belief.** `auth/check.ts` and `auth/list.ts` always read
  `recordedAsOf = now`; corrections to past permissions never grant access retroactively at read
  time. Valid-time `asOf` on authz reads keeps today's meaning.
- **D7 — CDC follows recorded time.** `changeFeed` keyset becomes `(recorded_from, ver)`. Because
  of rule 1, every change inserts rows, so the feed is append-only and backdated writes appear.
- **D8 — fork has two cuts.** `fork({ asOf })` keeps today's meaning (the world at a valid instant:
  copy current beliefs, drop `valid_from > t`, reopen `valid_to > t`). `fork({ recordedAsOf })` is
  new: the database as it was recorded at `t` (drop `recorded_from > t`, reopen `recorded_to > t`).
  Both may be given. The branch's write clock starts past every instant it holds (already done).
- **D9 — `upcastAll` is a correction.** It re-asserts each lagging current belief over its own valid
  interval, so the fact's dates are untouched and only `recorded_*` moves.
- **D10 — `diff` and `timeline` take an axis.** `{ axis: 'valid' | 'recorded' }`, default `'valid'`
  (a world-history scrubber, which is what the admin UI and imports want). `history(id)` returns
  every row, current and superseded, ordered by `(valid_from, recorded_from)`, each flagged
  `current: boolean`.
- **D11 — HTTP backdating is opt-in.** Write routes accept `validFrom`/`validTo` only when
  `ServeConfig.allowValidTime` is true (default false); `recordedAsOf` on reads is always allowed.
  Backdating is powerful and should be a deliberate operator choice.

No backward-compatibility shims: renamed options are renamed, not aliased.

## 3. Schema (layout v2)

Both version tables, every dialect (`schema.ts`, `dialect-sql.ts` Postgres + DuckDB; bql.sh uses
the SQLite dialect):

```sql
ALTER TABLE node_versions ADD COLUMN recorded_from BIGINT NOT NULL DEFAULT 0;
ALTER TABLE node_versions ADD COLUMN recorded_to   BIGINT NOT NULL DEFAULT 8640000000000000;
-- same two on edge_versions

-- one live row per id: the invariant F3 broke, now enforced by the database
CREATE UNIQUE INDEX nv_one_live ON node_versions(id) WHERE valid_to = FOREVER AND recorded_to = FOREVER;
CREATE UNIQUE INDEX ev_one_live ON edge_versions(id) WHERE valid_to = FOREVER AND recorded_to = FOREVER;

CREATE INDEX nv_bitemporal ON node_versions(id, valid_from, valid_to, recorded_from, recorded_to);
CREATE INDEX ev_src_bitemporal ON edge_versions(src, valid_from, valid_to, recorded_from, recorded_to);
CREATE INDEX ev_dst_bitemporal ON edge_versions(dst, valid_from, valid_to, recorded_from, recorded_to);
CREATE INDEX nv_recorded ON node_versions(recorded_from, ver);  -- changeFeed
CREATE INDEX ev_recorded ON edge_versions(recorded_from, ver);
```

- Views: `nodes`/`edges` add `AND recorded_to = FOREVER`.
- Constraint indexes (`constraints.ts`, `duck-constraints.ts`): unique-prop and single-valued-rel
  predicates add `AND recorded_to = FOREVER`.
- `node_embeddings`: unchanged (vectors belong to the live row; a correction that changes the live
  row's embedding input re-embeds through the existing hash check).
- SQLite FTS: external content over `ver` keeps working (inserts only). FTS queries join the live
  predicate.
- Postgres (optional hardening): an exclusion constraint with `btree_gist` enforcing rule 2 for
  current beliefs. Not required; the write path enforces it.

### Migration — `STRUCTURE_STEPS[0]` (v1 → v2)

`schema.ts` already has the runner (`upgradeSchema`, `SCHEMA_VERSION`); this is its first step.

1. Add the columns. Backfill `recorded_from = valid_from`, `recorded_to = FOREVER`. For v1 data
   valid time _was_ the write clock, except bulk-loaded rows, whose true load time is unknown; the
   backfill records them at their valid time and the release notes say so.
2. Detect F3 damage before creating `nv_one_live`/`ev_one_live`: ids with more than one open row.
   If any, the step **fails** and lists them. `graphx doctor --repair-overlaps` closes
   `recorded_to = now` on all but the highest `ver` per id, which keeps what `updateNode` last wrote.
3. Create the indexes, recreate the views and constraint indexes, stamp v2.

## 4. Code changes, by module

| Module                                       | Change                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/temporal.ts`                           | `asOfPredicate(alias)` → `bitemporalPredicate(alias)` binding `(v, v, r, r)`. `history`, `diff({axis})`, `changeFeed` keyset `(recorded_from, ver)`.                                                                                                                                               |
| `core/graph.ts`                              | `assert`/`retract` primitive (D2), used by add/update/delete; `correctNode`/`correctEdge`/`retractNode`/`retractEdge`; `validFrom` on write inputs; `recordedAsOf` on every read; `atomic` scope gets the same; `upcastAll` per D9; `fork` options per D8. Monotonic clock stamps `recorded_from`. |
| `core/bulk.ts`                               | Validate against existing current beliefs (F3); `mode: 'refuse' \| 'correct'`; `loadTs` → `validFrom`; stamp `recorded_from`.                                                                                                                                                                      |
| `core/fork.ts`                               | Valid cut and recorded cut (`fork.ts:596-599` today trims valid time only).                                                                                                                                                                                                                        |
| `core/pattern.ts`                            | `.asOf(t)` plus `.recordedAsOf(t)`.                                                                                                                                                                                                                                                                |
| `core/algorithms.ts`                         | `csrAt` / `snapshotCSR` take both instants; every algorithm option gains `recordedAsOf`.                                                                                                                                                                                                           |
| `core/journey.ts`                            | Time-respecting walk stays on valid time; filter to beliefs as of `recordedAsOf`.                                                                                                                                                                                                                  |
| `core/retrieve.ts`, `hybrid.ts`              | Pass `recordedAsOf` through the seed filter and walk.                                                                                                                                                                                                                                              |
| `core/timeline.ts`                           | `{ axis }` (D10).                                                                                                                                                                                                                                                                                  |
| `core/constraints.ts`, `duck-constraints.ts` | Predicates per §3.                                                                                                                                                                                                                                                                                 |
| `core/schema.ts`, `dialect-sql.ts`           | DDL, views, migration step.                                                                                                                                                                                                                                                                        |
| `core/duck*.ts`                              | Materialize/commit paths carry the two columns.                                                                                                                                                                                                                                                    |
| `core/events.ts`, outbox                     | Event payload gains `validFrom`, `validTo`, `recordedAt`.                                                                                                                                                                                                                                          |
| `auth/store.ts`, `check.ts`, `list.ts`       | Relation writes through D2; reads per D6.                                                                                                                                                                                                                                                          |
| `core/serve.ts` + OpenAPI                    | `recordedAsOf` query param on every read route; `validFrom`/`validTo` on write bodies behind `allowValidTime` (D11); `POST /bulk` rows gain `id`, `validFrom`, `validTo`, `mode`. New `POST /nodes/:id/correct`, `/edges/:id/correct`.                                                             |
| `react/create-hooks.ts`                      | `recordedAsOf` in hook options and query keys; `useCorrectNode`/`useCorrectEdge`.                                                                                                                                                                                                                  |
| MCP (`graphx mcp`)                           | Follows the HTTP routes automatically; verify tool schemas regenerate.                                                                                                                                                                                                                             |
| CLI                                          | `graphx fork --recorded-as-of`; `graphx doctor` reports F3 overlaps and v1-backfilled bulk rows; `--repair-overlaps`.                                                                                                                                                                              |
| `packages/admin`                             | History tab shows superseded beliefs (struck through, with recorded time); as-of scrubber gains a recorded slider.                                                                                                                                                                                 |

## 5. Phases

Each phase lands green on its own (`bun run test`, type-check, lint), on all three dialects.

| Phase | Scope                                                                                                                                                                                                                                                                                                                       | Size      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0     | **Bug fixes on v1, no schema change.** F3: `bulkLoad`/`bulkEdges` query existing open rows for supplied ids and refuse overlaps. F4: `changeFeed` keyset → `ver` only (insertion order; switch SQLite tables to `AUTOINCREMENT` so a purge can't reuse a `ver`). F7: README wording → "versioned history with as-of reads". | ½ day     |
| 1     | Schema v2 + migration + views + constraint predicates + `doctor`. Reads unchanged in meaning.                                                                                                                                                                                                                               | 1 day     |
| 2     | Write path: D2 primitive, `validFrom`, correct/retract, D3 guard, bulk D5, upcast D9, atomic.                                                                                                                                                                                                                               | 1–1½ days |
| 3     | Read path: `recordedAsOf` through temporal, pattern, algorithms, journey, retrieve, timeline, diff, history; CDC D7.                                                                                                                                                                                                        | 1 day     |
| 4     | Fork D8, authz D6, HTTP/OpenAPI D11, React hooks, CLI, MCP check, admin History tab.                                                                                                                                                                                                                                        | 1–1½ days |
| 5     | Docs: README "Time travel" rewritten around two axes with one worked correction example; restore the word "bitemporal" only now.                                                                                                                                                                                            | ½ day     |

Total ≈ 5–6 days. Phase 0 is independent and should ship first.

**Phase 0 status (2026-10-08, done, uncommitted).** F3: `bulk.ts` `refuseStoredOverlaps` checks
every stored version (open or closed) of each supplied id before writing. F4: `changeFeed` cursor
is the 1-tuple `[ver]`; `useChangeFeedSync` re-derives it the same way. SQLite version tables use
`AUTOINCREMENT` for **new** namespaces only — an existing SQLite namespace keeps its rowid tables
until phase 1, so `STRUCTURE_STEPS[0]` must also rebuild `node_versions`/`edge_versions` with
`AUTOINCREMENT` on SQLite/libSQL (keep `ver` values; FTS content_rowid depends on them). Postgres
IDENTITY never reuses. DuckDB had a real bug: `materialize` left `seq_ver`/`seq_outbox` at 1 in a
fresh process, so the first write after reopening a durable namespace failed on a duplicate `ver`;
it now restarts both sequences past the manifest's `verHigh`/`seqHigh`, and commit never lowers
those marks (a purge of the newest rows cannot cause reuse).

## 6. Tests (critical paths only)

Phase 0

- `bulkLoad` with a supplied id that has an open row → throws, nothing written; same for `bulkEdges`.
- `changeFeed`: poll to a cursor, `bulkLoad` a backdated row, poll → the row is emitted.

Phases 1–4

- Migration: a v1 namespace upgrades; rows keep their `asOf` answers; a namespace with F3 damage
  fails with the offending ids, and `--repair-overlaps` fixes it.
- Correction: assert 0.90 for [1992, ∞), correct to 0.88 for [1992, ∞) →
  `getNode(asOf 1995)` = 0.88; `getNode({ asOf: 1995, recordedAsOf: beforeFix })` = 0.90.
- Split: a correction over the middle of an interval leaves two remainders + the new row; current
  beliefs never overlap (property test over random assert/retract sequences, all dialects).
- Equivalence: for a graph written only by live writes, every read with `asOf: t` returns the same
  as `{ asOf: t, recordedAsOf: t }`.
- D3: `validFrom > now` throws.
- `nv_one_live` rejects a second open row written by raw SQL (the database, not just code, holds the invariant).
- Constraints: unique-prop and single-valued rel still hold after corrections.
- Fork: valid cut and recorded cut on the correction scenario give different, correct branches.
- CDC: corrections and retractions appear in order; `useChangeFeedSync` invalidates the right keys.
- Authz: correcting a past grant does not change a current check.
- HTTP: `validFrom` rejected unless `allowValidTime`; `recordedAsOf` accepted on reads.
- `upcastAll`: valid intervals unchanged, `recorded_from` advanced, `history` shows both.

## 7. Open questions

- **Postgres CDC under concurrent writers.** `ver` comes from a sequence allocated before commit, so
  commit order can differ from `ver` order and a poller can skip a row. Today's keyset has the same
  hole. Confirm whether graphx serialises Postgres writers (writer lease); if not, CDC needs a
  commit-ordered source (outbox `seq` written under a lock, or logical decoding).
- **Clock skew across instances.** `recorded_from` comes from each process's clock. Two writers with
  skewed clocks can record out of order. Option: take `recorded_from` from the database
  (`now()` / `unixepoch('subsec')`) inside the write transaction.
- **Storage growth (D4).** Measure with `bun run bench` after phase 2; if it hurts, consider
  dropping the trimmed-predecessor copy for current-time writes, provided reads clamp the valid
  instant to the recorded instant for those rows.
- **Retention.** Superseded beliefs grow forever. `archival_state` exists but is unused; an
  archival policy for superseded rows is future work.
