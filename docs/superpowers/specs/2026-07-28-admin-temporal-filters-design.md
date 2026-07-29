# Admin Temporal Filters — Time-Travel Correctness + Timeline Scrub

> Status: approved design, pre-implementation. Date: 2026-07-28.
> Scope: make as-of time travel correct everywhere in the admin explorer, and give it a
> real control — a docked timeline bar with a change-density histogram, snap-to-change
> scrubbing, step, play, and presets.

## 1. Goal

The explorer already carries an `asOf` filter, but it only reaches two of the six reads it
should, and its only control is a bare `datetime-local` input in the sidebar. The result is a
feature that is both wrong and undiscoverable: set an as-of time and the node list and canvas
jump to the past while the inspector keeps showing live data, with nothing on screen saying
which time you are looking at.

This slice fixes the leak in `packages/core` and replaces the input with a timeline bar.

## 2. Non-goals (this slice)

Each is a separate spec, in rough priority order:

- **Per-node history deep-dive.** Inspecting a version's payload, field-by-field diffing two
  versions, pinning the canvas to a version. The History tab keeps its current flat trail.
- **Project-wide diff / activity view.** `GET /diff` and `GET /changes` stay unused by the UI.
- **Live updates.** `GET /events` (SSE) stays unused.
- **Restore-this-version.** A write feature; it does not ride along in a filter slice.
- **A second time axis.** graphx versions carry one valid-time interval (`valid_from`,
  `valid_to`) plus `ver` as write order. No transaction-time axis is introduced or implied.

## 3. Decisions (resolved during brainstorming)

| Fork | Decision |
|---|---|
| Fix the `asOf` leak where? | **In `packages/core`.** Neighbors at an as-of time cannot be derived client-side — the graph slice is type/`q`-filtered and row-capped, so a derived neighbor list would be silently wrong. |
| Control placement | **Docked timeline bar** under the canvas. Always visible; a popover hides the one thing the user said was missing. |
| Timeline data | **One new `GET /timeline`** returning range + buckets + ticks, windowable by `from`/`to`. |
| Editing while in the past | **Read-only mode.** A write from a historical view lands on the live version — a silent footgun. |
| v1 bar controls | Scrub + snap, density histogram, prev/next step, play. All four. |

## 4. Change points

A change point is any instant at which the graph's live set changed:

```
node_versions.valid_from
node_versions.valid_to   where valid_to < FOREVER
edge_versions.valid_from
edge_versions.valid_to   where valid_to < FOREVER
```

The `valid_to` half matters. A retraction and an edge supersession move a `valid_to` without
writing a new `valid_from` row, so a `valid_from`-only timeline would hide every delete —
the same asymmetry `changeFeed` documents as decision A.3, which is why `/changes` cannot back
this feature.

## 5. Core: `asOf` plumbing

`packages/core/src/graph.ts` — four read methods gain `asOf?: number`:

| Method | Today | Change |
|---|---|---|
| `getNode` | `FROM nodes WHERE id = ?` | as-of ⇒ `FROM node_versions nv WHERE nv.id = ? AND nv.valid_from <= ? AND ? < nv.valid_to` |
| `getNodeContent` | same view, content columns | same substitution |
| `neighbors` | `neighborSubquery` over the `edges` view | as-of ⇒ `edge_versions` with the temporal predicate; the `nodes` join likewise |
| `neighborsPage` | shares `neighborSubquery` | inherits the same change |

`neighborSubquery` is the single place the edge side is built, and both neighbor methods
already route through it — so the edge half is one edit, and the node-join half is one more.

Conventions to follow, already established in this codebase:

- `asOf === undefined` keeps the live path (the `nodes`/`edges` views). Never bind `FOREVER`
  into a predicate for a live read; `nodeFilter` (`graph.ts:765`) is the reference.
- `asOf >= FOREVER` means "now" and routes to the live path, matching `algorithms.ts:187`.
- The predicate is half-open: `valid_from <= t AND t < valid_to`. `asOfPredicate` in
  `temporal.ts` already spells it; reuse it rather than re-typing the SQL.
- The `nv_asof` and `ev_src_asof`/`ev_dst_asof` indexes already cover these lookups.

`packages/core/src/serve.ts` — `neighborQuerySchema` gains `asOf: numQuery.optional()`
(`neighborPageQuerySchema` extends it, so it inherits). `GET /nodes/{id}` and
`GET /nodes/{id}/content` currently declare no query schema; each gains
`z.object({ asOf: numQuery.optional() })`. Handlers pass it straight through.

