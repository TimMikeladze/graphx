# city-graph

Boston as a bitemporal graph, with a map on top. Every drivable street and traffic signal, a
modelled weekday of traffic in 48 windows, 813k census commuters, 44k crashes, 23k street 311
cases and the MBTA's buses live — and a scenario lab that forks the city, changes it, replays the
day, and shows who wins and who pays.

**The traffic is modelled, not measured.** No free source publishes city-wide speeds or signal
timing. Road times come from a traffic-assignment model over real census commute flows; signal
locations are the city's, their timing is synthesised. Everything else — streets, commutes,
crashes, 311, bus positions — is real data.

```sh
bun install                 # from the repo root
cd examples/city-graph
bun run download            # ~200 MB of public data → data/raw (cached)
bun run prepare-data        # parse + snap to the network → data/prepared (~6 s)
bun run load                # write the graph and model the day → city.db (~3 min)
bun run dev                 # API + map on the first free ports (8899 / 5173 upward)
```

`bun run test` runs the whole pipeline on a checked-in South Boston fixture — no download.

## The questions it answers

| Tab       | Question                                         | graphx underneath                                                                                       |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Traffic   | How congested is every street at 08:15?          | road edges have one version per window; the map reads `listEdges({ rel: 'road', asOf })`                |
| Route     | Fastest drive A→B, and how it changes by hour    | `shortestPath({ asOf, rels: ['road'], types: ['intersection'] })` through the generated route           |
| Commutes  | Who lives where, works where, drives how long    | `commute` nodes with `home` / `work` edges to census zones                                              |
| Scenarios | What if we retime this light or close this road? | `fork({ asOf })` into a new namespace, registered as its own project; replay; compare                   |
| Critical  | Which intersections does the city depend on?     | `betweenness` and `pagerank` `asOf` the peak, persisted with `persistScores`, read with `useTopNodes`   |
| Safety    | Where do people get hurt?                        | crash nodes valid from when they happened, `at` edges, a `crash_risk` score                             |
| Buses     | Which buses lose time, live?                     | each observed stop-to-stop hop becomes a new version of that `transitLink`                              |
| Changes   | What changed between two dates?                  | `diff(t1, t2)`                                                                                          |
| Ask box   | "most dangerous intersections", "busiest lights" | `askGraph` (Jev) plans search / list / rank by our scores; falls back to `hybridRetrieve` without a key |

Click any intersection for its signal plan and history, delay across the day, the commuters whose
route passes through it by home neighbourhood (`neighbors` over `passes`), its crashes by year,
and the 311 cases open at the selected time.

## Data

All public, fetched with a plain User-Agent and nothing identifying. URLs are pinned in
[`src/download.ts`](./src/download.ts).

| Source                                               | Becomes                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| OpenStreetMap (Overpass, Boston bbox)                | 11,355 `intersection` nodes, 25,907 directed `road` edges         |
| data.boston.gov — Traffic Signals                    | 762 signals snapped to intersections (timing synthesised)         |
| data.boston.gov — neighbourhoods by block group      | the city boundary and each zone's neighbourhood                   |
| Census TIGERweb — block groups, Massachusetts tracts | 578 Boston `zone`s plus 1,416 outside tracts commuters come from  |
| Census LEHD LODES8 OD 2023                           | 813k commuters in 250k zone pairs → 21k `commute` nodes           |
| data.boston.gov — Vision Zero crash records          | 44,669 `crash` nodes since 2015                                   |
| data.boston.gov — 311 service requests (2026)        | 23,076 street-related `report` nodes, valid while open            |
| MBTA GTFS + V3 API                                   | 85 bus routes, 1,760 `stop`s, `transitLink`s; live buses (no key) |
| OpenFreeMap                                          | the basemap only                                                  |

## How time works

Valid time is city time. Streets, zones and stops are valid from 2015; a crash from when it
happened; a 311 case from when it opened until it closed. The modelled day is **Tuesday
29 September 2026**: each road segment has one identity and a new version whenever its travel
time or volume changes between windows (15-minute windows through both peaks, hourly elsewhere)
— about 135k road versions. A read `asOf` 08:00 that day sees the 08:00 roads.

## The traffic model

[`src/model/`](./src/model) — pure TypeScript, typed arrays, no dependencies:

- **Demand.** LODES commute flows; residents drive 30% and people coming in 42%, times 70% for
  hybrid work. Morning trips leave home on a standard departure curve, evening trips return;
  non-commute traffic is 1.6× commuting, spread over an urban weekday profile. One calibration
  constant (0.68) puts the 08:00 peak at about twice free-flow time per vehicle-second.
- **Supply.** Free-flow time from OSM speed limits; capacity per lane by road class; BPR
  volume–delay plus the HCM control delay at a signal (Webster's uniform term plus the
  oversaturation term) for the approach's green.
- **Equilibrium.** Frank–Wolfe with a line search, 12 iterations per peak window and 6 off-peak,
  each window solved independently in a worker thread, so the baseline and a scenario run the
  same procedure and differ only by the edit. A full day takes about 75 s on 12 threads.

The network stops at the city line, so trips from outside enter at the nearest highway
intersection. It is a planning model, not a simulator: no queues spilling back, no turns.

## Scenarios are forks

`POST /city/scenarios` forks the city as of the instant before the modelled day — streets,
zones, crashes and open 311 cases come across, the day's traffic does not — applies the edits
(signal retimings are real `updateNode` writes in the branch, so its `history` shows them),
replays the day there, and re-runs the analytics. The branch is registered as a project in the
control plane, so every generated route and React hook works against it; the UI just swaps the
`project` its `GraphProvider` names. The baseline is never written. About two minutes end to end.

## Layout

```
schema.ts            the graph: 8 node types, 9 edge rels
server.ts            createApp + the /city router; scenario hosting; MBTA poller
src/download.ts      stage 1 — sources → data/raw
src/prepare.ts       stage 2 — raw → data/prepared (network, zones, flows, signals, crashes, 311, transit)
src/load.ts          stage 3 — prepared → the graph, geometry, the day, analytics
src/day.ts           the modelled day: road versions, commutes, signal passes
src/model/           demand, delay, Frank–Wolfe assignment, worker pool
src/scenario.ts      fork → edit → replay → analyse
src/analyze.ts       betweenness / pagerank / volume / crash risk, persisted as scores
src/live.ts          MBTA vehicles and stop-to-stop hops
web/                 Vite + React + MapLibre + deck.gl + TanStack Charts
fixtures/seaport/    South Boston, clipped from the real sources, for tests
```
