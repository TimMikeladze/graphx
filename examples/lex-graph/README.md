# lex-graph

Every episode of the [Lex Fridman Podcast](https://lexfridman.com/podcast/) and
[Sean Carroll's Mindscape](https://preposterousuniverse.com/podcast/) as one graphx graph: 952
conversations from July 2018 on, the 753 people in them, the topics in their titles, the sponsors
that paid for them, and the chapters where one episode brings up a guest from another. People are
shared across shows by name, so the 43 guests who sat with both hosts (Max Tegmark, Stephen
Wolfram, Kate Darling, …) are single nodes that tie the two shows together. Sean Carroll is one
node too: Mindscape's host and a three-time Lex guest. Every node and edge is valid from the
episode that introduced it, so `asOf` shows the shows as they stood on any date.

The code is generic over shows. Each one is a module in `podcasts/` that knows its own sources and
title shapes; the schema, loader, API and app work on whatever shows `podcasts/index.ts` lists.

## Running it

From this directory:

```bash
bun run scrape.ts   # fetches every show into data/<podcast>/ (gitignored), writes episodes.json
bun run load.ts     # builds podcasts.db — about 8 seconds
bun run queries.ts  # the demo queries below
bun test            # parsers, plan, loader and API against fixtures/, no network
```

To explore it in **Podcast Atlas** (below), run `bun run dev:lex` from the repo root, or
`bun run dev` here. That starts `server.ts` (the API on :8790) and the app (Vite on :5180), and one
Ctrl-C stops both. If a port is taken, each moves to the next free one. The server scrapes any
show that has no `data/<podcast>/episodes.json` yet, then syncs every scrape into `podcasts.db`,
which is a no-op when nothing changed.

To use the generic admin UI on the same graph instead, run `bun run dev:lex:admin` from the repo
root (token `dev`). For production, `bun run build` builds the app into `web/dist`, and
`bun run server.ts` then serves the app and the API on one port.

| Flag / variable                                            | Effect                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `--podcast lex\|mindscape` (`scrape.ts`)                   | Scrape one show instead of all                                            |
| `--offline` (`scrape.ts`)                                  | Re-parse the saved responses in `data/` instead of fetching               |
| `--embedder hash\|ollama\|openai`                          | Embedder for `load.ts` / `queries.ts` (default `hash`, model-free)        |
| `PODCAST_EMBEDDER`                                         | Same, for `graphx.config.ts` and so for `graphx doctor` / `serve` / `mcp` |
| `OLLAMA_MODEL`, `OPENAI_MODEL`                             | Model override (`nomic-embed-text`, `text-embedding-3-small`)             |
| `--db <path>`                                              | libSQL file without `.db` (default `./podcasts`)                          |
| `--guest`, `--query`, `--from`, `--to`, `--asOf`, `--year` | Change what `queries.ts` asks about                                       |

A namespace records its embedding model, so switching embedders means a fresh `--db` or
`graphx reembed`. `hash` is lexical: semantic search with it is keyword search with fuzzier edges.

The CLI reads the same `graphx.config.ts`: `bunx --bun graphx doctor` from this directory reports
the namespace.

## Adding a show

1. Write `podcasts/<key>.ts` exporting a `Podcast` (`podcasts/source.ts`): its key, name, short
   caption prefix, host, home page, cover art, source URLs, and a `scrape(dir, { offline })` that
   saves its raw responses in `dir` and returns `Episode[]` (`parse.ts`). `parse.ts` has the RSS
   parser and the name/topic splitters both current shows use.
2. Add it to `PODCASTS` in `podcasts/index.ts`.
3. `bun run scrape.ts --podcast <key> && bun run load.ts`.

If one of its guests shares a name with a different person on another show, give them a name of
their own the way `HOMONYMS` in `podcasts/mindscape.ts` does for John Danaher.

## Podcast Atlas: the app

`web/` is a single-page app for exploring the graph. It draws with the admin UI's own canvas:
`GraphShell`, `GraphCanvas` and `TimelineBar` are imported straight from `packages/admin/src` (a
`@` alias), not copied, so the WebGL force layout, flow renderer, toolbar, labels, legend and
time-travel scrubber are the admin's.

- **Show filter.** All, Lex Fridman or Mindscape. One show narrows every view to its episodes and
  the people, topics and sponsors they touch.
- **Search.** Hybrid search over episodes, people, shows, topics and sponsors.
- **Focus.** Selecting a node redraws the canvas as its neighborhood, out to 1–3 hops over
  `appearedOn`, `mentions`, `about` and `hosts`, plus `sponsoredBy` when a sponsor is the focus
  and `episodeOf` when a show is. With no focus, the canvas shows everything.
- **Detail panel.** An episode shows its show, guests, topics, sponsors, summary, transcript link
  and chapters, each chapter linked to its YouTube timestamp. A person shows the shows they host,
  every appearance on any show, and every other episode that names them. A show shows its host,
  its regulars and its latest episodes.
- **Crossovers.** The overview lists everyone heard on more than one show.
- **Path.** Pick two people to see the shortest chain of episodes, people and topics between them,
  drawn on the flow renderer as a chain. Carlo Rovelli (Mindscape only) reaches Elon Musk (Lex
  only) in six hops through quantum mechanics and Sean Carroll's Lex episode.
- **Time travel.** The admin `TimelineBar` scrubs `asOf` across 2018–2026. The slice, search and
  overview are all read as of that instant.
- **Shareable state.** The show filter, focus, selection, path and `asOf` live in the URL.
- **Pictures.** Lex episodes, and people via their latest video, carry the YouTube thumbnail as
  the slice's `image`, so the admin canvas draws faces when its picture toggle is on. Mindscape
  has no videos in its sources, so its episodes carry the show's cover art.
- **The whole graph** ties each show's episodes to its `podcast` node, so each show is its own
  cluster, bridged by shared guests and topics. It hides sponsors (toggle them on) and topics only
  one episode has.

The data comes from `api.ts`, a read-only Hono app that `server.ts` mounts at `/atlas`. The graphx
routes the scrubber needs (`/t/:tenant/p/:project/timeline`) accept anonymous GETs as a `viewer`
member, which can read and not write. The dev token still gets an operator, so the admin UI keeps
working against the same server.

## The scrape

Requests go out with a generic browser user agent and no other headers.

### Lex Fridman Podcast (`podcasts/lex.ts`)

- **The RSS feed** (`lexfridman.com/feed/podcast/`) carries every episode since 2018: title,
  publish date, duration, audio, and a description holding the guest's intro, the sponsor reads
  and the chapter outline.
- **The podcast page** (`lexfridman.com/podcast/`) lists the guest names as the site spells them,
  a one-line tagline, and the YouTube link.

The two are joined on the episode slug. The feed is the spine. The page supplies guests for titles
that don't lead with a name (`#459 – DeepSeek, China, OpenAI, …`). Things the parser handles:

- **Four title shapes**: `Max Tegmark: Life 3.0` (2018–19), `#252 – Elon Musk: SpaceX, Mars, …`,
  `#459 – DeepSeek, China, …` (no guest), and `#488 – Infinity, … – Joel David Hamkins` (guest at
  the end). Topics are the comma list after the name. Only commas and `&` split it, so "Thinking
  Fast and Slow" stays one topic.
- **Group labels.** The page names some episodes by group: "Cursor Team", "Iran War Debate",
  "FFmpeg and VLC". For those, the guests come from the summary's "X is …" / "X, Y, and Z are …"
  sentences. `#447` gets its four Cursor founders that way.
- **Three eras of sponsor reads**: `<b>SPONSORS:</b> … <b>LMNT:</b>`, `– <b>Policygenius</b>:`
  and the unbolded `– Cash App – use code …`. Names are keyed without spacing or punctuation, so
  `Sun Basket` and `Sunbasket` are one sponsor.
- **The first 71 episodes** lost their numbers when the feed was retitled. They were numbered in
  release order, and exactly 71 unnumbered interviews come before `#72`, so they get `#1`–`#71`.
- **Two episodes the feed dropped** are still on the page: `#84` William MacAskill and `#98` Kate
  Darling. The scrape recovers each from the Wayback Machine's copy of its post (full
  description). When no copy exists, it falls back to the YouTube page (date, length, and the
  number from the video title).

`#100` is on neither the feed nor the page. Apart from that, Lex holds every number from 1 to 502,
plus two solo episodes, an AMA and the 2020 rename announcement: 505 episodes.

### Sean Carroll's Mindscape (`podcasts/mindscape.ts`)

- **The RSS feed** (on Libsyn) carries all 447 episodes since July 2018: title, date, duration,
  audio, the episode intro and the guest's bio. There are no sponsor reads or chapter outlines.
- **The site's post sitemap** (`preposterousuniverse.com/wp-sitemap-posts-post-1.xml`) lists each
  episode's post, which holds the show notes and the transcript. Most feed items link to a Libsyn
  page instead, so the sitemap is where `url` and `transcriptUrl` come from.

Things the parser handles:

- **Title shapes**: `241 | Tim Maudlin on Locality, Hidden Variables, and Quantum Foundations`
  (guest before `on`, topics after), `Solo: …` / `Solo | …` / `Solo -- …`, `AMA | June 2025` and
  its spellings, `Holiday Message …`, `Bonus | …`, and a names-only `316 | Niayesh Afshordi and
Phil Halper`.
- **Groups.** "Daniels" is a directing duo; the bio paragraph names Daniel Kwan and Daniel
  Scheinert.
- **Taglines** come from the bio paragraph's "He is currently …" sentence ("Professor of
  philosophy at New York University").
- **Posts** are matched by slug, then by the episode number at the start of the post's slug
  (`241-…`, `episode-27-…` in 2018), then by the day it went up, for the few the site renumbered
  (`232` in the feed is `231-…` on the site) or renamed (`ama-may-2022` is `ama-may-2020-2`). All
  447 episodes get their post; the site's `ama-may-2020` post has no episode in the feed.
- **Homonyms.** Mindscape's John Danaher is a philosopher, Lex's a jiu-jitsu coach, so the
  Mindscape one is `John Danaher (philosopher)`.

## The graph

| Node type | Count | Data                                                                                                                                                                               |
| --------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `podcast` | 2     | `key`, `name`, `short`, `host`, `url`, `image`                                                                                                                                     |
| `episode` | 952   | `podcast`, `slug`, `number`, `kind`, `title`, `guests`, `topics`, `tagline`, `publishedAt`, `durationSec`, `url`, `youtubeUrl`, `transcriptUrl`, `audioUrl`, `summary`, `chapters` |
| `topic`   | 1,452 | `key`, `name`                                                                                                                                                                      |
| `person`  | 753   | `key`, `name`, `tagline`                                                                                                                                                           |
| `sponsor` | 135   | `key`, `name`                                                                                                                                                                      |
| `dataset` | 1     | `sources`, `latestEpisode`                                                                                                                                                         |

| Relation      | Count | From → to         |
| ------------- | ----- | ----------------- |
| `about`       | 2,083 | episode → topic   |
| `sponsoredBy` | 1,824 | episode → sponsor |
| `episodeOf`   | 952   | episode → podcast |
| `appearedOn`  | 883   | person → episode  |
| `mentions`    | 260   | episode → person  |
| `hosts`       | 2     | person → podcast  |

Natural keys: a show by its key, an episode by show + slug (slugs are only unique within a show),
a person, topic or sponsor by its normalized name, across shows. That last part is what joins the
shows: Max Tegmark is one `person` with `appearedOn` edges into Lex `#1` and Mindscape `#75`.

`mentions` links an episode to a person from another episode when one of its chapter titles names
them, like `(2:27:05) – Joe Rogan` in Khabib's episode. The edge keeps the chapter title and start
time. Only multi-word names match, because one-word handles ("Destiny") collide with ordinary
words. Only Lex has chapters, but a Lex chapter can name a Mindscape guest.

An episode is embedded and full-text indexed on its guests, title, summary and chapter titles.

**Valid time.** Each node is valid from its first episode: a show and its host from the show's
first episode, a person from their first appearance on any show, a sponsor from its first read.
Each edge is valid from its episode. `match().asOf(t)`, `hybridRetrieve({ asOf })` and
`diff(t1, t2)` therefore answer questions about the shows' own timeline, such as what 2024 added.
They don't describe when the loader ran.

## Reloads

`load.ts` never starts over. It reads the live graph, matches each planned node by natural key,
and writes only the difference. New nodes and edges go through `bulkLoad` / `bulkEdges` with their
episode's date as `validFrom`. Changed nodes become `updateNode` versions, and gone ones are
retracted with `deleteNode`. The `dataset` node is written last. A rerun after the scrape picks up
a new episode adds that episode, its new guests and topics, and their edges. Rerunning against the
same scrape writes nothing:

```
nodes: 0 new, 0 changed, 0 gone, 3295 unchanged; edges: 0 new, 0 gone
```

## Demo queries

`queries.ts` runs ten queries. Here is real output with `hash` embeddings on the 2026-10-08
scrape:

```
── most appearances: person -appearedOn-> episode, any show ──────────────
   7  Michael Malice         2020–2023
   5  Elon Musk              2019–2024
   5  Stephen Wolfram        2020–2023
   …
752 guests across 852 episodes; 93 came back at least once

── crossovers: people with appearedOn edges into more than one podcast ───
  Max Tegmark            Lex ×3, Mindscape ×1
  Christof Koch          Lex ×1, Mindscape ×1
  Steven Pinker          Lex ×1, Mindscape ×1
  …
43 people have been a guest on more than one show

── "Sean Carroll": hosts, appearedOn, and mentions from other episodes ───
  hosts Sean Carroll's Mindscape
  2019-07-10  Lex #26 Sean Carroll: The Nature of the Universe, Life, and Intelligence
  2019-11-01  Lex #47 Sean Carroll: Quantum Mechanics and the Many-Worlds Interpretation
  2024-04-22  Lex #428 Sean Carroll: General Relativity, Quantum Mechanics, Black Holes & Aliens
named in a chapter of 1 other episode(s)
  2020-03-07  Lex #79 Lee Smolin: Quantum Gravity and Einstein’s Unfinished Revolution — Lee Smolin

── most mentioned: episode -mentions-> person, by other guests ───────────
   53  Elon Musk
   29  Joe Rogan
   25  Donald Trump
   …

── hybridRetrieve("origin of life chemistry")  [hash:256] ────────────────
  0.0323  vector+fts 2022-03-11  Lex #269 Lee Cronin: Origin of Life, Aliens, Complexity, and Consciousness — Lee Cronin
  0.0303  vector+fts 2022-12-29  Lex #350 Betül Kaçar: Origin of Life, Ancient DNA, Panspermia, and Aliens — Betül Kaçar
  …
  0.0260  vector+fts 2024-08-19  Mindscape #286 Blaise Agüera y Arcas on the Emergence of Replication and Computation — Blaise Agüera y Arcas

── asOf(2020-01-01) — the graph as it stood then ─────────────────────────
  episode   142 then,  952 now
  person    132 then,  753 now
  topic     260 then, 1452 now
  sponsor     0 then,  135 now
  top topics then: Deep Learning (5), Consciousness (4), Reality (3), Language (3), …

── diff(2024-01-01, 2024-12-31) — what the year added ────────────────────
  100 episodes, 79 first-time guests, 169 new topics, 10 new sponsors
  first-timers: Ricard Solé, Sanjana Curtis, Tal Wilkenfeld, Eric Schwitzgebel, Matthew Cox, …

── "Carlo Rovelli" ⇄ "Joe Rogan" over appearedOn + mentions + about ──────
  Carlo Rovelli
    ↳ 2018-07-10  Mindscape #2 Carlo Rovelli on Quantum Mechanics, Spacetime, and Reality
  topic: Quantum Mechanics
    ↳ 2024-04-22  Lex #428 Sean Carroll: General Relativity, Quantum Mechanics, Black Holes & Aliens
  topic: Aliens
    ↳ 2022-01-18  Lex #257 Brian Keating: Cosmology, Astrophysics, Aliens & Losing the Nobel Prize
  Joe Rogan
  6 hops

── pagerank over appearedOn + mentions + about — the most central people ─
  3.41e-3  Elon Musk
  3.34e-3  Joe Rogan
  1.76e-3  Donald Trump
  …

── sponsors: episode -sponsoredBy-> sponsor, longest-running first ───────
  117  BetterHelp         2020-07-21 → 2026-09-17
  105  Eight Sleep        2020-07-18 → 2025-01-06
  103  ExpressVPN         2020-03-16 → 2024-09-12
  …
```

## Files

| File                    | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `podcasts/index.ts`     | The shows in the graph                                                          |
| `podcasts/source.ts`    | The `Podcast` contract and the fetch every show uses                            |
| `podcasts/lex.ts`       | Lex: feed + page parsers, sponsors, chapters, dropped-episode recovery, scrape  |
| `podcasts/mindscape.ts` | Mindscape: feed + sitemap parsers, titles, taglines, post matching, scrape      |
| `parse.ts`              | Shared: the `Episode` shape, text helpers, name/topic splitting, the RSS parser |
| `scrape.ts`             | Scrapes every show (or `--podcast`) into `data/<podcast>/episodes.json`         |
| `schema.ts`             | The graph schema (`graphx/core` only)                                           |
| `graphx.config.ts`      | Schema + embedder for the scripts and the `graphx` CLI                          |
| `dataset.ts`            | Episodes of every show → planned nodes and edges with their valid-from dates    |
| `load.ts`               | Idempotent sync of a plan into libSQL                                           |
| `queries.ts`            | The demo queries                                                                |
| `api.ts`, `server.ts`   | The Atlas API and the dev server                                                |
| `fixtures.ts`           | Both shows' fixtures as episodes, for the tests                                 |
| `*.test.ts`             | Lex parsers, Mindscape parsers, plan and loader, API — all against `fixtures/`  |

The episode titles, descriptions and guest names belong to Lex Fridman and Sean Carroll. The
scrape stays in `data/` (gitignored). `fixtures/` keeps small excerpts so the tests run offline.
