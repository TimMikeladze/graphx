# MTG graph implementation plan

**Goal:** deliver a local MTGJSON card and deck workspace backed by GraphX.
**Spec:** `docs/mtg-graph-design.md`.
**Stack:** workspace GraphX, Next.js, React, Zod, libSQL, Bun.

## Deliverables

1. `src/schema.ts`, `src/catalog.ts`, `src/ingest.ts`, `download.ts`: normalized cards/faces, stable graph identities, evidence-bearing roles, repeatable import, verified MTGJSON downloads. Validate with fixture import and graph queries.
2. `src/search.ts`, `src/analysis.ts`, `src/decks.ts`, `src/runtime.ts`, `src/api.ts`: catalog queries, exact probabilities, deck persistence and temporal history, bounded graph queries and OpenAPI. Tests cover malformed queries, deck bounds, optimistic concurrency, legality and exact mathematical examples.
3. `app/`, `components/`: responsive monochrome explorer, card drawer, deck editor, analysis, graph and API console. All mutations use the server API.
4. `tests/`, `README.md`: run tests, type-check, production build and live HTTP checks; verify desktop and mobile browser interactions and record coverage.

## Decisions

- Execute inline in the existing checkout; the new example is isolated by directory and the user requested token efficiency.
- No hosted deployment: persistent local GraphX/libSQL is the requested backend, and this workspace has no configured public authentication.
- One shared server promise; import completes before any API serves. Client navigation does not reload the catalog.
- Graph similarity uses shared keywords, subtypes and derived roles with inspectable evidence. Exclude generic type/color/format neighbors from ranking.
- All API mutations require same-origin browser requests. Bound request sizes and input quantities. Local-only server binds to localhost.

## Verification focus

Cards with multiple faces; empty/illegal decks; quantities and sideboards; stale revisions; invalid search syntax; probability boundary cases; import errors; browser refresh persistence; responsive horizontal overflow.
