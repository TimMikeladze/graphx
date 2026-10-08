# city-graph — spec

> **Status (2026-10-08): built** in `examples/city-graph`. Where the build departed from the plan
> below, the plan was updated in place; the "As built" section at the end records the decisions
> made along the way.

Grow `examples/seaport-traffic.ts` (5 intersections, one what-if) into **Boston as a bitemporal
graph** with a map UI on top: every drivable road and signal, modelled travel times for every
15-minute window of a day, commute flows from census data, crashes and 311 reports, the MBTA, and a
scenario lab where you fork the city, change it, and see who wins and who pays.

The point of the example is to answer questions that need **the network, its history and a what-if
in one query** — the thing graphx is for. Everything below maps a question to graphx primitives;
anything graphx cannot do yet is listed under [Core work](#core-work-in-graphx) and done in the
library, not hacked around in the example.

## Questions the app answers

Each one is a screen or panel; each names the graphx calls behind it.

| #   | Question                                                        | graphx                                                           |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Q1  | How congested is every street at 8:15 on a Tuesday?             | road edges `asOf`, `timeline` scrubber                           |
| Q2  | Fastest route A→B leaving at 17:10, and how it changes by hour? | `shortestPath({ asOf })` per window (core G1)                    |
| Q3  | Who drives through this light? Which neighbourhoods, how many?  | `match` commute → passes → intersection, `neighbors`             |
| Q4  | What if we retime / close / road-diet this? Who wins, who pays? | `fork({ asOf })`, re-assign in the branch, `diff`, compare       |
| Q5  | Which intersections is the city most dependent on?              | assigned volume, `pagerank`, `betweenness` (core G3), `topNodes` |
| Q6  | Where are people getting hurt, and is it getting worse?         | crash nodes, `history`, `scoreNodes` risk via Jev, `topNodes`    |
| Q7  | Which bus routes lose the most time to traffic, and where?      | transit links weighted by observed delay per window              |
| Q8  | What changed in the city between two dates?                     | `diff`, `judgeChanges`, `changeFeed`                             |
| Q9  | "Where do Dorchester commuters get stuck in the morning?"       | `askGraph`, `hybridRetrieve`, `graphx mcp` for agents            |

## Data (real, Boston)

All public, no auth except a free MBTA key. Requests use a plain User-Agent, no identifying
headers, rate-limited with backoff (same rules as mma-graph). Downloads cache under
`examples/city-graph/data/` (gitignored); a small checked-in **Seaport fixture** (≈40
intersections) drives tests and CI.

| Source                                        | Gives                                          | Becomes                            |
| --------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| OpenStreetMap (Geofabrik MA extract, clipped) | drivable ways, lanes, speed limits, one-ways   | `intersection` nodes, `road` edges |
| data.boston.gov — Traffic Signals             | ~850 signalised intersections                  | `signal` data on intersections     |
| LEHD LODES8 OD (MA, latest year)              | home block → work block job counts             | `zone` nodes, `commute` nodes      |
| data.boston.gov — Vision Zero crash records   | dated, geocoded crashes by mode                | `crash` nodes → `at` intersection  |
| data.boston.gov — 311 service requests        | dated free-text reports (signals, potholes, …) | `report` nodes with `body`         |
| MBTA GTFS static + V3 API                     | routes, stops, schedules, live vehicles        | `stop` nodes, `transitLink` edges  |
| OpenFreeMap vector tiles                      | basemap only, no key                           | not in the graph                   |

Exact URLs and dataset ids are confirmed in phase 0 and pinned in `sources.ts`.

**Honest gaps.** No free source publishes city-wide live speeds or signal timing plans. So:

- **Signal timing** is synthesised from the approach roads' class (cycle 60–120 s, green split by
  lane count) and stamped `synthetic: true`. The UI says so on every signal.
- **Travel times are modelled, not measured**: LODES flows are spread over the day with a standard
  hourly departure profile and loaded onto the network by traffic assignment (below). They are
  plausible, not observed, and the README says that in its first paragraph.
- **Bus delay** is measured: MBTA V3 predictions against schedule, rolled up per window.

## Schema

