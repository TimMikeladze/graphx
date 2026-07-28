# MCP server for graphx

Design. Date: 2026-07-27.

## Problem

graphx has no MCP surface. An agent that wants to use a graphx project as temporal memory —
search it, walk it, write facts back — has to be handed an HTTP client and a copy of the OpenAPI
document, and then trusted to compose URLs correctly. Every MCP client on the market speaks a tool
protocol instead.

The serving layer is already the right shape for this. `packages/core/src/serve.ts` exposes 25
routes behind one authn injection point and one authz check, with governance caps enforced
server-side and non-overridable by the client. `packages/core/src/openapi.ts` holds a route table
(`routes()`, line 42) whose request bodies and query parameters are the *same* Zod wire schemas the
routes validate against, and `openapi.test.ts` fails CI if that table drifts from the live Hono
`app.routes`.

That table is a tool manifest that nobody has read as one yet.

## Decisions

Six forks, resolved.

1. **Tools mirror the HTTP endpoints one-for-one**, generated from the existing route table rather
   than hand-curated into agent-shaped verbs. The table is already drift-checked against the live
   app, so a route added without a tool fails CI. A curated surface would be a second contract to
   keep in sync by hand, and the endpoints already carry the `op: 'read' | 'write'` tag that
   read-only mode needs.

2. **One core, two adapters, behind a one-method seam.** Handlers are never reimplemented. Hono
   dispatches a `Request` to a `Response` without a socket, so the local adapter runs the real
   serving app in-process and the remote adapter is `fetch` against a deployed one. Both go through
   the same authn, authz, upcasting, and governance path, because both *are* that path.

3. **Tenant and project are tool parameters, not server config.** One server instance reaches every
   project the credential can. The cost is two fields on 26 tool schemas and the risk that an agent
   addresses the wrong project; the benefit is that a user with many projects configures one MCP
   entry, not one per project. Cross-tenant access is still blocked in `authorize` — an agent that
   guesses another tenant's project id gets a 404 that does not leak existence.

4. **Discovery gets a resource and two additions.** The graph schema is compile-time knowledge in
   `defineGraphSchema` and reaches no HTTP surface today, so without it every write is a guess at a
   type name. It ships as an MCP resource (loads once as context) with a tool mirror for clients
   that do not implement resources. Project discovery gets a new member-scoped HTTP route, which
   then mirrors as a tool like every other route.

5. **Writes are on by default, annotated.** graphx deletes are temporal retracts, recoverable by
   `asOf`, so a destructive-by-default posture would be stricter than the data model warrants.
   Clients get MCP annotations to drive their own confirmation prompts, and `--read-only` filters
   the surface on the existing `op` tag.

6. **The package ships both transports.** stdio for a locally spawned process (the Claude Desktop /
   Claude Code case), Streamable HTTP via `@hono/mcp` so `createMcpApp()` mounts on an existing Hono
   app next to the REST routes.

## Package

New workspace package `packages/mcp`, published as `@graphx/mcp`.

```
packages/mcp/src/
  index.ts       createGraphxMcp(), createMcpApp()   — library entry points
  backend.ts     the Backend seam: local | remote
  tools.ts       route table → 24 mirrored tools + 2 discovery tools
  resources.ts   graphx://schema
  bin.ts         stdio entry point (bin: graphx-mcp)
```

Dependencies: `@modelcontextprotocol/sdk@^1.30`, `@hono/mcp@^0.3`, `zod@^4`. Peer dependency on
`@graphx/core`, matching how `@graphx/cli` depends on core today.

The SDK takes `zod@^3.25 || ^4.0`, so the repo's zod 4 works unmodified. `@hono/mcp@0.3.1`
peer-depends on the SDK rather than vendoring it, so there is one protocol implementation in the
tree.

## The Backend seam

```ts
export interface Backend {
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init?: { query?: Record<string, string>; body?: unknown },
  ): Promise<Response>;
}
```

**Local.** `createApp` returns a Hono app; Hono routes a `Request` object without listening on a
port.

