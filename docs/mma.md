# mma-graph — spec

A comprehensive graphx example: an API and dashboard of MMA data across time, built by scraping
Wikipedia into a markdown vault, ingesting it with `graphx/ingest`, and serving it from a **Next.js
App Router** app. The scrapers are a reusable library with incremental tails, not a one-shot
script — we will be scraping often.

The stack is exactly three things: **Next.js** (pages + route handlers — no standalone server
process, no custom HTTP framework in the example), **graphx** (graph, ingest, generated HTTP
surface), and a **YAML/markdown vault** (the durable source of truth the graph is built from).

## Sources (decided)

| Source               | Use                                        | Status                                          |
| -------------------- | ------------------------------------------ | ----------------------------------------------- |
| Wikipedia (en)       | everything: fighters, fights, events, bios | live via `action=api.php`, no auth, no anti-bot |
| ufcstats.com         | per-fight striking stats                   | **rejected** — behind a JS anti-bot challenge   |
| GitHub ufcstats sets | per-fight striking stats                   | **rejected** — mirrors are 5+ years stale       |

Wikipedia is the better corpus anyway: every notable fighter article carries a complete
`{{MMA record start}}` table — every professional fight across every promotion (UFC, PRIDE,
Strikeforce, Bellator, PFL, One, …) with result, method, round, time, event, date, location and
title notes — plus an infobox with career W/L/D breakdowns. "Every fighter" = every article linked
from _List of male mixed martial artists_ (~2.7k) and _List of female mixed martial artists_ (~0.5k),
plus stub opponents who never got an article (see identity).

All outbound requests use a plain browser User-Agent and no identifying headers, and are
rate-limited (default: 3 concurrent, 250 ms spacing) with retries + exponential backoff.

## Pipeline

```
scrape.ts ──▶ src/wiki.ts ──▶ .cache/ (raw wikitext, resumable)
    │             (batched action API, disk cache, rate limit, retries)
    ├──▶ src/parse.ts ──▶ structured { fighter bio, fight rows[], event meta }
    ├──▶ src/vault.ts ──▶ vault/ markdown files (1 file = 1 node)
    └──▶ Next.js server (src/server/runtime.ts)
              └─▶ ingestDir(vault) ──▶ derived-stats pass ──▶ graphx createApp
                        ──▶ RSC pages (in-process graph reads)
                        ──▶ /api route handlers (same queries over HTTP)
                        ──▶ /t/… + /openapi.json + /docs (graphx-generated surface)
```

- **`src/wiki.ts`** — MediaWiki client: `getPages(titles[])` (batched 20/req), `getLinks(page)`,
  `getRecentChanges(since)`. Every raw response cached on disk by URL; `--fresh` busts per-key TTL.
- **`src/parse.ts`** — pure functions, wikitext in / records out. Record-table rows: result
  (`Win/Loss/Draw/NC`), opponent (wikilink or plain text), method, event, `{{dts|Y|M|D}}` date,
  round, time, location, notes (title outcomes). Infobox: career breakdown, weight class, team,
  nationality, born. Event articles: date, venue, city, attendance.
- **`src/vault.ts`** — emits the vault. Deterministic slugs, stable ids (see identity), fight dedup,
  stub fighters for article-less opponents. Idempotent: same input ⇒ same bytes, so `ingestDir`
  re-runs are content-hash diffs (unchanged files skipped, edited files become new versions).

### CLI (`scrape.ts`, runnable subcommands — unchanged by the Next.js refactor)

| Command                    | What it does                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| `fighters [--limit N]`     | list pages → every fighter article → wikitext → vault (the base corpus)         |
| `events`                   | every event article referenced by a fight row → venue/city/date/attendance      |
| `full`                     | `fighters` + `events`                                                           |
| `tail [--since ISO]`       | `recentchanges` since watermark → intersect with known titles → refetch changed |
| `tail --watch [SECONDS]`   | loop `tail`, re-emit, re-ingest (keeps the graph minutes-fresh)                 |
| `event "UFC 909" [--live]` | one card: poll its event article + roster during/after the event window         |

The tail story: Wikipedia editors land fight results on event pages in minutes, so a `--live` poll
turns each re-ingest into a new bitemporal version of the fight node — the graph records the card
unfolding as append-only history, which is exactly what graphx is for.

## Vault layout (1 file = 1 node)

```
vault/
  fighter/<id>.md    # id, name, article, stub?, division, team, nationality, born, career W/L/D + method breakdown
  event/<id>.md      # id, name, promotion, date, venue, city, attendance
  fight/<id>.md      # id, date, method, round, time, location, title {name, outcome}, note
```

- fight frontmatter carries the graph: `winner: "[[id]]"` / `loser: "[[id]]"` / `drew: ["[[id]]",
"[[id]]"]` / `event: "[[id]]"` — mapped by `edgeFields` to typed edges.
- fight body is a one-line human summary (`"Jon Jones def. Stipe Miocic via TKO … at UFC 309 …"`) —
  it is the FTS/embedding input.
- fighter body is a short generated bio line — searchable by name/team/division.

### Identity (the load-bearing decisions)

