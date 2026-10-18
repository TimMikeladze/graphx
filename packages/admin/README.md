# graphx-admin

Administrative UI for graphx — a master-detail filter explorer (sidebar filters · node list · graph canvas · detail Sheet), node and edge authoring, plus control-plane management (tenants, projects, users, memberships, API keys).

Built with Vite + React 19 + shadcn (radix-mira), TanStack Router/Query, and two graph renderers.

## Renderers

The canvas toolbar switches between them, and the choice rides in the URL (`?renderer=flow`):

- **Force canvas** (`@cosmograph/react`, the default) — WebGL, built for the whole slice. Node captions, edge captions at the midpoints, a settle budget, pause/resume.
- **Flow** (`@xyflow/react`) — DOM cards on a computed layout: dagre ranks (`?flowLayout=layered`, the default) or a d3-force settle (`?flowLayout=organic`). Readable, and the only renderer with editing gestures — but every node is real DOM, so it refuses a slice over 500 nodes and points back at the force canvas.

Nodes are colored by type: a stable hash into an 8-color palette, the same in the canvas, legend and lists. An app that embeds the canvas and knows its types can pin them with `setTypeColors({ person: '#fbbf24', … })` from `lib/graph-style`, so no two share a color.

## Editing

Nodes are created, edited and retracted from the toolbar, the detail panel, and the flow canvas's right-click menu; edges are drawn by dragging one card's handle onto another's and removed from that same menu. Forms are generated from the project's declared schema (see `GET /schema` below) — scalars and enums become inputs, anything richer degrades to a JSON field, and the server's validation error renders inline.

Writes are bitemporal and never erase: an edit opens a successor version and a delete closes the live one, so History and as-of queries still see what was there. History also lists beliefs a correction superseded, struck through, with when each was recorded and superseded. The time bar has two scrubbers: World (`asOf`, the graph as it stood) and Recorded (`recordedAsOf`, the graph as it was believed then — before a later correction, say). Either puts the explorer in read-only mode. A node's type is fixed after creation, and edges have no edit (the server has no `PATCH /edges`) — remove and redraw instead.

## Prerequisites

From the repository root, `bun run dev:admin` starts the Better Auth demo API and
this UI. Sign in with `admin@example.test` / `graphx-development`. Identities and
graphs persist under `.graphx-data/admin`; set `ADMIN_DATA_DIR` to choose another
directory. `ADMIN_EMAIL` and `ADMIN_PASSWORD` configure the account on first launch.

For your own server, mount `createBetterAuthApp` from `graphx/better-auth`; see
[the setup guide](../../docs/better-auth.md). Its `/auth-config` endpoint selects
cookie sessions automatically.

### Legacy operator servers

The token workflow also supports a graphx Hono server (from `graphx`) that:

- mounts `createApp(cfg)` (serves `/t/:tenant/p/:project/*` — the `/nodes`, `/graph`, `/schema`, `/nodes/:id/history` reads, and the `POST /nodes`, `PATCH /nodes/:id`, `DELETE /nodes/:id`, `POST /edges`, `DELETE /edges/:id` writes the editor uses), and
- mounts the operator sub-app: `app.route('/admin', createAdminApp({ control, authenticate }))`.

For cross-tenant browsing, the server's `authenticate` should return an **operator** principal when it recognizes the admin token:

```ts
authenticate: (c) =>
	c.req.header('authorization') === `Bearer ${process.env.ADMIN_TOKEN}`
		? { userId: 'operator', tenantId: c.req.param('tenant'), operator: true }
		: verifyNormalPrincipal(c);
```

and `createAdminApp`'s `authenticate` should accept the same token.

## Develop

```bash
bun run dev            # Vite dev server (proxies /t and /admin to the API)
VITE_API_TARGET=http://localhost:8787 bun run dev   # override the API origin (default :8787)
```

For a legacy server, click **Set token** and paste the operator token (stored in
`localStorage`, sent as `Authorization: Bearer`). A `401` reopens the dialog
automatically. Better Auth servers show the sign-in form instead.

## Scripts

```bash
bun run build       # tsc -b + vite build  (also the type gate: type errors fail the build)
bun run test        # bun test — pure units (api client, explorer-search, adapters, form engine)
bun run type-check  # tsc -b (joined to the monorepo `bun run type-check`)
bun run lint        # eslint
```

## Deferred (not in v1)

Lazy canvas expansion (double-click → merge neighbors), DOM/component tests, match/hybrid/algorithm viz, CDC live-sync.

## Better Auth sessions

The app checks `GET /auth-config` before mounting protected routes. A Better Auth
server returns `{ mode: 'better-auth', basePath: '/api/auth', projectAccess: true }`.
The app then uses cookie sessions for signup, login, organizations, invitations,
teams, and graph requests. A saved operator token is ignored in this mode.
Signing out or changing accounts clears cached graph data. Expired sessions return
to the sign-in form; discovery and session server failures show a retry screen.

Choose an organization on the home page, then open or create a project. Organization
administration manages Better Auth memberships and teams. Copy an invitation link
and open it as the invited account to accept it. With project access enabled,
owners and admins can grant a user or team reader/editor access to a project.
Readers can browse graph data; editing controls require project write permission.

The Vite development proxy includes `/auth-config` and `/api/auth`. For a custom
Better Auth path, start Vite with `VITE_AUTH_BASE_PATH=/custom/auth`; the client uses
the path returned by discovery. A server returning 404 for `/auth-config` retains
the operator-token workflow described above.
