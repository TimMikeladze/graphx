# anime-graph

Every anime in [manami-project's anime-offline-database](https://github.com/manami-project/anime-offline-database)
as a graphx graph: ~39.2k titles, the studios, producers and tags that link them, and the
franchise relations between them. The loader is idempotent, so it can run on every weekly release.
Each release becomes a new set of versions, and `diff` shows what the release changed.

## Data and attribution

The data is **anime-offline-database** by [manami-project](https://github.com/manami-project),
licensed under the [Open Data Commons Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/)
and the [Database Contents License (DbCL) v1.0](https://opendatacommons.org/licenses/dbcl/1-0/).
The loaded graph keeps the release's `lastUpdate`, license name, license URL and repository on a
`dataset` node. If you publish a graph built from it, the ODbL's share-alike terms apply to that graph.

`fixtures/sample.json` is a 50-entry slice of the 2026-07-04 release, under the same license. The
tests run against it.

## Running it

From this directory:

```bash
bun run download.ts   # ~62 MB into data/ (gitignored); skips the download when lastUpdate matches
bun run load.ts       # builds anime.db — about 4 minutes the first time
bun run queries.ts    # the demo queries below
```

| Flag / variable                   | Effect                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `--embedder hash\|ollama\|openai` | Embedder for `load.ts` / `queries.ts` (default `hash`, model-free)        |
| `ANIME_EMBEDDER`                  | Same, for `graphx.config.ts` and so for `graphx doctor` / `serve` / `mcp` |
| `OLLAMA_MODEL`, `OPENAI_MODEL`    | Model override (`nomic-embed-text`, `text-embedding-3-small`)             |
| `--file <path>` (`load.ts`)       | Load another release file                                                 |
| `--db <path>`                     | libSQL file without `.db` (default `./anime`)                             |
| `TYPESAFE_API_KEY`                | Reranks search with Jev in `queries.ts`; required by `eval-rerank.ts`     |
| `--title`, `--studio`, `--query`  | Change what `queries.ts` asks about                                       |

A namespace records its embedding model, so switching embedders means a fresh `--db` or `graphx reembed`.
`hash` is a lexical embedding: semantic search with it is keyword search with fuzzier edges. Use
`ollama` or `openai` for real semantic search.

The CLI reads the same `graphx.config.ts`: `bunx --bun graphx doctor` from this directory reports
the namespace.

## The graph

| Node type  | Count  | Data                                                                                                                                                                                                                                                                                      |
| ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anime`    | 39,211 | `title`, `type`, `episodes`, `status`, `season`, `year`, `durationSec`, `score` (median), `picture`, `thumbnail`, `synonyms`, `tags`, `sources`, `malId`, `anilistId`, `kitsuId`, `anidbId`, `animePlanetId`, `anisearchId`, `animeCountdownId`, `simklId`, `annId`, `livechartId`, `key` |
| `producer` | 4,923  | `name`                                                                                                                                                                                                                                                                                    |
| `tag`      | 2,915  | `name`                                                                                                                                                                                                                                                                                    |
| `studio`   | 2,735  | `name`                                                                                                                                                                                                                                                                                    |
| `dataset`  | 1      | `lastUpdate`, `license`, `licenseUrl`, `repository`                                                                                                                                                                                                                                       |

| Relation     | Count   | From → to        |
| ------------ | ------- | ---------------- |
| `taggedWith` | 539,242 | anime → tag      |
| `relatedTo`  | 139,385 | anime → anime    |
| `producedBy` | 62,222  | anime → producer |
| `animatedBy` | 29,514  | anime → studio   |

Hentai and porn are left out: any entry tagged `hentai`, `pornography`, `borderline porn`,
`plot with porn`, `erotica` or `18 restricted` (`EXCLUDED_TAGS` in `dataset.ts`) is dropped before
planning, along with relations that point at it, so the counts above exclude them. A reload
retracts any such node an earlier load wrote.

An anime is embedded and full-text indexed on its title, synonyms and tags.

`relatedAnime` lists URLs, not ids. The loader indexes every source URL of every entry, resolves
each related URL through that index, and keeps one `relatedTo` edge per pair, because the same
relation usually arrives as a MAL, AniList and Kitsu URL. URLs that resolve to nothing are counted
and logged. In the 2026-07-04 release every one resolves.

Studio and producer names are the database's lower-case strings, unmerged: `sunrise` and
`sunrise inc.` are two studios.

## Weekly reloads

`load.ts` never starts over. It reads the live graph, matches each entry to a node, and writes only
the difference:

- **Identity.** Each anime is keyed by its MAL URL, then its AniList URL, then its first source.
  When the key moves, for example when an entry gains a MAL link, the loader falls back to any
  source URL the node already had. The node keeps its id and history.
- **Changed entries** become `updateNode` calls. Each one opens a new version, and the old one
  stays in `history`.
- **New entries** go through `addNode`. A first load (or any batch over 2,000) goes through
  `bulkLoad` / `bulkEdges` instead, which defer and rebuild the ANN index.
- **Gone entries** are retracted with `deleteNode`, as are their edges and any studio, producer or
  tag no remaining title uses. Retraction closes the version; nothing is erased.
- The `dataset` node is written last, so two consecutive versions of it bracket exactly one release.
  `queries.ts` diffs between them.

Rerunning against the same release writes nothing:

```
nodes: 0 new, 0 changed, 0 gone, 52847 unchanged; edges: 0 new, 0 gone
embedder hash:256, db …/anime.db — sync 1.8s, total 2.6s
```

## Demo queries

`queries.ts` runs six queries:

1. Franchise tree: `neighbors` and `journey` over `relatedTo` from one title.
2. Studio filmography: a `match()` pattern `anime -animatedBy-> studio`.
3. Semantic search: `hybridRetrieve`.
4. Centrality: `pagerank` over `relatedTo` only, read back with `topNodes`.
5. Franchise groups: `community` over `relatedTo`.
6. `diff` between the last two loads.

Real output on the 2026-07-04 release with `hash` embeddings:

```
── franchise: relatedTo from "Kidou Senshi Gundam" ───────────────────────
Kidou Senshi Gundam (TV, 1979, 7.69) — 115 direct relations
journey (≤2 hops, both directions): 243 titles — 161 at 1 hop, 82 at 2 hops
  → 30th Gundam Perfect Mission (OVA, 2009, 6.42)
  → Akai Shouzou: Char, Soshite Frontal e (SPECIAL, 2010, 5.64)
  …

── filmography: anime -animatedBy-> studio "sunrise inc." ────────────────
478 titles; top TV series by median score:
  Gintama': Enchousen (TV, 2012, 8.85)
  Code Geass: Hangyaku no Lelouch R2 (TV, 2008, 8.82)
  Gintama' (TV, 2011, 8.73)
  Code Geass: Hangyaku no Lelouch (TV, 2006, 8.64)
  Cowboy Bebop (TV, 1998, 8.64)
  …

── hybridRetrieve("dark psychological mecha")  [hash:256] ────────────────
  0.0239  vector+fts Dark Mixer (MOVIE, 2014, 5.62)
  0.0225  vector+fts Dark Machine the Animation (TV, 2026)
  0.0164  vector     Ayatsuri Haramase DreamNote (OVA, 2009, 5.50)
  …

── … reranked by Jev (jevRerank over the top 16) ─────────────────────────
  0.9000  fts        M3: Sono Kuroki Hagane (TV, 2014, 6.40)
  0.5700  vector+fts Dark Machine the Animation (TV, 2026)
  0.4800  fts        Dark Machine: The Animation (TV, 2026)
  …
  16 Jev requests in 0.3s

── pagerank over relatedTo — the most central entries ────────────────────
computed in 0.9s
  6.78e-3  Holo no Graffiti (ONA, 2019, 7.75)
  1.04e-3  Hololive Alternative (SPECIAL, 2021, 7.83)
  9.52e-4  Pokemon (TV, 1997, 7.40)
  5.88e-4  One Piece (TV, 1999, 8.68)
  …

── community() over relatedTo — franchises as connected groups ───────────
4,309 groups of 2+ titles, 18,094 standalone (0.7s)
    270  "Pokemon Shirt Sizing" Concept Movie · A Ripple in Time · Bao Ke Meng Shengtai Yi Riji
    256  30th Gundam Perfect Mission · Akai Shouzou: Char, Soshite Frontal e · All That Gundam
    168  Doraemon · Doraemon · Doraemon & F-Chara All Stars: Getsumen Race de Dai-Pinch!?
  …

── diff between the last two loads ───────────────────────────────────────
release 2026-07-11 → 2026-07-04: 5 anime added, 40 changed, 1 retracted; 45 edge versions moved
  + !NVADE SHOW! (SPECIAL, 2020, 6.18)
  + "0" (SPECIAL, 2013, 4.82)
  …
```

The diff above comes from a test: a doctored "2026-07-11" release, with 5 entries dropped, 40
re-counted and one invented, was loaded and then the real release was loaded back over it.

`journey` enumerates paths, so it stops at depth 2 here: Gundam's cluster is dense enough that
depth 3 takes minutes.

With `hash`, "dark psychological mecha" matches on the word "dark". Jev reads each shortlisted
title's tags and moves _M3: Sono Kuroki Hagane_, a grim mecha series that fused retrieval ranked
outside the top 8, to first. Rerun with `--embedder ollama`
or `openai` after loading with the same embedder for semantic hits. PageRank over `relatedTo`
rewards hubs that many short entries point at, such as Hololive clips and Pokémon shorts, rather
than critical acclaim.

## Reranking with Jev

With `TYPESAFE_API_KEY` set, `queries.ts` reranks the semantic-search shortlist with
[Jev](../../README.md#judgments-with-jev). `rerank.ts` wraps `jevRerank()` with a `state` that
shows Jev only what describes a title: its name, format, year, alternative titles and tags. Image
URLs and site ids would be noise to a relevance judgment. Without a key, that section prints a skip
notice.

`bun run eval-rerank.ts` measures it. Each of 20 hand-written queries describes a well-known title
without using any word of it, for example "a student finds a notebook that kills anyone whose name
is written in it" for _Death Note_. A hit is that title:

| retrieval                             | top-1 | top-3 | top-10 |   MRR |
| ------------------------------------- | ----: | ----: | -----: | ----: |
| fused, `hash:256`                     |    0% |    0% |     5% | 0.017 |
| fused + jevRerank, `hash:256`         |   15% |   15% |    15% | 0.150 |
| fused, `nomic-embed-text`             |    0% |    0% |    10% | 0.025 |
| fused + jevRerank, `nomic-embed-text` |   25% |   25% |    25% | 0.250 |

In every run, Jev puts each right title that reaches the 30-candidate shortlist first. The
shortlist is the bottleneck: 15% of right titles reach it with `hash`, and 25% with Ollama's
`nomic-embed-text`. Loading with Ollama took 27 minutes, most of it building libSQL's 768-wide ANN
index. Either way, an eval run is about 470 Jev requests in 10 seconds.

## More like this

`bun run similar.ts "Shingeki no Kyojin"` finds titles similar to one anime, from outside its own
franchise. Candidates share tags with the seed through `taggedWith`, and each shared tag is weighted
by its rarity, so "dark fantasy" counts for more than "action". Anything within 2 `relatedTo` hops
of the seed is excluded. With `TYPESAFE_API_KEY`, Jev then reads the seed and each of the 40
shortlisted titles and judges whether a fan of the seed would like it for the same reasons:

```
similar to Shingeki no Kyojin (TV, 2013, 8.61) — franchise of 61 titles excluded

judged by Jev — "would a fan of Shingeki no Kyojin enjoy this for the same reasons?":
    0.70  Kenpuu Denki Berserk (TV, 1997, 8.41)
    0.67  Claymore (TV, 2007, 7.89)
    0.64  Yakusoku no Neverland (TV, 2019, 8.50)
    0.62  Koutetsujou no Kabaneri (TV, 2016, 7.44)
    0.61  Fullmetal Alchemist: Brotherhood (TV, 2009, 9.08)
    0.61  Vinland Saga (TV, 2019, 8.70)
  40 Jev requests in 0.6s
```

Tag overlap alone ranks _Evangelion_ and _Kimetsu no Yaiba_ near the top. Jev moves the grim
survival stories up: _Berserk_, _Claymore_, _Kabaneri_, and _Vinland Saga_, which tag overlap ranked
outside its top 10.

The whole `relatedTo` component is not a usable franchise boundary. Crossovers and compilations
chain about 5,700 titles around _Attack on Titan_ into one component, which is why the exclusion stops
at 2 hops.

## Web app

A minimal search UI is deployed at **<https://anime-graph-nine.vercel.app>**. It is a single page:
describe what you want to watch, then open a title to see its franchise links and a "more like
this" list judged by Jev.

- `web/api.ts`: three routes over the graph in Postgres:
  - `/api/search?q=` runs `hybridRetrieve` and then a Jev rerank.
  - `/api/anime/:id` returns the title, its `relatedTo` neighbours and `similarTo()`.
  - `/api/meta` returns the `dataset` node.
- `/api/graph/:id` returns one node and a capped slice of its neighbours. For an anime that is its
  `relatedTo` franchise links (up to 40), its studios and producers, and its 8 rarest tags used by
  at least 20 titles. For a studio, producer or tag it is the 30 best-scored titles.
- `web/public/index.html`: the search UI, plain HTML and JS.
- `web/public/graph.html`: the graph explorer at
  [/graph.html](https://anime-graph-nine.vercel.app/graph.html), drawn with
  [force-graph](https://github.com/vasturiano/force-graph). It starts at _Kidou Senshi Gundam_,
  and clicking any node pulls in its neighbours, so you can keep expanding indefinitely: title to
  tag to other titles to their studios. The URL hash records the expanded ids, so an exploration
  can be shared.
- `web/dev.ts`: a local server for `public/` and the API. It takes `PORT`, or else the first free
  port from 8790.
- `web/build.ts`: writes `web/.deploy/`, a self-contained Vercel project. The API is one Node
  function with the workspace graphx and `pg` bundled in, since the graphx on npm is older than
  this example. The libSQL client is stubbed out of the bundle.

To run it on your own Postgres (pgvector required):

```bash
bun run load.ts --pg "$DATABASE_URL"            # same idempotent sync, into Postgres
DATABASE_URL=… bun run web/dev.ts                # http://localhost:8790
bun run web/build.ts && cd web/.deploy && vercel link && vercel deploy --prod
```

On Vercel, set `DATABASE_URL`, and `TYPESAFE_API_KEY` for Jev. The function embeds queries with
`hashEmbed(256)`, which must match the embedder the database was loaded with. Loading into the
Fly Postgres sandbox took 9 minutes, mostly network round-trips for the 826k edges.

## Layout

| File               | What it does                                                                    |
| ------------------ | ------------------------------------------------------------------------------- |
| `graphx.config.ts` | Schema, embedder choice, namespace; shared with the `graphx` CLI                |
| `dataset.ts`       | Release Zod schema, source-URL parsing, identity, and the pure load plan        |
| `download.ts`      | Fetches the latest release, or skips when `lastUpdate` matches                  |
| `load.ts`          | Syncs a plan into the graph: insert, update or retract only what changed        |
| `queries.ts`       | The demo queries                                                                |
| `similar.ts`       | "More like this": idf-weighted tag overlap outside the franchise, judged by Jev |
| `rerank.ts`        | `animeRerank()`: `jevRerank` reading title, format, year, synonyms and tags     |
| `eval-rerank.ts`   | Known-item eval: 20 plain-language descriptions, fused vs Jev-reranked          |
| `schema.ts`        | The graph schema, driver-free (`graphx/core`), so the web bundle can import it  |
| `web/`             | Search UI + API (Postgres), deployed to Vercel                                  |
| `load.test.ts`     | Planning, idempotency and a simulated next release, on `fixtures/sample.json`   |