```ts
nodes: {
  intersection: { osmId, lat, lng, signal: { cycleSec, green: Record<approach, sec>, synthetic } | null },
  zone:         { geoid, name, neighborhood, residents, jobs },          // census block group
  commute:      { workers, window: 'am' | 'pm' },                          // one OD pair, aggregated
  crash:        { at: number, mode: 'ped' | 'bike' | 'mv', severity },
  report:       { at: number, category, status },                          // body = 311 text
  stop:         { gtfsId, name, lat, lng },
  route:        { gtfsId, name, mode },
  scenario:     { title, author, baseAsOf, status: 'draft' | 'running' | 'done' }, // in the branch
}
edges: {
  road:        intersection → intersection  { street, lengthM, lanes, freeFlowSec, capacity, volume }, weight = seconds
  from / to:   commute → zone  (single)
  passes:      commute → intersection       { order }                     // signalised only
  at:          crash | report → intersection (single)
  inZone:      intersection → zone (single)
  transitLink: stop → stop                  { routeId, scheduledSec }, weight = observed seconds
  serves:      route → stop
}
embedding: { report: body, zone: name + neighborhood, intersection: street names }
```

Commuters are **aggregated OD pairs, not people** (LODES is block-level counts, and per-person nodes
would be millions of rows saying nothing more). ≈550 block groups → tens of thousands of `commute`
nodes with `workers ≥ 5`. `passes` only links signalised intersections (≈8 per route), which keeps
Q3 to one `match` and the edge count near 400k.

## Time model

Bitemporal valid time **is** simulated time. One identity per road segment; each 15-minute window is
a version of it, written with `bulkEdges` rows carrying the same `id` and explicit
`validFrom`/`validTo`:

- A **typical weekday** and **typical Saturday**, stamped on real dates (configurable, default the
  last full week). 96 windows × ~35k segments, but a version is written only when the weight moves
  more than 5% — off-peak is flat, so expect ~1M edge versions per day modelled.
- Signal retimings, closures and new 311/crash data are ordinary live writes at their real time,
  so `history` on an intersection shows its signal plans and incidents in order.
- MBTA live vehicles are **not** versioned per ping (that is ~2M rows a day). The poller streams
  positions to the UI over SSE and writes only per-window delay rollups onto `transitLink`.

The UI's scrubber is graphx's `timeline`; every read the map does carries the scrubber's `asOf`.

## Traffic model (`model/`)

Pure TypeScript, no graphx imports, unit-tested on the Seaport fixture:

1. **Demand**: LODES OD × departure profile → trips per OD pair per window (the PM peak is the
   reverse commute).
2. **Assignment**: Frank–Wolfe user equilibrium with the BPR volume–delay function
   `t = t0 · (1 + 0.15 (v/c)^4)` plus Webster's uniform delay at the far signal (the same term
   the Seaport demo uses). Runs over the CSR graphx already builds (`buildCSR`), so the model and
   the graph never disagree about topology.
3. **Write-back**: per-segment `{ volume, weight }` per window → `bulkEdges` (baseline load) or
   `addEdge`/`deleteEdge` through `Graph` (in a scenario branch, so the outbox and `diff` see it).
4. **Routes**: the equilibrium shortest path per OD pair at the AM and PM peaks → `passes` edges.

Budget: ~550 origin zones × ~10 iterations of Dijkstra on ~15k nodes ≈ 30–60 s for a full day in
Bun. Full baseline is a one-off load; a scenario re-runs only the peak windows (~10 s) and fills
the rest on demand.

## Scenarios (Q4)

A scenario is a **fork**, not a flag column:

1. `g.fork(getDb('city__scn_<id>'), { asOf: baselineDay })` — `method: 'auto'` goes native on
   bql.sh, copy elsewhere.
2. Edits are typed operations recorded as nodes in the branch: `retimeSignal`, `closeRoad`,
   `roadDiet` (lanes −1), `addJobs` (zone gains N workers). Each applies through `Graph`.
3. Re-assign the peak windows in the branch; progress streams to the UI over SSE.
4. Compare: per-segment Δ seconds, per-zone Δ commute minutes (winners/losers), total
   vehicle-hours; `diff(baseline, branch)` lists exactly what was edited; optional
   `judgeChanges` writes the one-paragraph summary.

The scenario list lives in the main namespace (`scenario` nodes) so `listNodes` drives the picker.

## Server

Bun + Hono, one process. `createApp({ schema, … })` mounts graphx's generated routes under `/g`
(OpenAPI at `/g/docs`), and the example adds a thin `/city` router for the payloads a map needs in
one request — nothing that duplicates a generated route:

| Route                             | Returns                                           | Built from                         |
| --------------------------------- | ------------------------------------------------- | ---------------------------------- |
| `GET /city/network`               | segment geometry + ids, once (static, cached)     | `listEdges` + intersection lat/lng |
| `GET /city/weights?asOf&ns`       | packed `Float32Array` of weights in network order | `snapshotCSR(asOf)`                |
| `POST /city/route`                | path + seconds for a departure time, per scenario | `shortestPath({ asOf })`           |
| `POST /city/scenarios`            | fork + apply edits + start assignment             | `fork`, `Graph`, `model/`          |
| `GET /city/scenarios/:id/compare` | Δ per segment, Δ per zone, totals                 | two `snapshotCSR`s, `match`        |
| `GET /city/live`                  | SSE of MBTA vehicle positions                     | poller, not the graph              |

