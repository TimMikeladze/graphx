# `@graphx/admin` — Administrative UI (design spec)

> Status: **APPROVED design.** Date: 2026-06-12. Net-new Vite SPA package + supporting
> backend routes layered over the existing `@graphx/core` SDK and Hono serving layer.
> No `initial_spec.md` phase number; layered like the `@graphx/react` draft.

## 1. Goal

A single-page administrative UI for graphx operators: a **master-detail filter explorer** built on
**Cosmograph** for graph visualization, plus **control-plane management** (tenants, projects, users,
memberships, API keys). Built with **Vite + shadcn** (init preset `b5KHpmmsV`, vite template).

The defining workflow: pick a tenant → pick a project → filter that project's graph (kind, full-text,
as-of time) → see results simultaneously as a **node list** (master) and a **Cosmograph canvas**, with
a **detail inspector** (Sheet) on node click. Operators can also manage the control-plane registry.

### v1 scope (all four shipping)
1. **Tenant/project read + switch** — list tenants, list projects per tenant, the two scoping selectors.
2. **Control-plane writes** — create/edit tenant, project, user, membership, API key.
3. **Graph explore** — filterable node list + Cosmograph canvas + node detail inspector with neighbors.
4. **Temporal controls** — "as-of" picker + node version history view (graphx's differentiator).

### Non-goals (deferred, named so they are not silently dropped)
- match / hybridRetrieve / algorithm (pagerank, centrality, community) visualizations.
- CDC live-sync (`useChangeFeedSync` — the `@graphx/react` change-feed story).
- Edge creation/editing from the canvas; multi-project overlay.
- RBAC finer than operator-impersonation; production operator SSO.
- End-to-end browser tests.

## 2. Decisions taken during brainstorming

- **D-UI-1 — Live API, extend core now.** UI hits the real Hono API. New control-plane HTTP routes
  and graph read routes are part of this work (control-plane is SDK-only today).
- **D-UI-2 — Mounted admin sub-app (Fork 1 = B).** Registry CRUD lives in a distinct Hono sub-app
  mounted at `/admin`, with its own operator-auth. Tenant-scoped graph routes stay on the main app
  with existing role authz. One process, two auth realms.
- **D-UI-3 — Server-filtered slice + lazy expand (Fork 2 = 3).** Canvas is fed a governed, capped
  `{nodes, links}` slice for the current filter set; double-click a node expands via `neighbors`.
  Filters are authoritative server-side and respect §19.2 governance caps.
- **D-UI-4 — Standalone typed client.** The UI imports core's exported domain types directly and uses
  a thin typed `fetch` client; it does **not** depend on the DRAFT `@graphx/react` (control-plane types
  are out of that package's scope). May converge later.

## 3. Architecture & package layout

New package `packages/admin` (`@graphx/admin`, `"private": true`, no `dist` export), scaffolded by the
shadcn vite init. The root workspace already globs `packages/*`.

Process topology (one Hono process, two auth realms):

```
Bun.serve({ fetch: app.fetch })
  app                                  ← existing createApp<S>
   ├─ /health, /ready                  (existing)
   ├─ /t/:tenant/p/:project/...        (existing tenant-scoped role authz)
   │    + NEW: GET /nodes  (list/filter)
   │    + NEW: GET /graph  (governed slice → {nodes, links})
   │    + NEW: GET /nodes/:id/history
   └─ app.route('/admin', adminApp)    ← NEW mounted sub-app
        operator-auth middleware (adminAuthenticate)
        ├─ GET/POST  /tenants
        ├─ GET/POST  /tenants/:id/projects
        ├─ GET/POST  /users
        ├─ POST      /memberships
        └─ POST      /api-keys
```

New core files (keep `serve.ts` focused):
- `packages/core/src/admin.ts` — `createAdminApp(cfg)`: operator sub-app, `adminAuthenticate` hook,
  control-plane CRUD handlers wrapping existing `control-plane.ts` functions.
- `packages/core/src/list.ts` — `listNodes(graph, opts)` and `graphSlice(graph, opts)`: new read
  primitives (today only `getNode` by id exists). Read-only, governed, temporal-aware.
- `packages/core/src/serve.ts` — add the three tenant-scoped graph-explore routes to the existing
  `createApp` chain (reuse `requireGraph('read')`, `onError`, metrics sink).

Build/dev: core stays `bunup`; admin uses Vite. Admin dev server proxies `/t` and `/admin` to the Hono
process (Vite `server.proxy`) → no CORS in dev.

Data path: SPA → TanStack Query → typed fetch client → Hono. UI imports `AnyNode`, `EdgeRef`,
`NodeOf`, etc. from `@graphx/core` for compile-time shape.

## 4. The operator-auth gap and its resolution

The existing `authenticate(c) → {userId, tenantId}` is single-tenant; authz checks
`project ∈ principal.tenantId` and role ≥ op. An operator needs (a) cross-tenant registry CRUD and
(b) the ability to browse **any** tenant's graph. Nothing today grants either.

**Resolution — one operator token, two effects:**
1. Gates `/admin/*` registry CRUD via a new `adminAuthenticate(c)` injection point on the sub-app
   (same pattern as `authenticate`). Dev default compares a `Bearer` token to a server-configured
   `adminToken`; production verifies a real session/JWT.
2. **Operator impersonation** on tenant-scoped graph routes: when a valid admin token is present, the
   principal is synthesized *per route* as `{userId:'operator', tenantId: <:tenant param>, role:'owner'}`,
   so existing `requireGraph` authz passes unchanged for any tenant. **No change to the authz module.**

UI stores the token in `localStorage` and sends `Authorization: Bearer`. A 401 opens a token-entry
dialog and retries on submit.

## 5. API contract

| Realm | Method | Path | Backed by | Returns |
|---|---|---|---|---|
| admin  | GET  | `/admin/tenants` | `control` query | `{tenants:[{id,name}]}` |
| admin  | POST | `/admin/tenants` | `createTenant` | `{id}` |
| admin  | GET  | `/admin/tenants/:id/projects` | `control` query | `{projects:[{id,name,dbNamespace}]}` |
| admin  | POST | `/admin/tenants/:id/projects` | `createProject` | `{id}` |
| admin  | GET  | `/admin/users` | `control` query | `{users:[{id,email}]}` |
| admin  | POST | `/admin/users` | `createUser` | `{id}` |
| admin  | POST | `/admin/memberships` | `addMembership` | `204` |
| admin  | POST | `/admin/api-keys` | hash + insert | `{key}` (shown once) |
| tenant | GET  | `/t/:t/p/:p/nodes` | **new** `listNodes` | `{nodes:[AnyNode], nextCursor}` |
| tenant | GET  | `/t/:t/p/:p/graph` | **new** `graphSlice` | `{nodes:[{id,kind}], links:[{source,target,rel,weight}], truncated}` |
| tenant | GET  | `/t/:t/p/:p/nodes/:id/history` | `history` | `{versions:[...]}` |

**Filter query params** (on `/nodes` and `/graph`): `kind`, `q` (FTS5 via existing `sanitizeMatch`),
`asOf` (epoch ms → `asOfPredicate`; default = now), `limit`, `cursor` (keyset, existing
`encodeCursor`/`decodeCursor`). All caps from `resolveLimits` (§19.2) — **not** client-overridable.

**`graphSlice` semantics:** select the filtered node set (capped at the governance row limit), then
select edges where **both** endpoints are in that set. Shape the result to Cosmograph's
`{nodes:[{id,kind,...}], links:[{source,target,rel,weight}]}`. If the node set hit the cap, set
`truncated:true`.

**Error mapping:** admin sub-app reuses the existing `onError` (`ZodError→400`, `AuthzError→403/404`,
`SQLITE_CONSTRAINT→400`, malformed cursor→400). Missing/bad admin token → 401.

## 6. UI

**Routing (TanStack Router):**
- `/` → tenant picker (redirect to last-used).
- `/t/:tenant/p/:project` → explorer; filters live in URL search params
  (`?kind=&q=&asOf=&node=&expand=`) — shareable/bookmarkable.
- `/admin` → registry management.

**Explorer layout** (`ResizablePanelGroup`):

```
┌──────────┬───────────────────┬──────────────────────────┐
│ Sidebar  │  Node list        │  Cosmograph canvas        │
│ (shadcn) │  (master, virt.   │  (whole filtered slice)   │
│ Tenant ▼ │   table)          │   nodes colored by kind   │
│ Project▼ │  row = node       │   click node → Sheet      │
│ Filters: │  click → select   │   2×click → lazy-expand   │
│  kind ▢  │  syncs w/ canvas  │   (neighbors merge)       │
│  search  │                   │                           │
│  as-of ⏱ │                   │                           │
└──────────┴───────────────────┴──────────────────────────┘
     node click → <Sheet>: Properties · Neighbors · History
```

**Components (`packages/admin/src/components/`):**
- `app-sidebar.tsx` — shadcn `Sidebar`: tenant `Combobox`, project `Combobox`, filter controls, link to `/admin`.
- `filters/` — `kind-filter` (multi-select), `search-box` (debounced → `q`), `as-of-picker` (→ `asOf` epoch, "now" default).
- `node-list.tsx` — virtualized master table; `useNodes` infinite query; selection drives canvas highlight + Sheet.
- `graph-canvas.tsx` — `@cosmograph/react` `<Cosmograph>`; `useGraphSlice` data; color-by-kind legend; click / double-click handlers.
- `node-detail-sheet.tsx` — shadcn `Sheet`; tabs Properties · Neighbors · History (timeline from `/history`).
- `admin/` — `Dialog` forms: create tenant, project, user, add membership, mint api-key (shown once).

**State:**
- Server state: TanStack Query. Keys: `['tenants']`, `['projects',tenant]`,
  `['nodes',tenant,project,filters]` (infinite/keyset), `['graph',tenant,project,filters]`,
  `['node',id]`, `['history',id]`.
- Filter state: URL search params = single source of truth. Filter change → router nav → query key
  change → refetch. No separate filter store.
- Canvas state: Cosmograph ref local; selection/expansion in URL (`node`, `expand`).
- Auth: admin token in `localStorage`; fetch client injects `Bearer`; 401 → token dialog.

**Lazy expand (D-UI-3):** double-click a node → `useNeighbors(id)` → client-side union of returned
nodes/links into the canvas dataset → append id to `?expand=`. Initial canvas = governed `/graph`
slice for the current filters.

## 7. Data flow

```
edit filter → router.navigate({search}) → URL params change
  → query keys change → parallel refetch:
       useNodes      → GET /nodes?kind&q&asOf&cursor   → master list
       useGraphSlice → GET /graph?kind&q&asOf          → canvas {nodes,links}
  → Cosmograph re-renders slice; list virtualizes rows
node click   → set ?node=id → useNode + useNeighbors + useHistory → Sheet
double-click → useNeighbors → merge into canvas → append ?expand=id
```

## 8. Error handling (UI)

- 401 (missing/bad admin token) → token-entry `Dialog`, retry on submit.
- Governance cap hit (§19.2 row/fan-out/timeout) → server returns capped result with `truncated:true`;
  UI shows a "results capped — narrow filters" banner.
- Empty states (no tenants / projects / nodes for filter) → explicit shadcn empty cards, not blank panels.
- Cosmograph load failure (WebGL unavailable) → fallback message; the list still works.

## 9. Testing

**Core (`bun test`, matching the existing 244-test suite; in-memory libSQL):**
- `listNodes` / `graphSlice` — kind filter, FTS `q`, `asOf` temporal correctness, keyset pagination,
  governance cap enforcement (`truncated`).
- Admin routes — operator-token gate (401 without, 200 with); control-plane CRUD round-trips;
  operator impersonation lets graph routes pass authz for an arbitrary tenant.

**UI (Vitest + Testing Library):**
- Filter → URL sync; list selection → Sheet open; token dialog on 401. Mock the fetch client with
  typed fixtures.
- Cosmograph not unit-tested (WebGL). Wrap it behind a thin adapter; test the adapter's data-shaping
  (`AnyNode[]`/`EdgeRef[]` → `{nodes,links}`) in isolation.
- No e2e in v1.

## 10. Build sequence (for the implementation plan)

1. Core read primitives — `list.ts` (`listNodes`, `graphSlice`) + tests.
2. Tenant-scoped graph routes in `serve.ts` (`/nodes`, `/graph`, `/nodes/:id/history`) + tests.
3. Admin sub-app — `admin.ts` (`createAdminApp`, `adminAuthenticate`, operator impersonation, CRUD) + tests.
4. Scaffold `packages/admin` (shadcn vite init) + typed fetch client + TanStack Query/Router wiring.
5. Explorer shell — sidebar, selectors, ResizablePanelGroup.
6. Filters (kind / search / as-of) + node list master.
7. Cosmograph canvas + adapter + lazy expand.
8. Node detail Sheet (Properties / Neighbors / History).
9. Admin registry management views.
10. Empty/error/cap states + token dialog.