```ts
const { app } = await createApp({ schema, embed, db: cfg.db });
const backend: Backend = {
  call: (method, path, init) =>
    app.fetch(new Request(`http://local${path}${qs(init?.query)}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })),
};
```

**Remote.** The same shape against a base URL with a bearer credential.

```ts
const backend: Backend = {
  call: (method, path, init) =>
    fetch(`${cfg.url}${path}${qs(init?.query)}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    }),
};
```

`createMcpApp()` — the mounted case — is the local adapter with the caller's already-built app
passed in instead of a freshly bootstrapped one.

## Tool generation

### Changes to the route table

`packages/core/src/openapi.ts` holds the table as a module-private `routes()` returning a
module-private `RouteMeta[]`. Three edits:

1. Export both. No behavior change.
2. Add `mcp?: { name: string }` per row. Method and path do not yield good tool names mechanically
   (`GET /nodes/{id}/neighborsPage` is not `get_nodes_id_neighborspage`), and a name is worth
   writing once next to the summary that already exists.
3. Add `scope?: 'project' | 'tenant'`, defaulting to `'project'`. Every current row sits under
   `PREFIX = '/t/{tenant}/p/{project}'`; the new `GET /t/{tenant}/projects` route does not. The
   OpenAPI generator reads the same field, so one addition serves both consumers.

The `openapi.test.ts` drift check gains one assertion: every row that is not the SSE route has an
`mcp.name`.

### The mapping

| Method | Path | `op` | Tool |
|---|---|---|---|
| POST | `/nodes` | write | `create_node` |
| GET | `/nodes` | read | `list_nodes` |
| GET | `/nodes/{id}` | read | `get_node` |
| PATCH | `/nodes/{id}` | write | `update_node` |
| DELETE | `/nodes/{id}` | write | `delete_node` |
| POST | `/edges` | write | `create_edge` |
| DELETE | `/edges/{id}` | write | `delete_edge` |
| GET | `/nodes/{id}/neighbors` | read | `neighbors` |
| GET | `/nodes/{id}/neighborsPage` | read | `neighbors_page` |
| GET | `/nodes/{id}/content` | read | `get_node_content` |
| GET | `/nodes/{id}/history` | read | `node_history` |
| GET | `/graph` | read | `graph_slice` |
| GET | `/retrieve` | read | `retrieve` |
| POST | `/hybrid` | read | `hybrid_search` |
| POST | `/journey` | read | `journey` |
| POST | `/match` | read | `match_pattern` |
| POST | `/bulk` | write | `bulk_load` |
| GET | `/changes` | read | `change_feed` |
| GET | `/events` | read | *skipped* |
| GET | `/diff` | read | `diff` |
| POST | `/algorithms/shortest-path` | read | `shortest_path` |
| POST | `/algorithms/pagerank` | write | `pagerank` |
| POST | `/algorithms/community` | write | `community` |
| POST | `/algorithms/centrality` | write | `centrality` |
| GET | `/algorithms/top` | read | `top_nodes` |

`GET /events` is Server-Sent Events (`contentType: 'text/event-stream'`, `notImplemented: true`
without a configured outbox). MCP tool results are single values; a live stream belongs behind MCP
notifications, which is a separate design. It is skipped, not faked.

24 mirrored tools from the current table: 15 read, 9 write. The new `GET /t/{tenant}/projects` route
described under Discovery joins the same table, bringing the mirrored total to 25 — 16 read, 9
write.

### Input schemas

One flat Zod object per tool, merged from three sources:

- **Path params** — `tenant` and `project` on every project-scoped row, plus `id` where the path
  templates one.
- **Query** — the row's `query` schema, unwrapped to its fields.
- **Body** — the row's `body` schema, unwrapped to its fields.

Merging is safe: across all 24 rows no body or query field is named `tenant`, `project`, or `id`.
If a future row collides, the generator throws at construction rather than shadowing a field
silently.

The SDK converts Zod to JSON Schema itself (it depends on `zod-to-json-schema`), so tool schemas are
generated from the same Zod objects the routes validate against — the same no-drift property the
OpenAPI document has.

### Annotations

Read directly off `op`, with three hand-set exceptions:

- `op: 'read'` → `readOnlyHint: true` (15 tools)
- `delete_node`, `delete_edge` → `destructiveHint: true`
- `update_node` → `idempotentHint: true`
- `pagerank`, `community`, `centrality` → `op: 'write'` because they persist metrics, but
  `destructiveHint: false`. They add, they do not remove.

### Read-only mode

`GRAPHX_MCP_READ_ONLY=1` or `--read-only` filters registration on `op === 'read'`, leaving 16
mirrored read tools plus `describe_schema`. A filter over one field, not a second code path.

### Results

Success: the response body as JSON text content, plus `structuredContent` carrying the parsed
object. 204 responses (`delete_node`, `delete_edge`) return `{ ok: true }`.

Failure: `isError: true` with a readable message, never a thrown exception — a tool error the agent
can read and recover from beats a transport error it cannot.

| Status | Message |
|---|---|
| 400 | validation failed, with the Zod issues verbatim |
| 401 | not authenticated |
| 403 | not authorized for `{op}` on `{project}` |
| 404 | not found (project or node) |
| 501 | capability unconfigured, naming which (`embed` for `/retrieve`, outbox for `/events`) |

Only a transport-level failure — the remote host unreachable — throws.

## Discovery

### Resource `graphx://schema`

Served from the `GraphSchema` object: each node type's Zod definition through `z.toJSONSchema`, plus
the relation table as `{ from, rel, to }` triples. Static per server instance, loaded once as
context instead of costing a round trip per agent session.

Schema availability differs by mode, and the difference is user-visible:

| Mode | Has `GraphSchema`? |
|---|---|
| local (`createGraphxMcp` bootstraps `createApp`) | yes — the caller imports it |
| mounted (`createMcpApp` on the caller's Hono app) | yes — same process as `serve.ts` |
| standalone binary pointed at a foreign URL | no |

The third case degrades rather than failing: `describe_schema` samples distinct `type` values from
`GET /nodes` and returns them tagged `inferred: true`, with no property schemas. Documented as a
limitation of pointing the binary at a server whose schema you do not have.

### Tool `describe_schema(tenant, project)`

The resource's content as a tool result, for clients that do not implement resources — several do
not.

### Tool `list_projects()`

Returns the projects visible to the caller. This needs a new route in core.

The existing control-plane listing lives in `createAdminApp` (`admin.ts`), which is a separate auth
realm gated on "is this caller an operator" — a normal tenant API key gets 401 there. So:

```
GET /t/:tenant/projects    scope: 'tenant', op: 'read'
```

The handler authenticates, confirms the principal has a membership row in the route tenant, and
returns `listProjects(control, principal.tenantId)` with `dbNamespace` stripped. The namespace is
internal routing detail; §2.9 keeps DB-level identifiers away from end users.

`serve.ts` line 536 currently scopes the authn middleware to `/t/:tenant/p/:project/*`. It widens to
`/t/:tenant/*` — a superset covering the same paths plus the new one.

This route joins the route table with `scope: 'tenant'`, so it is documented in OpenAPI and
mirrored as a tool like everything else.

### Deferred: `graphx://t/{tenant}/p/{project}/stats`

Per-type and per-relation counts would help an agent orient in an unfamiliar graph. No endpoint
produces them, and synthesizing them from `list_nodes` is a table scan per type. Doing it properly
means a `GET /stats` route running `COUNT(*) GROUP BY type` — a third core change, out of scope for
v1. Left out rather than approximated badly.

## Surface summary

| | count |
|---|---|
| mirrored tools, read (15 existing + `list_projects`) | 16 |
| mirrored tools, write | 9 |
| non-mirrored tools (`describe_schema`) | 1 |
| **total tools** | **26** |
| total tools, `--read-only` | 17 |
| resources | 1 |
| prompts | 0 |

## Configuration

```
GRAPHX_MCP_MODE=local|remote

# local
GRAPHX_DB=file:./graph.db | libsql://… | postgres://…

# remote
GRAPHX_URL=https://…
GRAPHX_API_KEY=…

GRAPHX_MCP_READ_ONLY=1
```

The library entry point takes the same values as an options object, plus the `GraphSchema` and an
`EmbedFn`.

**The embedder is the one sharp edge in local mode.** `/retrieve` and `/hybrid` return 501 when
`embed` is unconfigured, so the binary defaults to `hashEmbed()` from core — lexical, deterministic,
no network, no API key — and logs one line on startup saying results are lexical rather than
semantic. Defaulting silently would make hash-based search look like broken semantic search.

## Testing

Bun tests, no sockets. The SDK ships `InMemoryTransport.createLinkedPair()`, so a real MCP client
drives a real MCP server in-process, exercising protocol framing rather than mocking it.

1. **Manifest** — `tools/list` returns 26 tools; names and annotations match the route table;
   `events` is absent.
2. **Read-only** — with the flag, `tools/list` returns 17 and every write name is gone.
3. **Reads** — each of the 16 read tools returns the same payload as the equivalent
   `app.request()` call against a seeded graph.
4. **Writes** — each of the 9 write tools round-trips: call, then read back through the matching
   read tool.
5. **Errors** — 404 for an unknown node id, 400 for a malformed body, 403 for a cross-tenant
   project id, 501 for `retrieve` with no embedder. Each arrives as `isError: true`, not a throw.
6. **Resource** — `resources/read` on `graphx://schema` returns every node type in the fixture
   schema and every declared relation.
7. **Drift** — every non-SSE row in `routes()` carries an `mcp.name`. Extends the existing
   `openapi.test.ts` check.
8. **Both backends** — the suite runs under `GRAPHX_TEST_DRIVER` for libSQL and Postgres, as the
   rest of core does.

Remote-adapter coverage reuses the same assertions with the backend pointed at an in-process
`app.fetch`, differing only in that it sets an authorization header — the seam is small enough that
this is the whole difference.

## Work outside `packages/mcp`

Stated plainly, because it is scope beyond the new package:

1. `openapi.ts` — export `routes()` and `RouteMeta`; add `mcp.name` and `scope` fields.
2. `serve.ts` — add `GET /t/:tenant/projects` (member-scoped); widen the authn middleware from
   `/t/:tenant/p/:project/*` to `/t/:tenant/*`.
3. `openapi.test.ts` — one added drift assertion.

Optional, deferred: `GET /stats` for the counts resource.