Backend: **libSQL file** by default (Seaport fixture and Boston both fit); **Postgres** on the Fly
sandbox via `GRAPHX_DB_URL` for the full multi-day load. Port: first free from 8899 up; never kill
what holds a port.

`bun run triggers` hosts a `TriggerRunner`: a new `crash` or `report` re-scores its intersection
(Q6) and, for a signal-related 311 report, flags the intersection for review.

## UI

Vite + React 19, `graphx/react` hooks typed from the schema, **MapLibre GL** (basemap) + **deck.gl**
(data layers), **TanStack Charts** for every chart (one `charts.ts` module owns the import), dataviz
skill palette, light/dark.

Layout: full-bleed map, a left rail of panels, a bottom **time scrubber** (`useTimeline`-driven
density histogram, play button, 15-min ticks), a top-bar **scenario picker** and **ask box**.

| Panel / layer          | Q      | What it shows                                                                                               |
| ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Congestion layer       | Q1     | `PathLayer`, segments coloured by `weight / freeFlowSec`; re-fetches only `/city/weights` on scrub          |
| Route                  | Q2     | click two points; route drawn; chart of trip time by departure window across the day                        |
| Intersection           | Q3, Q6 | signal plan + its `history`; delay by hour chart; zones whose commutes pass it (choropleth + list); crashes |
| Commute flows          | Q3     | zone choropleth; click a zone → `ArcLayer` desire lines to work zones, and their routes                     |
| Scenario lab           | Q4     | edit tools on the map; run with progress; split/Δ map; winners/losers bar chart; vehicle-hours              |
| Critical intersections | Q5     | ranked list (volume, pagerank, betweenness), sized dots on the map                                          |
| Safety                 | Q6     | crash `HeatmapLayer`; per-intersection crashes over time; Jev risk score                                    |
| Transit                | Q7     | live buses (SSE, `IconLayer`); per-route delay by segment and window                                        |
| What changed           | Q8     | pick two instants → `useDiff`; list + map highlight                                                         |
| Ask                    | Q9     | `askGraph` / `useHybrid` over reports, zones, intersections; results fly the map                            |

`useChangeFeedSync` keeps every panel live while triggers or a scenario run are writing.

## Core work in graphx

Done in `packages/graphx` first, with tests and README updates, because the example cannot answer
Q1–Q5 honestly without them:

- **G1 — `asOf` on the algorithms.** `shortestPath`, `pagerank`, `community`, `centrality` take
  `asOf` and build from `snapshotCSR` (which already exists). Thread it through the HTTP routes,
  `graphx/react` hooks and MCP tools. Without it "fastest route at 17:10" only works for _now_.
- **G2 — `listEdges` / CSR weights at scale.** Confirm `snapshotCSR` on 35k segments × 1M versions
  is under ~200 ms on libSQL and Postgres; add the missing index on
  `edge_versions(rel, valid_from, valid_to)` if it is not.
- **G3 — `betweenness`.** Brandes with sampled sources (`samples`, `seed`), persisted like
  `pagerank`, readable through `topNodes({ by: 'betweenness' })`.
- **G4 (stretch) — time-dependent routing.** `shortestPath({ departAt, timeDependent: true })`:
  each edge's weight is the version valid at the arrival time at its tail. Today the example
  approximates with the departure window's weights.

Out of scope for core: spatial indexing. The network is loaded once into the browser and indexed
there (`flatbush`); the graph stores lat/lng as data.

## Layout

```
examples/city-graph/
  sources.ts      pinned URLs + fetchers (cache, rate limit, plain UA)
  load/           osm.ts signals.ts lodes.ts crashes.ts reports.ts gtfs.ts — each idempotent
  model/          demand.ts assign.ts bpr.ts webster.ts (pure, unit-tested)
  schema.ts graphx.config.ts
  server.ts       createApp + /city router
  triggers.ts     risk re-score, report flagging
  live.ts         MBTA poller
  web/            Vite app (map, panels, scrubber, charts.ts)
  fixtures/seaport/  checked-in slice for tests + CI
```

Scripts: `download`, `load` (`--fixture` for Seaport), `serve`, `dev`, `triggers`, `test`,
`type-check`. Root gets `dev:city`.

