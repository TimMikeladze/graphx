# metro-graph

King County Metro (Seattle) as a graph: every route, stop, stop pattern and scheduled trip from
the published GTFS feed, live bus positions from the GTFS-realtime feed, and a map where you fork
the network into a scenario, change timetables, remove routes or draw new ones, and compare the
result against the published schedule.

```sh
bun install                 # from the repo root
bun run bql:build           # once per machine: bql.sh's libsqlite3 (needs a C compiler)
cd examples/metro-graph
bun run download            # ~11 MB GTFS zip → data/gtfs (re-downloads only when the feed changes)
bun run load                # parse + write the `metro` database (~3 s)
bun run dev                 # API + map on the first free ports (8898 / 5173 upward)
```

`bun run test` runs the pipeline on a checked-in cut of the feed (routes 1, 13 and the South Lake
Union Streetcar) against a bql.sh server in a temp dir, no download.

## Storage

The graph lives on [bql.sh](https://github.com/TimMikeladze/bql). With `GRAPHX_BQL_URL` (and
`GRAPHX_BQL_TOKEN`) set, `load` and `serve` use that server. Without it, each starts bql.sh embedded
in its own process on a free local port, with its databases in `data/bql`. Only one process can
hold `data/bql` at a time, so stop `dev` before running `load`, or run a shared server:

```sh
bun run bql:serve --dir examples/metro-graph/data/bql   # from the repo root; prints both variables
GRAPHX_BQL_URL=… GRAPHX_BQL_TOKEN=… bun run load
GRAPHX_BQL_URL=… GRAPHX_BQL_TOKEN=… bun run dev
```

Each graphx namespace is one bql.sh database: `metro` for the baseline, `metro__scn_<ulid>` per
scenario, plus graphx's control plane. The full feed takes 63 MB. Writes are sliced to stay under
bql.sh's default 8 MB request body and reads page at 5,000 rows under its 10k-row result cap, so
the server runs with stock limits.

## Data

| Source            | URL                                                                     | Becomes                                     |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| KCM GTFS          | `https://metro.kingcounty.gov/GTFS/google_transit.zip`                  | routes, stops, patterns, trips, hops        |
| KCM GTFS-realtime | `https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions.pb` | live buses, polled every 15 s, never stored |
| OpenFreeMap       | tiles                                                                   | the basemap only                            |

Requests send a generic User-Agent and nothing else. The feed holds one service change
(`FAL26-161.2` at the time of writing). The load models three service days: the first Tuesday,
Saturday and Sunday on or after the feed's start date, read through `calendar.txt` and
`calendar_dates.txt`. A trip carries the subset of those days it runs on.

The feed loaded on 2026-10-22: 142 routes (Metro, Sound Transit routes Metro operates, both
Seattle streetcars, the water taxis), 6,265 stops, 423 patterns, 31,536 trips (12,938 on the
weekday), 1.1M stop times.

## Schema

[`schema.ts`](./schema.ts):

- `route` → `has` → `pattern` → `calls {seq}` → `stop`. A pattern is one distinct stop sequence of
  a route in one direction, with its median stop offsets and its shape simplified to 10 m.
- `trip` → `runs` → `pattern`. A trip holds its start time and a seconds-from-start array, one per
  pattern stop. Stop times are not rows: 1.1M versions saying nothing a trip array doesn't.
- `route` → `serves` → `stop`, and `stop` → `hop {route, trips}` → `stop` with the median
  scheduled seconds as the weight. `addRoute` reads hops for its running times.
- `scenario` nodes in the baseline record each fork, its project and its edit log.

Everything in the feed is valid from the feed start date. Stops and routes are full-text
searchable and embedded with `hashEmbed`.

## Scenarios

`POST /metro/scenarios {title}` forks the whole graph into its own namespace and registers it as a
project. Both databases are on one bql.sh server, so the fork is bql.sh branching the database file
rather than graphx copying rows: about 1.4 s for the full network. Because it's a project, graphx's generated routes under `/t/<tenant>/p/<project>` work on
it. Edits post to `/metro/scenarios/:id/edits` and are written into the branch straight away:

```jsonc
// Every 5 min from 07:00 to 09:00 on weekdays, route 1 toward Kinnear
{ "op": "headway", "route": "100001", "direction": 0, "day": "weekday", "from": 25200, "to": 32400, "minutes": 5 }
// Move every Saturday trip of route 13 ten minutes later
{ "op": "shift", "route": "100028", "day": "saturday", "minutes": 10 }
// Delete the route, its patterns, trips and edges
{ "op": "removeRoute", "route": "100028" }
// A new route through the stops in order, every 15 min 06:00 to 22:00 on weekdays
{ "op": "addRoute", "short": "X1", "stops": ["29215", "26510"], "spans": [{ "day": "weekday", "from": 21600, "to": 79200, "minutes": 15 }] }
```

