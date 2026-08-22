# @graphx/admin UI Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Build the master-detail filter explorer SPA (`packages/admin`) over the Plan 1 backend — side-panel filters | node list | Cosmograph canvas, node-detail Sheet, control-plane admin views.

**Architecture:** Vite + React 19 + shadcn (radix-mira). TanStack Router for URL-as-filter-state, TanStack Query for server cache, `@cosmograph/react` for the canvas. A thin typed `fetch` client targets the Hono API (`/t/:tenant/p/:project/*` + `/admin/*`). Cosmograph is isolated behind a pure adapter so its data-shaping is unit-tested without WebGL.

**Tech Stack:** Vite 8, React 19, TanStack Query 5 + Router 1, `@cosmograph/react` 2, shadcn, Tailwind 4, Vitest (pure-function unit tests).

**Deviations from spec `2026-06-12-graphx-admin-ui-design.md`:**

- **D-UI-4:** wire DTOs are defined locally in `src/lib/types.ts` (mirror the API shapes) instead of importing from `core` — `core` ships no `dist/` build, so a type import would not resolve in the Vite app. Normal for a REST client; revisit if `core` starts publishing types.
- **Tests:** v1 covers pure units (cosmograph adapter, search-param codec, api URL building) with Vitest. DOM/component tests (filter→URL render, Sheet open) deferred — they need jsdom + router/query harness and are brittle; the pure units cover the risky logic.

---

## File Structure (`packages/admin/src/`)

- `lib/types.ts` — wire DTOs: `Tenant`, `Project`, `User`, `Role`, `GraphNode`, `NodeListPage`, `GraphSlice`, `GraphSliceNode`, `GraphSliceLink`, `NodeVersion`.
- `lib/api.ts` — `ApiError`; token storage (`getToken`/`setToken`); `api` object with typed methods for every Plan 1 route. Injects `Authorization: Bearer`; throws `ApiError(status)`; a `401` handler hook.
- `lib/explorer-search.ts` — pure parse/serialize of the explorer URL search params (`kind`, `q`, `asOf`, `node`, `expand`). Unit-tested.
- `lib/cosmograph-adapter.ts` — pure `toCosmograph(slice, {selectedId, palette})` → `{nodes, links}` with color-by-kind + a stable kind→color palette. Unit-tested.
- `lib/query-keys.ts` — query-key factories.
- `hooks/use-graph.ts` — `useTenants`, `useProjects`, `useNodes` (infinite), `useGraphSlice`, `useNode`, `useNeighbors`, `useHistory`.
- `hooks/use-admin.ts` — mutations: `useCreateTenant`, `useCreateProject`, `useCreateUser`, `useAddMembership`, `useCreateApiKey`.
- `components/app-sidebar.tsx` — tenant/project `Combobox`s + filter controls + `/admin` link.
- `components/filters/{kind-filter,search-box,as-of-picker}.tsx`.
- `components/node-list.tsx` — master table (`useNodes`), selection → `?node=`.
- `components/graph-canvas.tsx` — `@cosmograph/react` via the adapter; click → `?node=`, double-click → expand.
- `components/node-detail-sheet.tsx` — `Sheet` with Properties/Neighbors/History tabs.
- `components/results-banner.tsx` — "results capped" when `truncated`.
- `components/token-dialog.tsx` — admin-token entry on 401.
- `components/admin/*` — `Dialog` forms for the control-plane CRUD.
- `routes/{__root,index,explorer,admin}.tsx` — code-based TanStack Router tree.
- `router.tsx`, `main.tsx` — providers + router.

`vite.config.ts` gets a dev proxy: `/t` and `/admin` → `http://localhost:8787` (the Hono process), so no CORS in dev.

## Build Sequence (tasks)

1. **Test infra + pure units** — add Vitest; `lib/types.ts`, `lib/explorer-search.ts` (+test), `lib/cosmograph-adapter.ts` (+test). Verify: `bun run test` green, `bun run typecheck` clean.
2. **API client** — `lib/api.ts` (+ a pure test for URL/Bearer building against a mocked `fetch`). Verify typecheck + test.
3. **Query layer** — `lib/query-keys.ts`, `hooks/use-graph.ts`, `hooks/use-admin.ts`. Verify typecheck.
4. **Router + providers** — `routes/*`, `router.tsx`, `main.tsx`, vite proxy. Verify `bun run build` succeeds.
5. **Explorer shell** — `app-sidebar` + selectors + `ResizablePanelGroup` in `explorer.tsx`. Verify build.
6. **Filters + node list** — `filters/*`, `node-list.tsx`, wired to URL + `useNodes`. Verify build.
7. **Canvas** — `graph-canvas.tsx` via adapter + lazy expand. Verify build.
8. **Detail Sheet** — `node-detail-sheet.tsx` (Properties/Neighbors/History). Verify build.
9. **Admin views** — `routes/admin.tsx` + `components/admin/*` CRUD dialogs. Verify build.
10. **Polish** — token dialog on 401, results-capped banner, empty/loading states (Skeleton), Toaster. Final `bun run build` + `bun run test` + monorepo `type-check`.

Each task commits on green (`bun run typecheck` + `bun run test` for logic tasks; `bun run build` for view tasks).

## Test Targets (Vitest, pure)

- `cosmograph-adapter.test.ts`: maps `GraphSlice.links` → `{source,target}`; assigns a deterministic color per kind; marks the selected node.
- `explorer-search.test.ts`: round-trips params; `expand` is a set; defaults (`asOf` absent ⇒ now/omitted).
- `api.test.ts`: builds the correct URL + query string; attaches `Bearer` when a token is set; throws `ApiError` with the response status; omits empty filters.
