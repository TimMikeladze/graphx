# metro-graph spec

> Status (2026-10-22): built in `examples/metro-graph`. User docs are in its README.

King County Metro (Seattle) as a graph: every route, stop, stop pattern and scheduled trip from
the published GTFS feed, live bus positions from the GTFS-realtime feed, and a map UI where you
fork the network into a scenario, change timetables, cut or draw routes, and compare against the
baseline.

## Data

| Source                        | URL                                                                     | Becomes                        |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| KCM GTFS static               | `https://metro.kingcounty.gov/GTFS/google_transit.zip`                  | routes, stops, patterns, trips |
| KCM GTFS-rt vehicle positions | `https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb` | live buses (not stored)        |
| OpenFreeMap                   | tiles                                                                   | basemap only                   |

The feed covers one service change (e.g. `FAL26`). The load models three service days picked from
the feed's calendar: the first full Tuesday, Saturday and Sunday on or after `feed_start_date`
(calendar plus calendar_dates exceptions). A trip runs on a subset of those three days.

## Schema

- `route` { gtfsId, short, long, desc, agency, mode, color, textColor, url }
- `stop` { gtfsId, code, name, lat, lng, wheelchair }
- `pattern` { key, route, direction, headsign, stops: gtfsId[], offsets: sec[], lengthM, coords }
  One per distinct stop sequence of a route. `coords` is the GTFS shape simplified to ~10 m.
- `trip` { gtfsId, route, pattern (key), direction, headsign, days, start (sec after midnight),
  times: sec[] from start, block }
- `scenario` { title, namespace, project, edits[], status }
- edges: `has` route→pattern, `calls` pattern→stop {seq}, `runs` trip→pattern, `serves`
  route→stop, `hop` stop→stop {route, trips} weight = median scheduled seconds.

Stop times live on the trip as an array, not as 1.1M rows; nothing queries a single stop_time.

## Scenarios

A scenario is `graph.fork()` into its own namespace, registered as a project. Edits are writes in
the branch, applied immediately, so `history`/`diff` see them:

- `headway` { route, direction, day, from, to, minutes }: delete the route's trips that start in
  the window on that day and write evenly spaced trips; running times are copied from the nearest
  existing trip (by start time) on the same pattern.
- `removeRoute` { route }: delete the route, its patterns, trips and edges.
- `addRoute` { short, long, color, stops[], spans[] }: new route + pattern through the clicked
  stops; segment times reuse an existing `hop` when one exists, otherwise distance at 18 km/h plus
  20 s dwell; coords are straight lines between stops.
- `shift` { route, direction, day, minutes }: move every trip of that route.

Compare reads both graphs and returns trips, revenue hours and stops served per day, stops that
lose all service, and per-route trip deltas.

## Server and UI

Storage is bql.sh, embedded on `data/bql` or a server in `GRAPHX_BQL_URL`; a fork is a native
bql.sh branch. Bun + Hono via `createApp`, a `/metro` router for map payloads (`/metro/network`, `/metro/freq`,
`/metro/route/:id`, `/metro/stop/:id`, `/metro/vehicles`, `/metro/scenarios`, `/metro/compare`).
Every read takes `?project=` to read a scenario branch. Vite + React + MapLibre + deck.gl, same
shape as city-graph. Charts with TanStack Charts.

Tests run on a checked-in fixture of a few routes cut from the real feed.
