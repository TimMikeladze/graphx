# Complete MTGJSON catalog

Goal: install every canonical MTGJSON dataset for the same release and expose all sets and published decks in the app. Preserve every source field, including printing variants, tokens, sealed product contents, booster definitions, foreign data, identifiers, price history and SKUs. Compressed and alternate-format copies and format-specific subsets are redundant representations, not additional datasets.

Download AtomicCards, AllPrintings, AllDeckFiles, AllIdentifiers, AllPrices, AllPricesToday, TcgplayerSkus, CardmarketIdentifiers, SetList, DeckList, CardTypes, Keywords, EnumValues, CompiledList and Meta. Check upstream SHA-256, preserve an installed release on failure, and record a manifest with release, source, size and checksum. Keep Scryfall image enrichment.

Store unmodified records in a separate indexed catalog.db so large printing and price data never become an in-memory browser payload. The existing mtg.db keeps GraphX oracle relationships and user decks; enrich its set nodes from the full catalog, and persist published deck nodes and membership relationships separately from editable decks. All source decks retain every board and all commanders. Copying into the current editor must report unsupported commanders or unresolved cards rather than silently drop cards. No user decks or revisions are overwritten.

API: GET /api/v1/library/{kind}?q=&set=&type=&page=&limit= returns {items,total,page,limit,pages}; items are summaries {id,name,setCode,type,releaseDate,cardCount}. GET /api/v1/library/{kind}/{id} returns the unmodified source data plus \_catalog:{id,kind}. Kinds: sets, decks, printings, tokens, sealed, identifiers, prices, pricesToday, skus, atomic, cardmarket, reference. GET /api/v1/coverage returns {complete,release,datasets,counts,issues}; each dataset has {name,expected,imported,complete,date,sha256}. POST /api/v1/library/decks/{id}/copy takes {format} and returns an editable DeckRecord, or a descriptive 400 if the editor cannot represent the source. Coverage compares independent source indexes to imported IDs and never substitutes oracle-card coverage for catalog coverage.

UI: add a Library view with sets, published decks, printings, tokens, sealed products and coverage. Search and pagination reach every record. Details preserve and display all source fields, with deck boards readable and a copy-to-workspace action. Keep current saved decks separate and unchanged. Responsive layout follows existing neutral surfaces.

## Implementation plan

1. Download module and tests: checksum validation, resumable verified cache, release consistency, safe extraction, manifest, all canonical source files. Download actual release.
2. Catalog importer and tests: stream large JSON, indexed lossless records, expected counts, atomic publish, repeat import; enrich GraphX without deleting saved decks. Library API and input validation.
3. Library UI: catalog search, pagination, source details, coverage and copy action; integrate sidebar and mobile navigation.
4. Import installed release, compare exact set/deck ID sets, all counts and unresolved references. Verify repeated import does not mutate user decks.
5. Run example tests, type-check and production build. Use browser to verify full set/deck browsing, details, copy and mobile layout. Write measured results into this document and README.

## Installed verification

Release `2026-10-18`, version `5.3.0+20261018`: all 15 canonical source checksums verified; 474,407,184 compressed bytes downloaded. The indexed catalog contains 746,284 records in `examples/mtg-graph/catalog.db`.

| Kind                  |   Count |
| --------------------- | ------: |
| Sets                  |     878 |
| Published decks       |   3,130 |
| Printings             | 114,855 |
| Tokens                |   9,150 |
| Sealed products       |   4,260 |
| Atomic names          |  35,124 |
| Identifiers           | 124,005 |
| Price histories       | 113,186 |
| Current-price records | 112,963 |
| SKU groups            | 115,295 |
| Cardmarket mappings   | 113,431 |
| Reference documents   |       7 |

`bun run verify-data --repeat` checks exact graph set/deck ID sets against MTGJSON indexes, every imported deck payload against its source JSON, and dangling published graph edges. All 3,130 payloads match, no published relationships dangle, repeated graph import writes no new node/edge versions, and saved-deck history remains unchanged. The graph has 35,070 card identities: 35,053 from AtomicCards plus 17 challenge-deck cards supplied by the published decks. These supplemental cards retain their printing memberships.

The full source is available for all decks. The existing editor can represent 3,102 decks; it rejects the other 28 without altering them: five have multiple commanders, 14 have planes, and nine have schemes. Those source boards and all tokens remain readable in Library. No tournament-result or community deck feed is implied by the MTGJSON catalog.

The checked-in snapshot remains available without downloads. Ingest streams large JSON instead of loading the entire catalog into memory, stages a new catalog database, and refuses publication when indexed IDs or printing/token identifiers differ. Regression tests cover Unicode filename normalization on macOS, preserving the prior catalog on failure, per-kind paging/filtering, copying quantities/boards, and preserving saved supplemental cards and their relationships across refreshes.

Evidence lives under ignored `examples/mtg-graph/artifacts/`: `data-verification.log`, `coverage.json`, HTTP coverage/status snapshots, build/typecheck/test logs and browser screenshots. Browser checks exercised set search, source details, published deck search, readable boards, and copying Arcanis's Guile into a new 40-card saved deck. The original two saved decks were preserved.

Final checks: 49 tests pass (210 assertions); type-check and production build pass. Production endpoints on port 8796 report complete coverage and expose the last set/deck pages. Mobile Library layout was checked at a 390-pixel viewport. Development and production builds use separate output directories so validation does not replace the running development bundle.
