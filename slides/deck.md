# What if we cross a graph with a time-series database?

Two old ideas. One question.

> Notes: No product names for the first eight slides. Everything until slide 9 is theory.

---

## What is a graph?

**Nodes** are things. **Edges** are how things relate.

```
  You ──knows──▶ Ana ──worksAt──▶ Amplified Industries ──locatedOn──▶ Drydock Ave
```

Questions a graph answers naturally:

- Who is connected to whom?
- How far apart are two things?
- What sits in between?

> Notes: Subway map, family tree, org chart, the internet — all graphs. The interesting part is the edges, not the dots.

---

## Graph databases

**Examples:** Neo4j · Amazon Neptune · Memgraph · TigerGraph · ArangoDB

**Used for:** social networks · fraud rings · recommendations · supply chains · knowledge graphs · IT/network topology · routing

**What they solve:** questions about connections of _unknown depth_ — "is this account linked to a known fraudster, by any path?"

**Why not SQL?**

- Every hop is a `JOIN`. Friends-of-friends-of-friends = three self-joins.
- Unknown depth needs recursive CTEs; they get slow and hard to read.
- Relationships are buried in foreign keys instead of being first-class.
- A graph engine makes the walk the native operation.

> Notes: SQL _can_ do it. The point is ergonomics and the cost growing with depth.

---

## Time-series databases

**Examples:** InfluxDB · TimescaleDB · Prometheus · QuestDB · kdb+

**The data:** `(timestamp, series, value)` — append-only, write-heavy, mostly recent.

**How they index:**

- Partition by time into chunks; newest chunk stays hot.
- Store rows sorted by time — a range query is one contiguous scan.
- Compress hard: delta-of-delta timestamps, XOR'd floats (Gorilla).
- Downsample old data, expire it with retention policies.

**What they solve:** "what was the value at _t_?", "how did it change?", trends, rollups, alerts.

> Notes: Never update in place. History is the product.

---

## What if we combine them?

A graph where **every node and every edge has a history.**

New questions become one query:

