# graphx admin — UI flesh-out design

**Date:** 2026-07-23
**Scope:** Polish + fix + fill gaps on `packages/admin`. No new routes, no data-model change, no backend change (except confirming `/graph` returns what the fixed canvas needs). Keep the dark aesthetic.

## Guiding principle

**Chrome stays monochrome; saturated color is reserved for data.** Node-type identity is the only saturated color in the app, and it comes from one source (`KIND_PALETTE` in `cosmograph-adapter`). That same palette drives graph points, list dots, detail badges, and the legend. Everything else uses shadcn neutral tokens.

Node-type colors MUST stay concrete hex values (not CSS vars) — the WebGL canvas cannot read CSS custom properties.

## The bug (P0)

The Cosmograph canvas renders `🤒 Failed to get points data. Missing required properties: "pointIndexBy"`. Cosmograph v2 (`@cosmograph/react@2.3.2`) requires index columns when data is passed directly:

- Points require `pointIdBy` **and** `pointIndexBy` (a sequential 0-based integer column).
- Links require `linkSourceBy`/`linkTargetBy` **and** `linkSourceIndexBy`/`linkTargetIndexBy`.

**Fix:** the pure adapter injects `index` on each node and `sourceIndex`/`targetIndex` on each link (resolved from an id→index map; links to unknown endpoints are dropped). The canvas passes the index props. Adapter is unit-tested; canvas is WebGL (not unit-tested per spec §9).

## Areas

### A. Foundation
- Unified node-type color surfaced via a `TypeDot` / `NodeTypeBadge` primitive used everywhere a type appears.
- `tabular-nums` for counts, `font-mono` for ULIDs, `shortId()` truncation helper (head+tail of the ULID).
- Canvas background driven from a token so it matches the dark card surface (not a hard-coded near-black).

### B. App shell
- Explorer topbar: `tenant / project` breadcrumb, connection/token affordance, right-aligned actions; keeps the sidebar trigger.
- `Cmd-K` command palette (reuses `ui/command`): jump to node by id, switch tenant/project, open admin, set token, toggle theme.

### C. Explorer layout
Four resizable panes: **filter rail (sidebar) | node list | graph | docked detail**. Detail is a `ResizablePanel` that appears when a node is selected — not an overlay. Selecting a node docks detail on the right and the graph centers + highlights that node and its neighbors. On mobile (`use-mobile`) detail falls back to the existing `Sheet`.

### D. Filter rail (sidebar)
Grouped scope + filters, active-filter chips with clear-all, live node count. Keeps comboboxes; better labels/spacing.

### E. Node list
Type color-dot + badge, denser rows, selected emphasis, keyboard nav (↑/↓ move, ⏎/click select), sticky header, copy-id affordance, real empty/error/loading, count + truncation note.

### F. Graph canvas
- Fix (above).
- Toolbar overlay (shadcn buttons + tooltips + hugeicons): fit-to-view, zoom ±, pause/resume simulation, fullscreen.
- Select → `selectPoint(index, false, true)` (node + connected highlighted) and `zoomToPoint`. Hover → popup with id/type. Empty-canvas click clears selection.
- Legend: compact panel; clicking a type sets the NodeType filter (click active type to clear).
- Proper WebGL-unavailable + empty states.

### G. Node detail (docked; shared with mobile Sheet)
- Header: type badge, short id, copy-id, focus-in-graph.
- Properties tab: key/value view with per-value copy + raw-JSON toggle.
- Neighbors tab: grouped/labelled by **type** (the neighbors endpoint returns `{id,type,data}` only — no rel/direction), each row a type dot + short id, click to select.
- History tab: vertical timeline with a rail, per-version `from → to`, `live` badge for the open version.

### H. Admin + index pages
Polish cards/hierarchy/empty states; copy buttons on ids; API-key reveal-once UX. Index auto-skips the picker when there is a single tenant with a single project.

### I. Global states
Reusable `EmptyState` (icon + title + hint) for empty/error; skeletons for loading; toasts already wired.

## Non-goals
New routes, backend/API changes, new data model, graph editing/writes, auth changes.

## Verification
`bun test` green (incl. updated adapter test), `tsc --noEmit` clean, `eslint` clean, `vite build` succeeds. Dev-server smoke where feasible.