- `headway` drops the day from every trip of that route and direction starting in the window
  (deleting trips that run on no other day) and writes evenly spaced trips on the direction's
  busiest pattern. Each new trip copies the running times of the existing trip nearest in start
  time, so a 07:30 trip gets peak running times.
- `addRoute` reuses the scheduled time of an existing hop between two consecutive stops, and
  otherwise uses straight-line distance at 18 km/h plus 20 s dwell. The line is drawn stop to stop,
  not along streets.
- `GET /metro/compare?project=` returns trips, revenue hours and stops served per day for both
  graphs, stops that lose all service, per-route trip changes, and how many versions the branch
  has written since the fork (graphx `diff`).

The baseline is never edited.

## The map

Pattern lines are coloured and sized by trips in the hour around the selected time. Play runs
the service day at 60×; scheduled buses move along each pattern by its stop offsets, stretched to
the trip's own running time. "Live buses" shows the realtime feed as of now, whatever the slider
says. In a scenario, lines turn blue where a route gains trips that day and red where it loses
them.

Click a route for trips per hour by direction, the timetable and the edit forms; click a stop for
its departures over the next two hours. "Draw a new route" turns clicks on stops into a route.

## The graph viewer

"Graph" in the side panel switches from the timetable map to the graph itself, for the baseline or
whichever scenario is picked. The panel shows the schema with live node counts per type and edge
counts per rel; click a type to limit search to it. Search finds routes and stops by name or
number, patterns by headsign or key, and trips by GTFS id. The focused node shows its data, its
version history (graphx `history`, so a shifted trip in a scenario shows the old and new start)
and every neighbour grouped by rel and direction. Clicking a neighbour walks to it and adds it to
the breadcrumb; "Explore in graph" on a route or stop panel starts a walk from there.

The main area draws the neighbourhood one or two hops out, coloured by node type:

- Abstract: a radial node-link graph. Groups of more than 20 neighbours over one rel (6 at the
  second hop) collapse into a ringed node such as "226 trips"; click it to expand up to 80 members.
  One neighbourhood is capped at 160 nodes. Scroll zooms, drag pans, hover lights a node's edges.
- Spatial: the same nodes on the map. Stops sit at their coordinates, patterns draw as their lines,
  routes and trips sit on a pattern's midpoint. `hop` edges fade from the source stop to the next
  one. "Network hops" draws all 9k `hop` edges. Clicking a line, stop or edge focuses that node.

## API

`/docs` has the OpenAPI reference for graphx's routes. The `/metro` router, every read taking
`?project=` for a scenario:

| Route                                                                                | Returns                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metro/meta`                                                                    | feed info, modelled dates, counts, dev principal                                                                                                           |
| `GET /metro/network`                                                                 | every route, stop and pattern with geometry and `[start, duration, dayMask]` trips                                                                         |
| `GET /metro/route/:gtfsId`                                                           | patterns with stop names, every trip, trips per hour per day and direction                                                                                 |
| `GET /metro/stop/:gtfsId?day=&t=`                                                    | routes at the stop and departures in `[t, t + 2h)`                                                                                                         |
| `GET /metro/vehicles`                                                                | last realtime poll                                                                                                                                         |
| `GET /metro/graph/schema`                                                            | node count per type and edge count per rel, with each rel's endpoint types                                                                                 |
| `GET /metro/graph/search?q=&type=`                                                   | up to 40 matching nodes as `{id, type, label}`                                                                                                             |
| `GET /metro/graph/node/:id?depth=&expand=`                                           | the node's data and history, hop-1 neighbours by rel, and the capped neighbourhood; `expand` takes comma-separated group keys (`<parent>:<rel>:<out\|in>`) |
| `GET /metro/graph/hops`                                                              | every `hop` edge as `[src, dst, seconds, trips]`                                                                                                           |
| `GET/POST /metro/scenarios`, `POST /metro/scenarios/:id/edits`, `GET /metro/compare` | scenarios                                                                                                                                                  |

## Limitations

- No ridership. KCM does not publish stop-level boardings in the feed, so compare reports service,
  not people.
- Drawn routes are straight lines between stops and run one direction.
- Trips past midnight belong to the service day they started on; the slider runs 04:00 to 27:00.
- Fares and transfers are not modelled. Block ids are stored on trips and unused.