- What did the network look like **last Tuesday at 5pm**?
- What **changed** between then and now?
- Which paths **existed at the time**? (you can't catch a train that already left)
- When did this relationship **start**, and when did it **end**?
- Who knew what, **and when**?

> Notes: A graph DB answers "how is this connected". A TSDB answers "how did this change". Together: "how did the connections change".

---

## Let's talk time travel

Nothing is ever overwritten. An update **closes** the old version and **opens** a new one.

```
Drydock & Tide light   green 30s  [08:00 ──────── 17:00)
                       green 50s                 [17:00 ──────── ∞)
                                    ▲
                              as of 12:00 → 30s
```

- **As-of read** — rebuild the whole graph at any instant.
- **History** — every version of one thing.
- **Diff** — what was added, changed, removed between two instants.
- **Change feed** — stream every version as it lands.

> Notes: Bitemporal: each version carries valid_from / valid_to. A delete is just closing the interval.

---

## What if we could create branching universes?

Fork the world at a moment. Change one thing. Run both forward. Compare.

```
today ────────────●──────────── universe A: leave it alone
                  │
                  └──────────── universe B: retime one traffic light
                fork
```

- City planning: what if we close this street?
- Supply chains: what if this port shuts for a week?
- Incidents: replay the outage with the fix applied.

> Notes: Git for the state of the world. Branch, what-if, keep or throw away.

---

## That's all great. How do I use this today?

The usual answer is glue:

- a graph DB **+** a time-series DB **+** an event log
- two query languages, a sync job between them
- the "as-of join across both" is yours to write
- or SQL temporal tables: history, but no graph walks

What we want: **one schema, one versioned graph, running where the data already lives.**

---

## Introducing graphx

Everything so far was theory. This is an implementation.

- **Graph** — define nodes and edges once with Zod; typed writes, pattern matching, no codegen.
- **Time** — every write is versioned; `asOf` on reads, `history`, `diff`, `changeFeed`, `timeline`.
- **Walks** — time-respecting `journey`, weighted `shortestPath`, `pagerank`, communities.
- **Search** — vector + full-text retrieval over the same graph.
- **Anywhere** — SQLite/libSQL, Postgres, DuckDB, the browser, Expo. HTTP + OpenAPI, React hooks, MCP.
- **Universes** — `fork` a namespace at any instant, diverge, compare.

> Notes: Branching is one call: `g.fork(db, { asOf })` copies a namespace, history and all, into an empty one; from there the two diverge.

---

## Under the hood: bql.sh

graphx keeps time **per row**. bql.sh keeps time **per database**.

- **WAL shipping** — every committed WAL frame streams to replicas over a socket.
- **Continuous backup** — to any S3-compatible bucket; restore to any txid or instant.
- **Forks with lineage** — a reflink where the filesystem allows; a branch per pull request, or per what-if.
- **Realtime** — live queries driven by SQLite's own hooks, not triggers.

```ts
import 'graphx/bql';
const bql = { driver: 'bql', bqlUrl: 'http://127.0.0.1:4321' } as const;

await fork(getDb('today', bql), getDb('retimed', bql), { asOf: eightAm }); // method: 'native'
```

> Notes: Two clocks. graphx's valid_from / valid_to say when a fact was true; bql.sh's txid log says when the database committed it. `fork` copies a graph between any two backends; between two databases on one bql.sh server it lets bql.sh branch the file, then trims it to the cut.

---

## Modeling the real world

A city block in Boston's Seaport: **Drydock Ave**. A company on it: **Amplified Industries**.

```ts
const schema = defineGraphSchema({
	nodes: {
		intersection: z.object({
			name: z.string(),
			lat: z.number(),
			lng: z.number(),
			cycleSec: z.number(),
			green: z.record(z.string(), z.number()), // street → seconds of green
		}),
		place: z.object({ name: z.string() }),
	},
	edges: {
		road: { from: 'intersection', to: 'intersection' }, // weight = seconds
		locatedAt: { from: 'place', to: 'intersection', single: true },
	},
});
```

> Notes: Geometry is approximate and illustrative, not survey data.

---

## A geospatial graph

```
 Northern & Tide ◀──── Northern & Harbor
        │                     ▲
     Tide St               Harbor St
        ▼                     │
  Drydock & Tide 🚦 ◀── Drydock & Design Center  ◀ Amplified Industries
        │
   Drydock Ave
        ▼
 Summer & Drydock → I-90
```

- **Intersection** = a node with a lat/lng and its light's timing.
- **Road segment** = an edge. Its weight is _seconds_: drive time + the average wait at the next red.
- Average wait at a fixed-time light ≈ (cycle − green)² ÷ (2 × cycle).

> Notes: Longer red → longer wait, and it grows with the square. That's the whole model.

---

## The problem

**5pm.** Amplified Industries' shift lets out. 400 cars head for I-90.
The Drydock & Tide light gives Drydock Ave **30 of every 90 seconds**.

**What if Drydock got 50?**

|                    | trip to Summer St |
| ------------------ | ----------------- |
| 8am, today         | 1 min 48 s        |
| 5pm, today         | 5 min 26 s        |
| 5pm, light retimed | 4 min 52 s        |

- **34 s** faster per car × 400 cars = **3.8 hours** back every evening.
- The cost: Tide St drivers wait **14 s** longer.

How graphx got there: rush hour is a **new version** of the roads (8am is still readable), the retimed light lives in a **branch forked at 8am**, `shortestPath` answers both. `examples/seaport-traffic.ts` forks with `g.fork`; `examples/seaport-traffic-bql` makes the same fork natively on bql.sh.

> Notes: Every number here is real output of examples/seaport-traffic.ts, and examples/seaport-traffic-bql prints the same ones. Is 3.8 hours worth 14 s on Tide St? That's the engineer's call — the graph makes the trade visible.

---

## Getting started with graphx

```sh
bunx graphx new my-app
cd my-app && bun install
bun run serve          # http://localhost:8899  ·  /docs
```

```ts
import { getDb, init, Graph, history, diff } from 'graphx';

const db = getDb('city');
await init(db);
const g = new Graph(db, schema);

await g.updateNode(light, { data: { green: { 'Drydock Ave': 50, 'Tide St': 40 } } });
await g.getNode(light, { asOf: yesterday }); // the light as it was
await diff(db, yesterday, Date.now()); // what moved since
```

On bql.sh: `import 'graphx/bql'` and `getDb(name, { driver: 'bql', bqlUrl })` — one namespace is one bql.sh database.

**graphx.sh** · **github.com/TimMikeladze/graphx** · `bun add graphx`
