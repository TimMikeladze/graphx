# skills-graph

Occupations, the skills they need, and 2.7 million observed job moves — built from
[`skill-collector`](https://github.com/TimMikeladze/skill-collector)'s SQLite database and browsed
in `@graphx/admin`.

This is the example with real time in it. Every career transition is loaded as its own temporal
edge, dated by the quarter the move landed in, so the as-of scrubber walks a labour market from
1961 to 2024 rather than switching a static graph on and off.

It is also the example where two taxonomies meet and do not agree. O*NET describes occupations and
their skills in SOC codes (`11-1011.00`, "Chief Executives"); the transition datasets speak
ESCO/ISCO codes (`1212.2`, "human resources manager"). \*\*Not one of the 2.7M transitions references
an O*NET code.\*\* So they are two node types joined by explicit `aligned_with` edges carrying the
crosswalk's confidence — going from a skill to a career path means crossing that seam, and the
seam is visible rather than papered over.

## Running it

```bash
# 1. Build the collector database (once, next to this repo)
git clone https://github.com/TimMikeladze/skill-collector ../../../skill-collector
cd ../../../skill-collector && bun install && bun run ingest

# 2. From the graphx repo root — API on :8789, admin UI on :5173
bun run dev:skills
```

Open <http://localhost:5173>, and use the dev token `dev` when the UI asks for one.

To run only the API:

```bash
bun run server.ts     # :8789
```

| Variable       | Effect                                                                         |
| -------------- | ------------------------------------------------------------------------------ |
| `COLLECTOR_DB` | Path to `skills_graph.db` (default `../../../skill-collector/skills_graph.db`) |
| `PORT`         | API port (default `8789`)                                                      |
| `ADMIN_TOKEN`  | Dev bearer token (default `dev`)                                               |
| `EMBED_CAP`    | Cap on embedded nodes, `0` for all (default `5000`)                            |
| `FRESH=1`      | Rebuild the graph even if the cache is warm                                    |

**The first run is expensive: about two minutes, and a ~1.2GB `skills_demo.db` next to this
README.** That is what loading 2.9M temporal edges costs. Later runs reuse the database, and
rebuild only when the collector database, the schema version, or the embedding settings change.

## The graph

20,993 nodes and 2,891,690 edges.

| Node type         | Count  | What it is                                                              |
| ----------------- | ------ | ----------------------------------------------------------------------- |
| `skill`           | 15,713 | A skill, ability, knowledge area or tool (O\*NET's taxonomy or Nesta's) |
| `occupation_code` | 4,260  | An ESCO/ISCO code as the transition datasets use it                     |
| `occupation`      | 1,016  | An O\*NET occupation — title, summary, SOC code                         |
| `source`          | 4      | An upstream dataset, with its license                                   |

| Relation          | Count     | What it means                                                     |
| ----------------- | --------- | ----------------------------------------------------------------- |
| `transitioned_to` | 2,735,480 | One observed job move by one person, dated by its quarter         |
| `requires`        | 139,081   | Occupation → skill; `data.relation` is essential/optional/related |
| `sourced_from`    | 16,729    | Provenance: which dataset asserted this row                       |
| `similar_to`      | 281       | The O\*NET ⇄ Nesta skill seam, `weight` = confidence              |
| `aligned_with`    | 119       | The O\*NET ⇄ ESCO occupation seam, `weight` = confidence          |

Note the shape of it: 119 fuzzy label matches are the _entire_ bridge between the skills half of
the graph and the careers half. That is the honest state of the public data, and it is the first
thing a real project would want to improve.

### This graph is too dense to render unfiltered

`graphSlice` caps the _nodes_ it returns and then fetches every edge among them, which is fine for
an ordinary graph and not fine for this one: at the default 10,000-row cap, 5,000 nodes drag 2.1M
edges and the explorer asks the browser to swallow a 400MB response. So the server sets
`limits: { maxRows: 1000 }`.

At that cap the unfiltered view is 1,000 nodes and 996 edges — sources and occupations, which is
a sensible place to start — and filtering to `occupation_code` gives 1,000 nodes and 95,685 edges,
which the WebGL canvas renders happily. Filtering by node type is how you explore this graph;
raising `maxRows` is how you make it unusable.

### Where the interesting queries are

- **Career paths.** Traverse `transitioned_to` out of an `occupation_code` and the common next
  moves fall out of the edge density. 328k distinct pairs carry those 2.7M moves.
- **Crossing the seam.** From a `skill`, walk `requires` backwards to an `occupation`, then
  `aligned_with` to an `occupation_code`, then `transitioned_to` — "where do people with this
  skill end up". Every hop after the second is a suggestion, not a fact.
- **Two taxonomies, one concept.** `similar_to` between an O\*NET element and a Nesta skill id
  shows the same idea named twice, with a confidence attached.

### Time

`transitioned_to` edges are dated by the quarter the move _landed_ in — a move is dated when it
arrives, not when it started — and an `occupation_code` node begins at its earliest observed move,
so a code that first appears in 1993 does not exist in the 1970s.

Two caveats worth knowing before reading the timeline:

- **Only JobHop records time.** Its 824k transitions carry a `Q3 2000 -> Q4 2003` window.
  Karrierewege's 1.9M do not, so they are all dated at that dataset's fetch time and pile up in
  the last bucket. The histogram's right edge is an artifact, not a hiring boom.
- **Everything O\*NET is dated at the scrape**, because a taxonomy has no event time. Only the
  transitions carry real-world dates.

### Semantic search

Nodes carry a `body` (label, type and description joined) and are embedded with `hashEmbed` —
deterministic, model-free, no API key. It is a lexical embedding, not a semantic one, so it
returns plausible neighbors without setup but should not be read as a ranking. With 21k nodes and
the default `EMBED_CAP=5000`, roughly one node in five carries a vector, sampled by an even stride
over the load order.

## Layout

| File        | What it does                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.ts` | The graph schema — four node types, five relations                                                                                                                     |
| `load.ts`   | Reads the collector database. `buildNodes` materializes the ~21k nodes; `streamEdges` walks the 2.9M edges in fixed-size batches, so memory does not track corpus size |
| `server.ts` | Builds the graph (cached) and serves it to `@graphx/admin` with a dev token                                                                                            |

`bun test` covers the loader against a hand-built miniature collector database, so it runs without
the real corpus — and additionally against the real one's node pass and first edge batch when it
happens to be present.