## 6. Core: `GET /timeline`

New module `packages/core/src/timeline.ts`, exported through `index.ts`, routed in `serve.ts`
as `GET /t/{tenant}/p/{project}/timeline` (tag `read`, `requireGraph(cfg, 'read')`, same
`READ_ERRORS` set as its neighbours).

**Query:** `from?`, `to?` (epoch ms, the window to bucket; default the full extent),
`buckets?` (default 240, clamped to 1000).

**Response:**

```ts
interface Timeline {
  /** Full extent of the graph's change points, ignoring from/to. null on an empty graph. */
  min: number | null
  max: number | null
  /** Change-point count over the full extent. */
  total: number
  /** The window actually bucketed (echoes from/to, resolved against the extent). */
  from: number
  to: number
  /** Length === buckets. Change-point counts per equal-width slot over [from, to]. */
  buckets: number[]
  /** Distinct change timestamps in [from, to], ascending. Drives snap and step. */
  ticks: number[]
  /** True when ticks hit the cap — snap/step fall back to bucket edges outside the window. */
  ticksTruncated: boolean
}
```

`ticks` is capped at `resolveLimits(opts.limits).maxRows`. When it truncates, the bar
re-requests with a narrower `from`/`to`, and ticks become exact for the visible window. That
is the whole zoom story, and it costs one parameter rather than a second endpoint.

**SQL.** One CTE feeds all three queries:

```sql
WITH ts AS (
  SELECT valid_from AS t FROM node_versions
  UNION ALL SELECT valid_to FROM node_versions WHERE valid_to < ${FOREVER_LIT}
  UNION ALL SELECT valid_from FROM edge_versions
  UNION ALL SELECT valid_to FROM edge_versions WHERE valid_to < ${FOREVER_LIT}
)
```

`FOREVER_LIT` is the same interpolated sentinel `dialect-sql.ts` already uses for the `nodes`
and `edges` views.

1. Extent: `SELECT MIN(t), MAX(t), COUNT(*) FROM ts` — unwindowed, so the bar always knows
   the full range it is scrubbing within.
2. Buckets: `SELECT CAST((t - ?) * ? / ? AS BIGINT) AS b, COUNT(*) FROM ts WHERE t >= ? AND t <= ? GROUP BY b ORDER BY b`, binding in order: `from`, `buckets`, `span`, `from`, `to`.
3. Ticks: `SELECT DISTINCT t FROM ts WHERE t >= ? AND t <= ? ORDER BY t LIMIT ?` (cap + 1, to
   detect truncation without a second query — the `feedStream` over-fetch trick).

Three dialect hazards, each resolved:

- **`CAST(... AS INTEGER)` overflows on Postgres.** `(t - min) * buckets` reaches ~1e14 at
  epoch-ms scale, far past int4's 2.1e9. `BIGINT` is correct on Postgres and carries INTEGER
  affinity on SQLite, so it is the one spelling that works on both.
- **`span === 0`** (every change at one instant — a single bulk load) divides by zero. Guard
  before querying: return `buckets = [total]`, `ticks = [min]`.
- **Empty graph:** `min`/`max` are `null`, `buckets` is zero-filled, `ticks` is `[]`, and
  `from`/`to` echo the requested values, or `0` when they were not supplied. The bar renders a
  disabled track in that state.

A `t === to` row bins to index `buckets`, one past the end. Clamp in JS while inflating the
sparse group-by rows into the dense array — cheaper and less dialect-dependent than a SQL
`CASE`.

If a difference does bite, the fix belongs in `dialect-sql.ts`, not in branching inside
`timeline.ts`.

## 7. Client: filters and query keys

`ExplorerFilters.asOf` already exists and already round-trips through the URL
(`explorer-search.ts`), so no new URL state.

`lib/api.ts` — `getNode`, `getNodeContent`, `neighbors` take an `asOf` argument and append it
via the existing `qs` helper. New `timeline(tenant, project, opts)`.

`lib/query-keys.ts` — `node`, `nodeContent` and `neighbors` append `asOf ?? null`
**at the end** of the key. `history` is deliberately excluded: the version trail is the whole
trail regardless of the time being viewed, so keying it by `asOf` would refetch identical rows
on every scrub. Appending, not inserting, is what keeps the existing invalidations
working: `useUpdateNode` invalidates `["node", tenant, project, id]`, and TanStack matches
partial prefixes, so a longer key still matches. New `timeline(tenant, project, window)`.