## Tests

- `model/`: BPR and Webster against hand-computed values; assignment converges on the fixture and
  reproduces the Seaport demo's retiming numbers.
- Loaders: fixture in, expected node/edge counts and version intervals out; re-running is a no-op.
- Server: in-process (`app.fetch`, no port) — weights at two `asOf`s differ; route at 08:00 vs
  17:00; a scenario fork's compare shows the edited segment and leaves the baseline untouched.
- Core G1/G3: algorithm results at `asOf` match a fork taken at the same instant.
- UI: browser agent drives scrubber → congestion changes, click intersection → Q3 panel, run a
  retiming scenario → Δ map + winners/losers. Screenshots in the PR.

## Phases

| Phase | Delivers                                                                 | Estimate |
| ----- | ------------------------------------------------------------------------ | -------- |
| 0     | confirm sources + licences, pin URLs, Seaport fixture                    | 0.5 day  |
| 1     | core G1 + G2 (asOf algorithms, index check) with tests + README          | 1 day    |
| 2     | loaders + schema; Boston network, signals, zones, crashes, reports, GTFS | 1.5 days |
| 3     | traffic model + baseline day load; Q1, Q2, Q3 answerable from the CLI    | 2 days   |
| 4     | server + map, scrubber, congestion, route, intersection panels           | 2 days   |
| 5     | scenario lab (fork, edits, re-assign, compare)                           | 1.5 days |
| 6     | critical (G3), safety + Jev, transit live, what-changed, ask box         | 2 days   |
| 7     | README example entry, root `dev:city`, site re-render, browser verify    | 0.5 day  |

≈11 working days. Phases 1–4 alone give a working congestion map with time travel and routing.

## Decisions

- Boston proper, not Massachusetts: ~15k intersections keeps the whole network in the browser.
- Aggregated commutes over synthetic people: real counts, a tenth of the rows.
- Modelled travel times, labelled as such, over no travel times at all.
- Scenarios are forks: the baseline is never mutated, and `diff` is the change log for free.
- Vite SPA, not Next.js: the app is one map; server rendering buys nothing here.
- New capabilities go into graphx core (G1–G3); the example only adds map-shaped payload routes.

## As built

- **Data.** Every source above is live and pinned in `src/download.ts`. Overpass needs a non-browser
  User-Agent (it answers 406 to one) and is flaky, so the downloader rotates three mirrors with
  backoff. Zones are Census TIGERweb block groups (Boston) and tracts (rest of Massachusetts);
  Boston's own "neighbourhoods by block group" layer gives the city boundary. Bluebikes was
  dropped: it answers no question on the list that the bus links do not.
- **One weekday, 48 windows** (15 min through 06–10 and 15–19, hourly otherwise) stamped on
  Tue 29 Sep 2026; ~135k road versions after the 3% / 10% change filter.
- **Demand calibration.** LODES counts jobs, so drive shares are 0.30 resident / 0.42 inbound ×
  0.7 for hybrid work, background traffic 1.6× commuting, and one constant (0.68) sets the 08:00
  peak at ~2.0× free-flow time per vehicle-second. Outside trips enter at the nearest
  motorway/trunk intersection, and each zone's trips spread over its 3 nearest intersections —
  single connectors produced 9× overloads on boundary streets.
- **Assignment** is Frank–Wolfe with a bisection line search (MSA left a 40%+ gap at peak), each
  window solved from scratch in a worker pool: a full day in ~75 s on 12 threads, and baseline
  and scenario use the identical procedure.
- **Scenarios** fork at `DAY − 1` (`asOf`), so the branch has everything but the day's traffic
  and the replay writes the day with the baseline's road ids via `bulkEdges`. Fork ~30 s once
  intersections were taken out of the vector index (they are found by name through FTS on their
  `body`); end to end ~2 min. Each branch is registered with `createProject`, and `analyze` runs
  on it so its rankings are its own.
- **Core.** G1 (`asOf` on `shortestPath` — memory and sql — `pagerank`, `community`,
  `centrality`), G3 (`betweenness`, sampled Brandes, persisted as `score:betweenness`) and a new
  `types` scope on every CSR-based algorithm all shipped in `graphx`, with routes, hooks and
  README. G2 needed no index: a full `listEdges({ rel: 'road', asOf })` over 26k segments reads in
  ~150 ms on libSQL. G4 (time-dependent routing) was not built; routes use the departure
  window's weights.
- **UI.** Vite + React + MapLibre (OpenFreeMap tiles) + deck.gl + TanStack Charts; light and
  dark follow the OS. Tabs map one-to-one onto the question table.
