# MTG graph

## Product

An expert workspace for searching the MTGJSON catalog, constructing decks, inspecting relationships and calculating deck consistency. Lives in `examples/mtg-graph`, uses the workspace GraphX package, runs without API keys. Black and white UI, compact tables, keyboard search, a shadcn-style collapsible sidebar, breadcrumbs and a mobile navigation sheet. No landing page or promotional copy.

## Data and graph

Import AtomicCards from MTGJSON with download checksum verification and release metadata. A checked-in small snapshot makes a fresh checkout useful offline; downloading the full release replaces catalog coverage. Atomic identities use Scryfall oracle IDs, with deterministic name fallback; faces remain attached to the same card. Printing and prices are separate optional imports, never invented. Include source URLs, release date and coverage in API responses and UI.

Graph nodes: card, keyword, subtype, color, format, set, role, deck, dataset. Edges: has_keyword, has_subtype, has_color, legal_in, printed_in, fills_role, contains, related_to. `contains` has quantity and board. Store cards, deck revisions and relationships through GraphX's temporal mutations. Import idempotently using stable identifiers. Derive role edges with versioned, inspectable text rules. Shared-neighbor traversal supports similarity and deck recommendations, with explicit shared evidence; no claims that shared keywords prove a combo.

## Workflows

- Explore: name/oracle search plus `t:`, `o:`, `c:`, `id:`, `mv` comparisons, `f:`, `k:`, `s:`; color/type/format filters, sort, pagination, card details, all faces, rulings, printings, legalities, related cards and add to a deck.
- Decks: create, rename, format, commander assignment, main/sideboard, quantity changes, text import/export, persistent saved decks, revision history and comparison. Import reports unknown lines rather than discarding them. Starter lists demonstrate the workflows, never tournament results.
- Analyze: quantity-weighted curve, types, colored pip demand, roles, legality, minimum size, copy limits, commander identity, exact hypergeometric draw/land probabilities, opening-hand simulator with shuffle and mulligan, graph suggestions with evidence.
- Graph: card-centered typed neighborhood, relation filters, selectable nodes, bounded expansion and shortest paths. Shared-neighbor similarity and deck membership reuse the persisted graph.
- API: versioned REST for cards, graph, decks, import/export, analysis, probability, history, dataset status, generated OpenAPI, interactive request runner and the GraphX native API. Input validation, bounded pagination/traversal, structured errors.

## Architecture

Next.js App Router UI and same-origin route handlers. GraphX/libSQL stores the graph locally; the process shares a boot promise. Dataset download is an explicit script, not a network dependency per request. Server modules own ingest, queries, search, decks and mathematics; client components call the public domain API. No browser-local fake backend. Start on a free port, preserve other running apps.

## Accuracy and boundaries

MTGJSON supplies cards, rules text, legalities, sets and rulings. Its catalog does not supply matchup win rates, game simulation, complete combo execution or tournament metagame data. Do not render fabricated prices, win rates, popularity percentages, synergy percentages or verified combo claims. Recommendations report shared graph neighbors and a deterministic score. Analytical probabilities assume uniform sampling without replacement; they do not model play decisions or an opening-hand selection policy. Multi-face mana values, basic lands, restricted cards and commander identity require explicit tests. Legality is only as current as the imported release. This is a local, single-user workspace; public hosting requires authentication and tenant isolation before exposing writes.

## Implementation and verification

1. Build schema, normalized importer, checksum download and offline snapshot. Test stable identities, faces, idempotence and graph edges.
2. Build the domain API and exact analysis. Test search grammar, invalid inputs, quantity/board changes, stale revisions, legality, probability boundaries and persistence.
3. Build the responsive expert UI: explorer, deck editor, analysis, graph and API console. Empty states and errors remain actionable.
4. Run tests, type-check and production build. Start the app and exercise live API requests.
5. Verify desktop/mobile in browser-use, including search, card details, deck edits, import/export and analysis; document commands and actual coverage.
