# @graphx/admin

Administrative UI for graphx — a master-detail filter explorer (sidebar filters · node list · graph canvas · detail Sheet), node and edge authoring, plus control-plane management (tenants, projects, users, memberships, API keys).

Built with Vite + React 19 + shadcn (radix-mira), TanStack Router/Query, and two graph renderers.

## Renderers

The canvas toolbar switches between them, and the choice rides in the URL (`?renderer=flow`):

- **Force canvas** (`@cosmograph/react`, the default) — WebGL, built for the whole slice. Node captions, edge captions at the midpoints, a settle budget, pause/resume.
- **Flow** (`@xyflow/react`) — DOM cards on a computed layout: dagre ranks (`?flowLayout=layered`, the default) or a d3-force settle (`?flowLayout=organic`). Readable, and the only renderer with editing gestures — but every node is real DOM, so it refuses a slice over 500 nodes and points back at the force canvas.

## Editing

Nodes are created, edited and retracted from the toolbar, the detail panel, and the flow canvas's right-click menu; edges are drawn by dragging one card's handle onto another's and removed from that same menu. Forms are generated from the project's declared schema (see `GET /schema` below) — scalars and enums become inputs, anything richer degrades to a JSON field, and the server's validation error renders inline.

Writes are bitemporal: an edit opens a successor version and a delete closes the live one, so History and as-of queries still see what was there. A node's type is fixed after creation, and edges have no edit (the server has no `PATCH /edges`) — remove and redraw instead.

## Prerequisites

A running graphx Hono server (from `@graphx/core`) that:

- mounts `createApp(cfg)` (serves `/t/:tenant/p/:project/*` — the `/nodes`, `/graph`, `/schema`, `/nodes/:id/history` reads, and the `POST /nodes`, `PATCH /nodes/:id`, `DELETE /nodes/:id`, `POST /edges`, `DELETE /edges/:id` writes the editor uses), and
- mounts the operator sub-app: `app.route('/admin', createAdminApp({ control, authenticate }))`.

For cross-tenant browsing, the server's `authenticate` should return an **operator** principal when it recognizes the admin token:

```ts
authenticate: (c) =>
  c.req.header("authorization") === `Bearer ${process.env.ADMIN_TOKEN}`
    ? { userId: "operator", tenantId: c.req.param("tenant"), operator: true }
    : verifyNormalPrincipal(c)
```

and `createAdminApp`'s `authenticate` should accept the same token.

## Develop

```bash
bun run dev            # Vite dev server (proxies /t and /admin to the API)
VITE_API_TARGET=http://localhost:8787 bun run dev   # override the API origin (default :8787)
```

Open the app, click **Set token**, and paste the operator token (stored in `localStorage`, sent as `Authorization: Bearer`). A `401` reopens the dialog automatically.

## Scripts

```bash
bun run build       # tsc -b + vite build  (also the type gate: type errors fail the build)
bun run test        # bun test — pure units (api client, explorer-search, adapters, form engine)
bun run type-check  # tsc -b (joined to the monorepo `bun run type-check`)
bun run lint        # eslint
```

## Deferred (not in v1)

Lazy canvas expansion (double-click → merge neighbors), DOM/component tests, match/hybrid/algorithm viz, CDC live-sync. See `docs/superpowers/specs/2026-06-12-graphx-admin-ui-design.md` and `docs/superpowers/plans/2026-06-13-graphx-admin-ui.md`.
