# MTG / GraphX

```sh
# From the monorepo root
bun install
bun run dev:mtg
```

Opens on `http://127.0.0.1:8795`. If that port is occupied, the launcher selects the next available port. Requires Node.js 22+, Bun and a built workspace GraphX package (`bun run build` from the repository root).

The app uses a collapsible sidebar, a mobile navigation sheet and neutral workspace surfaces. `⌘K` or `/` focuses card search; `⌘B` toggles navigation. Decks and their revisions persist in `mtg.db`. No API keys are required.

## Workspace tools

The interface follows the neighboring Frogpoint app's neutral surfaces, spacing, borders and status colors. Geist Sans and Geist Mono are served locally. Phones have bottom navigation; the catalog has persistent grid/list and comfortable/compact settings.

- Save named searches, star up to 100 favorite cards, and compare up to three cards side by side. Search filters and pagination persist in the URL. A deck-filter link includes its deck ID; opening it restores that deck when available. Named searches, favorites, density and the active deck persist in this browser. Open **Saved searches** in the catalog's deck panel to recall or remove a search.
- Filter by derived role, maximum USD price, favorites or active-deck legality. The active-deck filter also checks an assigned commander's color identity. Select the target deck and mainboard, sideboard or maybeboard before using +. Results show copies already on each board. A maximum-price filter excludes cards with no recorded price.
- Duplicate a deck, search its cards, group by type or mana value, and sort by name, mana value, quantity or price. Undo and redo retain the last 30 successful edits per deck for the current session and save new server revisions. A new edit clears redo; failed saves preserve the history stacks. Reloading clears session undo history; server revision history remains available.
- Budget totals weight quantities across mainboard, sideboard and commander, exclude maybeboard, and identify unpriced copies and snapshot dates. Analysis includes exact land-count probabilities by turn with play/draw selection, opening-hand summaries, and validation filters with links to affected cards. Card details can copy a URL that reopens the card on reload.

The [30-improvement spec](../../docs/mtg-workspace-upgrades.md) lists the shipped behavior. A price is for the imported Scryfall printing, not the cheapest available printing. The land table assumes a seven-card opener and uniform draws with no mulligans, extra draw effects or sequencing; its draw setting also applies to multiplayer Commander. It counts first-face lands.

## Load the catalog

```sh
cd examples/mtg-graph
bun run download
bun run ingest
bun run dev
```

`download` installs 15 canonical MTGJSON sources for one release. Each compressed archive is checked against upstream SHA-256; verified archives are cached, mixed releases are rejected, and ordinary publication failures roll back. Requires `xz` and `tar`. Existing Scryfall image metadata is reused; a fresh checkout downloads one image/price enrichment snapshot. Stop the app before importing and restart afterward.

`ingest` streams the full sources into `catalog.db`, preserving every source field. It compares exact set and deck IDs against `SetList` and `DeckList`, and matches every printing/token UUID against `AllIdentifiers` before publishing the database. `mtg.db` retains the GraphX oracle graph, all set nodes, published-deck nodes and memberships, and your saved decks with their revisions. Repeat graph imports write only changed facts.

The installed October 18, 2026 release contains:

| Catalog                                               |            Imported records |
| ----------------------------------------------------- | --------------------------: |
| Sets / published decks                                |                 878 / 3,130 |
| Printings / tokens / sealed products                  |     114,855 / 9,150 / 4,260 |
| Atomic names / graph card identities                  |             35,124 / 35,070 |
| Price histories / current-price records               |           113,186 / 112,963 |
| Identifier records / SKU groups / Cardmarket mappings | 124,005 / 115,295 / 113,431 |

Atomic names normalize to 35,053 identities; 17 challenge-deck cards absent from AtomicCards are supplied by the published decks. Reversible aliases such as `Island // Island` merge into one identity. Counts describe records supplied by this release; a card without upstream prices does not acquire an invented price. The complete database has 746,284 source records, including seven reference documents.

Open **Library** to browse every set, published deck, printing, token, sealed product, identifier, price record, SKU group and reference document. Catalogs have dedicated `/library/{kind}` pages; each record opens at `/library/{kind}/{id}`. Search, filters and pagination persist in the URL, and record links return to the same list. Deck detail pages show only populated boards, with card search and links to individual card pages. Source metadata sits beside the card list on desktop and below it on mobile. Search by name or ID, filter by set/type, and use pagination or enter a page number. Set details link to their printings, tokens, products and decks. **All source fields** exposes the unmodified record. Deck details retain every source board, all commanders and tokens. **Copy and open deck** creates a separate editable deck; unsupported multiple commanders, planes and schemes produce an error instead of discarding cards.

