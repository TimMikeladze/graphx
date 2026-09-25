# pantheon-graph

A cross-cultural graph of gods, built from [`pantheon-collector`](https://github.com/TimMikeladze/pantheon-collector)'s
SQLite database and browsed in `graphx-admin`.

The collector scrapes Wikidata, DBpedia, Wikipedia's lists of deities, the Greek Myth API and
`greek-mythology-data` into one database, and deliberately reconciles nothing: where two sources
disagree about Zeus's parents, it keeps both rows. This example carries that shape into a graph
instead of flattening it — which is the point of the example. Provenance is a node you can
traverse to, and cross-source identity is a `same_as` edge with a confidence, not a merge.

## Running it

```bash
# 1. Build the collector database (once, next to this repo)
git clone https://github.com/TimMikeladze/pantheon-collector ../../../pantheon-collector
cd ../../../pantheon-collector && bun install && bun run ingest

# 2. From the graphx repo root — API on :8788, admin UI on :5173
bun run dev:pantheon
```

Open <http://localhost:5173>, and use the dev token `dev` when the UI asks for one.

To run only the API:

```bash
bun run server.ts     # :8788
```

| Variable           | Effect                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| `COLLECTOR_DB`     | Path to `pantheon_graph.db` (default `../../../pantheon-collector/pantheon_graph.db`) |
| `PORT`             | API port (default `8788`)                                                             |
| `ADMIN_TOKEN`      | Dev bearer token (default `dev`)                                                      |
| `EMBED_CAP`        | Cap on embedded nodes, `0` for all (default `5000`)                                   |
| `TYPESAFE_API_KEY` | Jev judges the fuzzy matches and reranks `/hybrid` (see [Jev](#jev))                  |
| `JEV=0`            | Keep the collector's fuzzy matches as they are, even with a key set                   |
| `FRESH=1`          | Rebuild the graph even if the cache is warm                                           |

The first run takes a few minutes — building the vector index is nearly all of it — and writes
`pantheon_demo.db` next to this README. Later runs reuse it, and rebuild only when the collector
database, the schema version, or the embedding settings change.

## The graph

Roughly 10,400 nodes and 26,900 edges.

| Node type  | Count | What it is                                                          |
| ---------- | ----- | ------------------------------------------------------------------- |
| `deity`    | 9,453 | One source's row for one figure — the same god recurs per source    |
| `domain`   | 840   | A domain of influence (sky, fertility, war), shared across cultures |
| `pantheon` | 109   | A named pantheon as one source describes it                         |
| `source`   | 7     | An upstream dataset, with its license                               |

| Relation        | Count | What it means                                                                            |
| --------------- | ----- | ---------------------------------------------------------------------------------------- |
| `sourced_from`  | 9,562 | Provenance: which dataset asserted this row                                              |
| `belongs_to`    | 8,635 | Deity → pantheon                                                                         |
| `has_domain`    | 3,426 | Deity → domain, with the asserting source on the edge                                    |
| `same_as`       | 1,911 | Cross-source identity (1,561 with a Jev key), `weight` = confidence, `data.method` = how |
| `maybe_same_as` | —     | With a Jev key: pairs Jev could not settle, for the Review page                          |
| `parent_of`     | 1,894 | Genealogy, as one source records it                                                      |
| `sibling_of`    | 879   |                                                                                          |
| `consort_of`    | 553   |                                                                                          |

### Where the interesting queries are

- **Disagreement.** Follow `same_as` between two `deity` nodes with different `source` values and
  compare their `parent_of` edges. The graph does not pick a winner; that is a modelling decision
  left downstream.
- **Syncretism.** Cross-source `same_as` crosses pantheons — the Greek/Roman/Etruscan overlaps fall
  out of a name match. Without a Jev key the false positives are visible; with one, the namesakes
  land in the Review queue instead (see below).
- **Domains as a bridge.** Two deities in unrelated pantheons that share `sky` and `thunder` are
  two hops apart without any equivalence being asserted.

### Time

Every row is dated from the real `last_fetched_at` of the source that supplied it, so scrubbing
the explorer replays the collector's tier order: Wikidata, then DBpedia, then Wikipedia, then the
Greek sources. The tiers run seconds apart, so the timeline is seconds wide. It is real, not
synthetic — but this graph is a poor demonstration of time travel. The
[skills example](../skills-graph) has 70 years of it.

### Semantic search

Nodes carry a `body` (a deity's name, native name, pantheon, domains and description joined
together) and are embedded with `hashEmbed` — deterministic, model-free, no API key. It is a
lexical embedding, not a semantic one, so `/retrieve?query=thunder+sky+king` returns plausible
neighbors without any setup, but do not read much into the ranking. Above `EMBED_CAP` nodes the
sample is an even stride over the load order.

### Jev

With `TYPESAFE_API_KEY` set, the build stops trusting the collector's 1,288 fuzzy name matches and
has [Jev](../../README.md#judgments-with-jev) judge each pair on name, native name, pantheon and
description — one request per pair, the whole set in about 20 seconds:

- **same figure** ⇒ `same_as` with `method: 'jev'` and the judgment in its data (938 on the last build);
- **unsure** ⇒ `maybe_same_as` (166) — Nike the goddess vs _Nike_, an epithet of Athena; the Titan
  Pallas vs the Giant; Roman Apollo vs Greek Apollo;
- **different** ⇒ no edge (17).

The unsure ones are the admin UI's **Review** page — the "Review queue" link in the sidebar — where
each pair sits side by side with Jev's score and the fields that disagree. Accepting writes
`same_as` with `method: 'curator'`; rejecting only closes the review edge. Both are bitemporal, so
the queue's history stays readable. `/hybrid` is reranked and screened for injected instructions
(`jevRerank({ guard: true })`).

`bun run eval:rerank` measures the reranker on this corpus: 171 Greek figures described by both the
Greek Myth API and greek-mythology-data, one source's description (name masked) as the query and the
other's 1,533 records as the corpus. Top-1 goes from 35% for `hybridRetrieve` alone to 70% reranked.

## Layout

| File             | What it does                                                                       |
| ---------------- | ---------------------------------------------------------------------------------- |
| `schema.ts`      | The graph schema — four node types, eight relations                                |
| `load.ts`        | Reads the collector database and returns a load plan; no writes, so it is testable |
| `server.ts`      | Builds the graph (cached) and serves it to `graphx-admin` with a dev token         |
| `eval-rerank.ts` | Known-item retrieval eval: fused vs Jev-reranked, on the collector's own data      |

`bun test` covers the loader against a hand-built miniature collector database, so it runs without
the real 30MB corpus — and additionally against the real one when it happens to be present.
