# MTG workspace upgrades

Build 30 improvements in `examples/mtg-graph`. Use Frogpoint's existing shell, Geist typography, neutral surfaces, 10px radii, compact controls, green success states and accessible focus rings as the visual reference. Preserve the GraphX storage and versioned API. Existing uncommitted work belongs to the user.

## Delivery

- [x] Inspect the app and Frogpoint; capture the desktop baseline.
- [x] Implement discovery and comparison.
- [x] Implement deck editing and analysis tools.
- [x] Apply the shared design and responsive navigation.
- [x] Run tests, type-check, build and desktop/mobile browser checks.

## Improvements

| #   | Behavior                                                            | Area        |
| --- | ------------------------------------------------------------------- | ----------- |
| 1   | Serve Geist Sans and Mono locally, including variable weights       | Design      |
| 2   | Frogpoint neutral backgrounds, borders, spacing and typography      | Design      |
| 3   | Green semantic status badges and readable card mana colors          | Design      |
| 4   | Catalog/deck summary tiles with actual counts                       | Discovery   |
| 5   | Responsive bottom navigation on phones                              | Navigation  |
| 6   | Persistent comfortable/compact table density                        | Design      |
| 7   | Search/filter state in shareable URL parameters                     | Discovery   |
| 8   | Save, recall and remove named searches locally                      | Discovery   |
| 9   | Named MTG query presets                                             | Discovery   |
| 10  | Maximum USD printing-price filter                                   | Search API  |
| 11  | Derived card-role filter                                            | Search API  |
| 12  | Active-deck legality and Commander identity filter                  | Search API  |
| 13  | Individually removable active filter chips                          | Discovery   |
| 14  | Persistent card favorites and favorites-only browsing               | Discovery   |
| 15  | Side-by-side comparison of up to three cards                        | Discovery   |
| 16  | Main/side/maybe copy counts on search results                       | Discovery   |
| 17  | Switch active decks directly from the catalog                       | Decks       |
| 18  | Choose the destination board before adding search results           | Decks       |
| 19  | Price column and price sorting, missing prices last                 | Discovery   |
| 20  | Deck duplication with all boards and commander retained             | Decks       |
| 21  | Session undo for successful deck edits using current revisions      | Decks       |
| 22  | Session redo with redo invalidated by a new edit                    | Decks       |
| 23  | Search within the active deck                                       | Decks       |
| 24  | Deck grouping by type, mana value or no grouping                    | Decks       |
| 25  | Deck sorting by name, mana value, quantity or price                 | Decks       |
| 26  | Quantity-weighted deck budget with missing-price coverage and dates | Decks       |
| 27  | Exact land-drop probabilities by turn with play/draw selection      | Analysis    |
| 28  | Opening-hand land/spell/mana-value summary                          | Analysis    |
| 29  | Filter validation issues by category and inspect affected cards     | Analysis    |
| 30  | Copy a shareable card URL and restore its detail view on reload     | Card detail |

## Boundaries and accuracy

Favorites, searches and density are browser preferences. Decks remain persisted by the server. Favorite filtering happens before pagination. Prices are the imported Scryfall printing's dated USD price; missing prices never count as zero-priced cards. Budget totals exclude maybeboard and include the commander. The deck filter follows imported legality and the selected commander's color identity; it does not certify a complete deck or enforce copy limits during discovery.

Land calculations assume uniform draws without replacement, seven opening cards, no mulligans, and no extra draw effects. On the play skips the turn-one draw; multiplayer Commander defaults to drawing on turn one. First-face lands are used consistently with existing analysis; modal land faces and sequencing are not modeled.

Sources: [Commander rules](https://magic.wizards.com/en/formats/commander), [Scryfall card price fields](https://github.com/scryfall/api-types/blob/main/src/objects/Card/CardFields.ts).

## Implementation

`src/search.ts` owns server-side role, price, identity and favorites filters. `src/workbench.ts` owns pure budget, board-count and deck grouping helpers; tests cover missing prices, commander inclusion, filtering before pagination and quantities. `components/preferences.ts` owns local preferences. `components/explorer.tsx` owns URL state and discovery; comparison is a separate component. Workspace owns deck selection and revision-safe undo/redo. Decks owns editor controls. Analysis owns the new probability table and validation controls, using existing exact probability mathematics. `app/workbench.css` applies the Frogpoint design after the original stylesheet without changing other examples.

Verify domain/API tests, TypeScript and production build. Use browser-use at 1440×900 and 390×844, exercise new controls against the running app, inspect screenshots and check horizontal overflow.

Results are recorded in [mtg-workspace-verification.md](mtg-workspace-verification.md).
