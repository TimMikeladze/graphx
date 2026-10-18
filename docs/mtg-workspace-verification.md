# MTG workspace verification

Verified October 18, 2026. The [spec](mtg-workspace-upgrades.md) records all 30 changes.

## Checks

```sh
bun test examples/mtg-graph/tests
bun run --cwd examples/mtg-graph type-check
bun run --cwd examples/mtg-graph build
bunx oxlint examples/mtg-graph
git diff --check
```

25 tests passed, 0 failed, 87 assertions. Type generation, TypeScript, lint and whitespace checks passed. Next.js 16.3.6 production compilation and static generation passed. No new package dependencies were added for the upgrades. Geist Sans and Mono were verified as local `/_next/static/media/` resources, with no Google Fonts requests.

## Browser checks

- Discovery: favorites-only filtering before pagination, saved-search creation and mobile recall, persistent density, two-card comparison, query URL persistence, deck-context URL restoration after switching active decks, and unavailable-deck notices. Live API search returned 3,197 cards for `role=Card draw&maxPrice=2`; negative prices returned 400 and an empty favorites allowlist returned zero results.
- Decks: duplicate retained 60 mainboard cards and the format while preserving its source. Mainboard quantity went 4 → 5 → undo 4 → redo 5 → undo 4. A separate production check added Sol Ring to maybeboard and undid it. Deck search, mana-value grouping, quantity sorting and partial price coverage were checked. A copy of the starter deck remains as `Dimir tempo copy`; source contents were restored after quantity checks.
- Analysis: five land-probability rows, changing play/draw odds, seven-card hand statistics, London mulligan controls, validation category filtering and opening the card associated with a copy-limit issue. The temporary fifth Counterspell was undone; the copied deck returned to 60 mainboard cards.
- Card details: copying a card URL, reloading it into the same card, closing and clearing its URL parameter. Production reload/first-click-close passed twice with the browser tab visible. Background-tab rendering initially deferred input; no application fix was required for that driver behavior.
- Layout: screenshots inspected at 1440×900 desktop and 390×844 phone size. Catalog, decks and analysis had no document-level horizontal overflow. Mobile bottom navigation and saved-search disclosure worked. Native select controls were exercised through DOM change events; buttons and text fields used CDP pointer and keyboard input.

## Evidence

Screenshots are local ignored artifacts under `examples/mtg-graph/artifacts/`:

| Screen                 | Before               | After                                                                      |
| ---------------------- | -------------------- | -------------------------------------------------------------------------- |
| Catalog desktop        | `before-desktop.png` | `after-desktop.png`                                                        |
| Catalog phone          | `before-mobile.png`  | `after-mobile.png`                                                         |
| Decks                  | —                    | `decks-desktop.png`, `decks-mobile.png`                                    |
| Analysis               | —                    | `probabilities-desktop.png`, `hand-desktop.png`, `analysis-mobile.png`     |
| Comparison and details | —                    | `compare-desktop.png`, `card-detail-desktop.png`, `production-desktop.png` |

Independent code review found two issues: hidden mobile saved searches and missing deck context in shared searches. Both were corrected and checked again; the targeted final review reported no important findings.
