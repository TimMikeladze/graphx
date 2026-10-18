# MTG graph verification

- `bun test examples/mtg-graph/tests`: 17 passed, 0 failed; 62 assertions.
- `bun run --cwd examples/mtg-graph build`: production compilation, TypeScript and static generation passed.
- `bunx oxlint examples/mtg-graph` and `git diff --check`: passed.
- Full MTGJSON import: 35,053 canonical oracle identities from 35,124 name entries; 565,878 catalog relationships after excluding ordinary land production and fetches from ramp/tutor role rules. Deck membership adds separate edges.
- Browser at desktop size and 390 × 844: sidebar collapse/expand, mobile sheet open/navigation/close, no horizontal overflow, query filtering, Psychic Frog details and artwork, analysis chart, exact probabilities and seven-card hand sampling checked. Deck quantity changed 4 → 5 → 4; refresh retained the saved quantity and advanced its GraphX revision.
- Final review found and fixed alternate-face colored pips and commander format transitions; regression coverage added.

Screenshots are ignored local artifacts in `examples/mtg-graph/artifacts/`. The app is local-only and runs with `bun run dev:mtg`. Public authentication, tournament feeds, a complete rules interpreter and per-printing CardSet imports are outside this implementation; see the example README for boundaries.
