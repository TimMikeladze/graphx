# mma-graph

Every fighter, every fight, every promotion, across time — a complete MMA data app built by
scraping Wikipedia into a markdown vault, ingesting it with `graphx/ingest`, and serving it from
a **Next.js** app: a server-component dashboard, a temporal domain API, and graphx's generated
HTTP surface, all in one process.

The stack is exactly three things — **Next.js** (App Router: pages + route handlers),
**graphx** (graph, ingest, generated routes), and a **YAML/markdown vault** (the durable source
of truth). No standalone server process, no bespoke HTTP layer in the example.

```sh
bun install                    # repo root
bun scrape.ts full             # ~15 min: both fighter lists → every article → vault
bun run dev                    # http://localhost:8793 — Next.js dev server
```

Short on time? `bun scrape.ts fighters --limit 25` builds a small slice; `bun scrape.ts tail`
keeps it fresh (below). The corpus: ~3.2k articles from _List of male/female mixed martial
artists_ plus closure over their linked opponents — every fighter with a Wikipedia record table —
~30k+ fights across UFC, PRIDE, Strikeforce, Bellator, PFL, WEC, One, Rizin and the small shows,
with result, method, round, time, event, location and championship notes, plus event articles
(date, venue, city, attendance, gate) and fighter bios.

## Why a vault

The pipeline is markdown-driven end to end: `scrape.ts` writes `vault/fighter/*.md`,
`vault/fight/*.md`, `vault/event/*.md` (1 file = 1 node, frontmatter is node data, wikilinks are
edges), and `ingestDir` reconciles it into the graph — re-runs are content-hash diffs, changed
files become new bitemporal versions, vanished files are retracted (`prune`). The raw wikitext is
cached under `.cache/` so re-emits never touch the network.

Fight files carry the graph in their frontmatter:

```yaml
---
id: bj-penn__vs__frankie-edgar__2010-04-10
result: win
method: Decision (unanimous)
finish: decision
title: { name: UFC Lightweight Championship, outcome: won }
winner: '[[frankie-edgar]]' # → won edge
loser: '[[bj-penn]]' # → lost edge
event: '[[ufc-112]]' # → part_of edge
---
```

Career stats on every fighter (`derived`) are computed **from the graph itself** after ingest —
so opponents with no Wikipedia article (stub fighters, `stub: true`) get complete records derived
from the fights they appear in.

## Scraping often: the tail

The scrapers are a reusable library (`src/wiki.ts`: disk cache, batching, rate limiting, retries,
recentchanges), not a one-shot script.

| Command                                          | What it does                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun scrape.ts full`                             | base corpus + event enrichment                                                                                                                                                        |
| `bun scrape.ts fighters [--limit N] [--fresh]`   | just the fighter corpus (waves to closure)                                                                                                                                            |
| `bun scrape.ts events`                           | refetch event articles referenced by fights                                                                                                                                           |
| `bun scrape.ts tail [--since ISO] [--watch 300]` | recentchanges since the watermark → refetch changed fighters/events → re-emit                                                                                                         |
| `bun scrape.ts event "UFC 909" [--interval 30]`  | poll one card's article while it happens — results land on Wikipedia in minutes, and every re-ingest is a new bitemporal version of the fight node: the card unfolds as graph history |

All outbound traffic uses a plain browser User-Agent with no identifying information, batches 50
titles per request, spaces requests ~1.2s apart and backs off hard on 429/5xx.

## The Next.js app

One App Router app serves everything (`next dev`, port 8793):

- **`instrumentation.ts` + `src/server/runtime.ts`** — the per-process graphx server. On boot it
  fingerprints the inputs (scrape-state mtime + newest vault folder mtime + schema version +
  embedder id — `FRESH=1` forces a rebuild), then boots graphx's dev-mode `createApp` (in-memory
  control plane, one tenant/project, header auth — NOT for production), and on a changed vault
  runs `ingestVault` (ingestDir + derived-stats pass) into `mma_demo.db`. Unchanged fingerprint ⇒
  the cached db is served as-is. The boot promise lives on `globalThis` (Next dev gives each
  route its own module registry) so every request shares one boot.
- **Server-component pages read the graph in-process** — no HTTP hop: `/` (stats, latest results,
  mini leaderboards), `/fighters`, `/fighter/[id]` (career + full fight history + a **record
  time-travel** slider over `/api/record`), `/champions` (belt grid with a date slider over
  `/api/champions` + the full reign timeline), `/leaders?metric=`, `/h2h` (a plain GET form →
  server-rendered head-to-head).
- **`app/api/**/route.ts`\*\* — the domain API as Next route handlers over the same query layer:

| Route                                                    | Returns                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/stats`                                         | corpus counts + latest results                                    |
| `GET /api/search?q=`                                     | full-text fighter search                                          |
| `GET /api/fighters/:id`                                  | bio + career + `derived` win stats                                |
| `GET /api/fighters/:id/fights`                           | chronological fight list with opponents and outcomes              |
| `GET /api/record?id=&asOf=YYYY-MM-DD`                    | **time travel** — the record as it stood on any date              |
| `GET /api/head2head?a=&b=`                               | pair history                                                      |
| `GET /api/events/:id`                                    | card + results                                                    |
| `GET /api/leaderboard?metric=wins\|ko_wins\|sub_wins\|…` | top fighters                                                      |
| `GET /api/champions[?asOf=][&reigns=1]`                  | who held which belt when — reigns reconstructed from title fights |

- **`app/[...gx]/route.ts`** — the graphx-generated surface mounted as the root catch-all (static
  routes and pages take precedence): `/t/{tenant}/p/{project}/…` (nodes, edges, retrieval, match,
  algorithms, CDC…), OpenAPI at `/openapi.json`, interactive docs at `/docs`, GraphQL at `/graphql`, `/health`, `/ready`,
  the `GET /demo` bootstrap payload, and `/admin/…` (the control-plane app). Dev auth is
  graphx's header mode (`x-user`/`x-tenant` via `/demo`) — the old static bearer token is gone.

## Scope and limits

- Per-fight striking stats (ufcstats.com) are **out of scope**: the site sits behind a JS
  anti-bot challenge and public mirrors are years stale. The fight schema has room for a `stats`
  block when a source appears.
- Championship reigns come only from title fights: vacated/stripped belts are invisible, a belt
  shows its last winner until the next title fight.
- A handful of early one-night-tournament fights carry no date — they ingest without one.
- The same card can appear under two names across fighters' tables (e.g. `UFC on FX 2` vs
  `UFC on FX: Alves vs. Kampmann`); those stay separate events.

## Layout

- `src/wiki.ts` — MediaWiki client (cache/rate-limit/retries/recentchanges)
- `src/parse.ts` — pure wikitext → records (heavily fixture-tested; no I/O)
- `src/vault.ts` — identity (stable slugs, stub fighters, fight dedup+merge) + markdown emit
- `src/schema.ts` — the graphx schema; `src/load.ts` — ingest + derived-stats pass
- `src/server/runtime.ts` — the graphx singleton behind the app; `src/server/queries.ts` — the
  domain query layer shared by pages and `/api` handlers
- `scrape.ts` — the CLI; `app/` + `components/` — the Next.js UI; `instrumentation.ts` — boot hook
- `tests/` — parser fixtures (checked-in wikitext slices), vault unit tests, end-to-end
  fixture→vault→graph→queries test — no network
