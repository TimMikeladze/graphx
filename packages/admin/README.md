# @graphx/admin

Administrative UI for graphx — a master-detail filter explorer (sidebar filters · node list · Cosmograph canvas · detail Sheet) plus control-plane management (tenants, projects, users, memberships, API keys).

Built with Vite + React 19 + shadcn (radix-mira), TanStack Router/Query, and `@cosmograph/react`.

## Prerequisites

A running graphx Hono server (from `@graphx/core`) that:

- mounts `createApp(cfg)` (serves `/t/:tenant/p/:project/*` incl. the `/nodes`, `/graph`, `/nodes/:id/history` read routes), and
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
bun run test        # vitest — pure units (api client, explorer-search, cosmograph adapter)
bun run type-check  # tsc -b (joined to the monorepo `bun run type-check`)
bun run lint        # eslint
```

## Deferred (not in v1)

Lazy canvas expansion (double-click → merge neighbors), DOM/component tests, match/hybrid/algorithm viz, CDC live-sync. See `docs/superpowers/specs/2026-06-12-graphx-admin-ui-design.md` and `docs/superpowers/plans/2026-06-13-graphx-admin-ui.md`.