**Library → Coverage**, `/api/v1/coverage` and `/api/v1/status` report per-source expected/imported counts, checksums and the installed release. A snapshot or an oracle-only import is never labeled complete. Alternate compression formats and format-specific subsets are redundant representations of these sources. Downloads, images and databases are ignored by Git; the checked-in 165-card snapshot still works without a full download.

## Search

```text
t:creature mv<=2 c:u f:modern
o:"draw a card" -t:land
id=ub
k:flying s:mh3
```

`c:` matches colors; `id:` matches color identity; `=` requires an exact set. `c:c` selects colorless cards. Combine filters with spaces; prefix a token with `-` to exclude it. Bare words search names, aliases and oracle text. Quoted text stays together. Unknown operators and invalid numeric filters return HTTP 400.

Cards expose all faces, rulings, format legalities, printing set codes, derived roles and related graph neighbors. Images are fetched from Scryfall through a local disk cache. Prices describe the selected Scryfall printing at the stated snapshot date.

## Build and analyze decks

Create a deck, select a format and add cards from search. Edit quantities or move entries between mainboard, sideboard and maybeboard. Commander decks can promote an eligible card from its row menu. Text import recognizes `Deck`, `Sideboard`, `Maybeboard` and `Commander` sections; unrecognized lines must be corrected before import. Export supports copying and `.txt` downloads. History can compare and restore previous contents; saves require the current revision to prevent overwriting changes from another tab.

Analysis returns quantity-weighted mana curves, card types, colored pips across castable faces, land identities, text-derived roles and deck validation. The probability calculator uses the exact hypergeometric distribution. The hand sampler uses a cryptographically shuffled mainboard; the UI supports selecting cards to bottom after London mulligans.

Graph suggestions use shared keywords, subtypes and roles, weighted by inverse feature frequency, with evidence in each result. Deck suggestions exclude existing cards, lands, illegal cards and cards outside the deck's color identity. Path finding uses GraphX's CSR snapshot with undirected traversal over feature edges, capped at six hops and 10,000 explored nodes.

## Explore relationships

Open **Graph explorer** to render card images on a pannable, zoomable canvas. Drag the background or scroll to pan, pinch to zoom, or use the zoom controls. Drag cards to arrange them; **Fit graph to view** fits the loaded graph, and **Re-layout** resets positions. The minimap supports navigation. Expand the workspace with the top-right button; Escape restores the page.

**Cards** connects cards through labeled shared features. Select an edge to inspect its supporting roles, keywords, or subtypes. These connections do not establish combos. **Features** displays the persisted feature nodes and their typed edges. Selecting a card preserves the root and opens its preview, rules text, and connections. **Expand connections** loads that card's neighborhood into the current canvas; **Make root card** starts a new graph. The card details button opens the existing detail drawer.

Toggle relationship types above the canvas. **Filters** combines name/rules text, color, card type, format legality, and maximum mana value across loaded cards; the root remains visible. Counts distinguish visible and loaded cards. **Neighbors** loads 8, 16, 24, or 40 related cards per expansion. The loaded canvas is capped at 240 nodes. Card images, edge labels, and the minimap can be toggled independently. Missing images use the card name, mana cost, and type fallback.

**Find path** changes the search field into a destination picker. The resulting canvas displays the shortest path's card images, feature nodes, and persisted edges, including cards outside the loaded neighborhood. Card filters are paused while the path is displayed. **Clear path** restores the neighborhood. Expanding a card from a path retains its connecting path in Features view. Nodes and edges support keyboard selection with Enter or Space; arrow keys reposition focused nodes.

## API

Open the API console in the sidebar or fetch `/api/openapi.json` for the generated contract. All JSON responses use `Cache-Control: no-store`. Browser mutations must originate from the same host. This is a local single-user service; add authentication and tenant isolation before public hosting.

