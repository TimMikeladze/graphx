# Dedicated library pages

The catalog detail modal puts hundreds of cards inside a constrained scroll area and displays empty Commander sections ahead of the useful content. Replace every catalog record modal with a dedicated Next.js page. Keep existing saved-deck editing and graph workflows.

Routes: `/library` opens sets, `/library/{kind}` lists a catalog, and `/library/{kind}/{id}` opens a record. Coverage has `/library/coverage`. Validate route kinds and segment counts; record IDs remain safely URL encoded. Root `#library` links continue to reach the new library. Sidebar and mobile navigation use the new route. Pages share the existing workspace shell.

List search, set/type filters, row count and page number live in the query string. Clicking a record preserves the exact list URL as a validated local return path. Reload, browser back/forward and links opened in a new tab restore the expected view. Internal links use Next Link and keep standard modifier-click behavior.

A record page has a breadcrumb, one title, a compact action row, and a wide primary content area. Deck pages show only nonempty boards as counted tabs, defaulting to the mainboard. Board search filters names and card details; rows link to individual card records. An overview beside the list holds set, product type and release date. Empty sections never displace the card list. Source JSON and less-used metadata stay in disclosures. All source fields and boards remain accessible. Copying a compatible deck opens it in the existing saved-deck workspace, retaining unsupported-deck errors.

Use the existing neutral surfaces, typefaces and borders. At mobile width, the overview follows the card list, actions wrap, and navigation remains usable without page-wide horizontal overflow. Scroll the document instead of a tall modal. Loading, missing-record and fetch-error views retain a link to the library.

## Implementation

1. Add and test URL/state helpers and nonempty-board discovery, including Unicode IDs, unsafe return paths and unknown card-board arrays.
2. Add the library route and connect list links, workspace navigation and URL-persisted filters. Remove modal detail rendering.
3. Build record pages with compact actions, board navigation/search, card links and a metadata sidebar. Preserve all source data and copy behavior.
4. Verify the exact Aether Revolt Redemption example, refresh/back/list context, an empty/missing record, copy navigation and mobile layout. Run the example suite, type-check and production build; save before/after screenshots.

## Verification

The Aether Revolt Redemption record now opens at `/library/decks/AetherRevoltRedemption_AER`. Its 184 entries are in the main page; empty Commander/display Commander/sideboard/token sections are omitted. Card search updates `cardSearch` in the URL and survives refresh. A filtered deck list with `q=Aether&limit=1&page=2` retains its exact query, row count and page when returning from a record. Individual card links preserve the parent deck URL. Unknown kinds and missing records return HTTP 404.

The workspace shell lives in the root layout so active deck and undo/redo state persist across routes. Desktop and mobile navigation use links; the brand points to `/#cards`. Legacy `#library` URLs reach the new catalog. A browser copy check opened Aether Drifters Foil Edition as a separate five-card saved deck.

Before/after screenshots are in ignored `examples/mtg-graph/artifacts/library-page-before.png`, `library-page-after-desktop.png` and `library-page-after-mobile.png`. Mobile was checked at a 390-pixel viewport without horizontal page overflow. The example suite has 54 passing tests, including URL encoding, unsafe return paths, list state and nonempty/custom board discovery; type-check and production build pass.

Next.js catch-all parameters can retain URL encoding. Record resolution checks the exact ID first, then decodes once if needed. `/library/atomic/Wear%20%2F%2F%20Tear` opens the split card, while names containing literal percent sequences retain their exact lookup.

The production preview runs on `http://127.0.0.1:8797` using `.next-pages-build`, leaving the existing servers running. Its deck page renders all 184 rows without a dialog; searching Aetherwind leaves one result and survives reload. The split-card and reference pages return HTTP 200; a missing deck returns HTTP 404.