`hooks/use-graph.ts` — `useNode`, `useNodeContent`, `useNeighbors` take `asOf` and thread it
into both the key and the request. New `useTimeline`. Callers in `explorer-page.tsx`,
`node-detail.tsx` and `node-detail-sheet.tsx` pass `filters.asOf`.

## 8. Client: the timeline bar

New `components/timeline/`:

- `timeline-bar.tsx` — the docked frame: play/step controls, the track, the current-time
  readout, and the `1h · 1d · 7d · Now` presets.
- `timeline-track.tsx` — SVG. Histogram bars from `buckets`, a draggable handle, hover
  readout. Dragging is continuous; **release snaps to the nearest tick**, so you never land in
  a dead gap where nothing changed.

New `lib/timeline.ts` — pure, unit-tested, no React:

```ts
nearestTick(ticks: number[], t: number): number
stepTick(ticks: number[], t: number, dir: -1 | 1): number | undefined
presetTime(preset: "1h" | "1d" | "7d", now: number): number
timeToX(t: number, from: number, to: number, width: number): number
xToTime(x: number, from: number, to: number, width: number): number
```

Mounted in `graph-shell.tsx` under the canvas, above the existing frame edge. On mobile
(`useIsMobile`) it collapses to the readout plus a **Now** button — a 56px scrubber on a phone
is not usable, and the canvas needs the height more.

The bar owns no time state. It reads `filters.asOf` and calls `onFilterChange({ asOf })`, so
the URL stays the single source of truth and a time-travelled view is shareable by link.

## 9. Client: read-only mode

`readOnly = filters.asOf !== undefined`, derived in `explorer-page.tsx`.

`GraphShell` already documents that absent write handlers mean a read-only explorer, so the
canvas half is subtractive: when `readOnly`, stop passing `onCreateNode`, `onEditNode`,
`onDeleteNode`, `onDrawEdge`, `onDeleteEdge`. No new prop, no new branch inside the shell.

Also gated: the write entries in the ⌘K palette (`command-palette.tsx`) and the edit/delete
affordances in `node-detail.tsx`.

An amber banner sits above the canvas: the viewed time, and a **Return to now** button that
clears `asOf`. It states the reason plainly — writes are disabled because they would apply to
the live version, not the one on screen.

## 10. Client: play

`timeline-bar.tsx` holds the only local state in the feature: `playing`.

Playing advances `asOf` tick-to-tick on a ~700ms timer and stops at the last tick. Each step
is a filter change, so every dependent query refetches through the paths above.

The real risk is the WebGL canvas: a fresh slice every step restarts the force simulation and
the graph explodes rather than evolving. `graph-shell.tsx` already carries a `paused` flag for
the Cosmograph simulation — pin it on entering play and restore it on exit, so playback reads
as nodes and edges appearing and vanishing in place.

Any manual interaction — scrub, step, preset, Now — pauses.

## 11. Testing

**Core** (both drivers via `GRAPHX_TEST_DRIVER`):

- `asOf` on `getNode`, `getNodeContent`, `neighbors`, `neighborsPage`: a node edited twice
  reads back its correct version at three times; a retracted node is absent live and present
  before its retraction; a deleted edge's endpoints are neighbors before the delete and not
  after; `asOf >= FOREVER` matches the live read exactly.
- `timeline.ts`: extent over both tables; `valid_to` closes counted; bucket counts sum to the
  windowed total; `from`/`to` windowing; tick cap sets `ticksTruncated`; empty graph;
  single-instant graph (the `span === 0` guard); `t === to` clamps into the last bucket.
- `serve.ts` routes: `asOf` accepted and honoured on the four reads; `/timeline` shape;
  `openapi.test.ts` covers the new operation.

**Admin:**

- `lib/timeline.test.ts` — snap, step at and past both ends, preset math, coordinate
  round-trip.
- `lib/api.test.ts` — `asOf` reaches the query string on each of the three reads; the
  timeline call.
- Query keys differ by `asOf`, and the existing prefix invalidations still match.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Postgres int4 overflow in bucketing | `CAST(... AS BIGINT)`; covered by a bucket test on both drivers |
| Division by zero when all changes share one instant | Explicit guard before the query; a dedicated test |
| Cosmograph relayout thrash during play | Pin the simulation for the duration of playback |
| `asOf` in query keys breaking invalidation | Append at the end; prefix matching is unchanged, and a test asserts it |
| Timeline bar eats canvas height | Collapses to a readout on mobile |
| Tick cap on a busy project | `ticksTruncated` is returned, and the window narrows on zoom |