| Method    | Path under `/api/v1`                                                                             | Returns                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET       | `/coverage`                                                                                      | Per-source release, checksum and expected/imported counts                                                                                                                                                                                |
| GET       | `/library/{kind}?q=&set=&type=&oracleId=&page=&limit=`                                           | Paginated source records; limit 1–100                                                                                                                                                                                                    |
| GET       | `/library/{kind}/{id}`                                                                           | Complete source record with `_catalog` identifier                                                                                                                                                                                        |
| POST      | `/library/decks/{id}/copy`                                                                       | Editable copy; body `{ "format": "commander" }`                                                                                                                                                                                          |
| GET       | `/status`, `/schema`                                                                             | Dataset provenance, graph counts, typed node/edge definitions                                                                                                                                                                            |
| GET       | `/cards?q=&format=&color=&type=&role=&maxPrice=&deckId=&ids=&sort=&page=&limit=`                 | Search with pagination; `limit` is 1–100. `deckId` applies that deck's format and assigned Commander identity; `ids` is a comma-separated favorite-card allowlist (empty means no results). `sort` is `name`, `mana`, `rank` or `price`. |
| GET       | `/cards/{id}`, `/cards/{id}/similar`                                                             | Card details and evidence-bearing neighbors                                                                                                                                                                                              |
| GET       | `/graph/{id}?rel=&limit=`, `/path?from=&to=`                                                     | Typed neighborhood or bounded shortest feature path, including card data and renderable nodes/edges                                                                                                                                      |
| GET, POST | `/decks`                                                                                         | Saved decks or create a deck                                                                                                                                                                                                             |
| GET, PUT  | `/decks/{id}`                                                                                    | Read or save; PUT requires `revision`                                                                                                                                                                                                    |
| GET       | `/decks/{id}/analysis`, `/decks/{id}/recommendations`                                            | Deck metrics, validation and suggestions                                                                                                                                                                                                 |
| GET       | `/decks/{id}/history`, `/decks/{id}/compare?revision=`, `/decks/{id}/export`, `/decks/{id}/hand` | Temporal revisions, text list or seven sampled cards                                                                                                                                                                                     |
| POST      | `/import`                                                                                        | Parse `{ "text": "4 Counterspell" }`; returns unknown lines                                                                                                                                                                              |
| POST      | `/probability`                                                                                   | Exact hit probability and distribution                                                                                                                                                                                                   |

```sh
curl http://127.0.0.1:8795/api/v1/probability \
  -H 'Content-Type: application/json' \
  -d '{"population":60,"successes":4,"draws":7,"minimum":1}'
```

Graph `rel` accepts one relation name or a comma-separated list. `limit` bounds related cards from 1 to 40 (default 8). Neighborhoods cap each relationship at 60 outgoing edges and the root at 120 outgoing edges; `truncated` identifies that cap and `moreCards` identifies additional related cards.

For programmatic access, use the returned card IDs verbatim. Deck entries are `{ cardId, quantity, board }`, where `board` is `main`, `side` or `maybe`.

## Graph structure

`src/schema.ts` defines card, keyword, subtype, color, format, set, role, deck and dataset nodes. Typed edges store keywords, subtypes, identities, legalities, printings, role evidence and deck membership. Each deck save atomically updates both the deck node and its `contains` edges. GraphX retains bitemporal versions; history presents the current belief about each historical state.

`src/library.ts` stores and queries unmodified source records; `src/library-graph.ts` reconciles published decks and complete set metadata. `src/ingest.ts` owns canonicalization and reconciliation. `src/search.ts` owns search syntax. `src/analysis.ts` contains probabilities and legality checks. `src/decks.ts` owns deck mutations. `src/graph.ts` owns similarity, neighborhoods and paths. The UI calls the versioned API in `src/api.ts`.

## Limits

Roles are text rules with evidence, not a rules interpreter. Shared graph neighbors do not prove a combo. The app has no tournament-result feed or matchup win rates. Legality reflects the imported release; validation covers the listed formats' size, copy limits, restricted cards and a single commander's eligibility and identity. Partner commanders, companions, Commander brackets, printed custom deck restrictions and comprehensive rules exceptions need additional validators. Land color identities are not guaranteed mana production. Probabilities do not model sequencing or automated keep decisions. Printing-specific collector numbers, finishes, foreign data and purchase identifiers are available in the Library. Workspace budget totals continue to use the Scryfall printing snapshot; the complete MTGJSON vendor price history is available as source records in the Library.

## Verify

```sh
bun run test
bun run type-check
bun run build
bun run verify-data --repeat
```

`verify-data` compares the live graph with the source indexes, checks all 3,130 deck payloads field for field and detects dangling published relationships. `--repeat` forces two graph imports and confirms that the second writes no new versions and that saved-deck history is unchanged.

Tests use private in-memory GraphX databases. They cover exact probability examples and boundaries, query validation, faces and oracle aliases, repeat imports, graph relationships, deck persistence, revision conflicts, import errors, origin validation and the generated OpenAPI document. Browser evidence is saved locally under ignored `artifacts/`.

Data: [MTGJSON FAQ](https://mtgjson.com/faq/), [Atomic card model](https://mtgjson.com/data-models/card/card-atomic/), [MTGJSON license](https://mtgjson.com/license/), [Scryfall bulk data](https://scryfall.com/docs/api/bulk-data). Magic card imagery belongs to Wizards of the Coast and its artists.