- **Fighter id** = slugified article title with `(fighter)`/`(mixed martial artist)` disambiguators
  stripped; collisions fold the disambiguator back in; a persistent assignment table in scrape state
  makes ids stable across runs. Stub opponents (no article, plain-text in a row) get the same
  treatment — they are real nodes, `stub: true`, and their records are **derived from the graph**
  (they exist as opponents in others' tables). File basename = id, so vault wikilinks resolve by
  unique basename.
- **Fight id** = `<a>__vs__<b>__<date>` (a<b sorted; a pair meets at most once per date). Emitted
  once from the merged pair of rows (both fighters' tables report the fight); the winner's row wins
  conflicts.
- **Event id** = slugified event name; date from rows, venue/city/attendance from `events` phase.
- **Stub → article promotion** (opponent gets an article later): new id ⇒ new node; old stub
  retracted by `prune`. Documented, accepted.

## graphx schema

Nodes: `fighter`, `event`, `fight` (all `.passthrough()` Zod — frontmatter is node data).
Edges: `won` fight→fighter, `lost` fight→fighter, `drew` fight→fighter, `part_of` fight→event.
Bitemporality: ingest versions every change; fight dates in frontmatter give content-time queries;
`asOf` gives write-time history — both axes demoed by the API.

## Serving — Next.js App Router (the refactor)

One Next.js app (`next dev`, port 8793) serves everything. No standalone Bun/Hono server process;
the example itself imports no HTTP framework (graphx's generated app is Hono under the hood, mounted
opaquely through its `fetch`).

- **`src/server/runtime.ts`** — the per-process singleton. Fingerprint-cached build exactly like the
  old server (scrape-state mtime + newest vault dir mtimes + schema version + embedder id; `FRESH=1`
  forces a rebuild), then graphx's dev-mode `createApp({ schema, embedder: hashEmbed(128), db:
'mma_demo' })` bootstraps an in-memory control plane + one tenant/project, followed by
  `ingestVault` (ingestDir + derived-stats pass) on a rebuild. `createAdminApp` is routed under
  `/admin`. Reuse path: ingest skipped, the existing `mma_demo.db` is served as-is.
  `instrumentation.ts` kicks the boot off at server start so no request pays for it, and the boot
  promise lives on `globalThis` (Next dev gives each route entry its own module registry — a plain
  module-level singleton would boot once per route).
- **`src/server/queries.ts`** — the domain layer ported from the old Hono `api.ts`, unchanged in
  substance: fighter-by-slug cache, championship-reign reconstruction cache, recent-fights cache.
  Plain async functions over the `Graph` — consumed directly by pages AND by route handlers.
- **RSC pages** — server components read the graph **in-process** (no HTTP hop): `/` (stats, latest
  results, mini leaderboards), `/fighters`, `/fighter/[id]` (career + fight history + a client-side
  record **time-travel** slider over `/api/record`), `/champions` (client-side `asOf` slider over
  `/api/champions` + server-rendered reign timeline), `/leaders?metric=`, `/h2h` (plain GET form →
  server-rendered head-to-head).
- **`app/api/**/route.ts`\*\* — thin Next route handlers over the same queries, same shapes/semantics
  as before (404 on unknown fighter, 400 on bad metric):

| Route                                          | Returns                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/stats`                               | corpus counts + latest results                                    |
| `GET /api/search?q=`                           | full-text fighter search                                          |
| `GET /api/fighters/:id`                        | bio + career W/L/D + `derived` stats                              |
| `GET /api/fighters/:id/fights`                 | chronological fight list with opponents and outcomes              |
| `GET /api/record?id=&asOf=YYYY-MM-DD`          | **time travel**: record as it stood on any date                   |
| `GET /api/head2head?a=&b=`                     | pair history                                                      |
| `GET /api/events/:id`                          | card + results                                                    |
| `GET /api/leaderboard?metric=wins\|ko_wins\|…` | top fighters                                                      |
| `GET /api/champions[?asOf=][&reigns=1]`        | who held which belt when — reigns reconstructed from title fights |

- **`app/[...gx]/route.ts`** — the graphx-generated HTTP surface mounted as a root catch-all (static
  routes and pages take precedence): `/t/{tenant}/p/{project}/…`, `/health`, `/ready`, `/demo`,
  OpenAPI at `/openapi.json`, interactive docs at `/docs`, and `/admin/…`. Native db packages are
  kept server-external via `serverExternalPackages`.

Dev auth is graphx's dev-mode header auth (`x-user`/`x-tenant`, seeded principal by default) — the
old static bearer token is gone; this is a dev example, not production.

## Tests (no network)

- `parse.test.ts` — wikitext fixtures (checked-in slices: win/loss/draw/NC rows, plain-text
  opponents, `{{dts}}` variants, infoboxes, title notes).
- `vault.test.ts` — slug stability, collision handling, fight dedup/merge, stub emission.
- `load.test.ts` — end-to-end on a tiny fixture vault: ingest, edges, derived stats, time-travel
  records — asserted at the **query layer** (`src/server/queries.ts`), the same functions the pages
  and route handlers call.

## Out of scope (documented in the example README)

- Per-fight striking stats (ufcstats blocked; no fresh mirror) — the fight schema has a `stats`
  slot for a future source.
- Judge scorecards (mmadecisions), odds.
