# @graphx/mcp

An MCP server for [graphx](../core) — every route on the serving app (`@graphx/core`'s
`createApp`) mirrored as an MCP tool, generated from the app's own OpenAPI registry rather than
hand-curated. A route added to `serve.ts` is a tool an agent can reach; a route removed is a tool
that stops existing. There is no second manifest to keep in sync.

## Install

```sh
bun add @graphx/mcp
```

## Claude Desktop / Claude Code config

Add an entry to your client's MCP config (Claude Desktop's `claude_desktop_config.json`, Claude
Code's `.mcp.json`, or equivalent):

```json
{
	"mcpServers": {
		"graphx": {
			"command": "npx",
			"args": ["-y", "@graphx/mcp"],
			"env": {
				"GRAPHX_MCP_MODE": "local",
				"GRAPHX_DB": "mygraph",
				"GRAPHX_SCHEMA": "./schema.json"
			}
		}
	}
}
```

with `./schema.json`:

```json
{
	"nodes": {
		"person": {
			"type": "object",
			"properties": { "name": { "type": "string" }, "age": { "type": "number" } },
			"required": ["name"]
		}
	},
	"edges": {
		"knows": { "from": "person", "to": "person" }
	}
}
```

This spawns `graphx-mcp` over stdio. `GRAPHX_DB` is a **namespace, not a connection string**:
`mygraph` opens (and creates) `./mygraph.db` relative to whatever working directory your client
launches the process in. `GRAPHX_SCHEMA` is optional but recommended — see
[Configuration](#configuration) for the file format.

Local mode mints a fresh tenant and project on every start, so tell the agent to call
**`graphx_context` first** — it returns the ids that every other tool takes as arguments, and they
cannot be guessed or carried over from a previous run.

Without `GRAPHX_SCHEMA` it runs schemaless (see Limitations below): reads and the metric tools
work, but every write tool 400s, `describe_schema` falls back to sampling types off the graph, and
no `graphx://schema` resource is registered. Pointing `GRAPHX_SCHEMA` at a file fixes all three.
Tool _descriptions_ stay generic either way — for those, embed the server as a library instead.

## Library usage

The schema-aware path, and the one worth recommending: bootstrap `createApp` yourself and hand the
result to `createGraphxMcp`, so the server sees the same `GraphSchema` your routes validate against.

```ts
import { createApp, defineGraphSchema, hashEmbed } from '@graphx/core';
import { createGraphxMcp, localBackend } from '@graphx/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

const dev = await createApp({ schema, db: 'mygraph', embed: hashEmbed() });
const server = createGraphxMcp({
	app: dev.app,
	backend: localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant }),
	schema,
});
await server.connect(new StdioServerTransport());
```

`localBackend` dispatches straight into the Hono app (`app.fetch`, no socket) — the local path runs
the same authn, authz, upcasting and governance middleware as production, because it is that
middleware. `remoteBackend({ url, apiKey })` is the same seam against a deployed server over HTTP;
`createGraphxMcp` doesn't care which `Backend` it's given.

## Mounting on an existing server

`createMcpApp` is the local adapter with your already-built app passed in, as a mountable Hono app.
This serves MCP over Streamable HTTP (via `@hono/mcp`) next to the REST routes, in the same
process — no separate server to run.

> **`createMcpApp` authenticates nothing.** Anyone who can reach the mounted route gets every
> registered tool, with whatever the resolved `Backend` is authorized for. graphx's own authn
> middleware is scoped to `/t/:tenant/*` and does **not** cover `/mcp`. Put your own middleware in
> front of the route, and pass `backend` as a **function** so each request runs as its own caller —
> a fixed `Backend` serves every caller as the one principal baked in at mount time.

```ts
import { createApp, defineGraphSchema, hashEmbed } from '@graphx/core';
import { createMcpApp, localBackend } from '@graphx/mcp';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

const dev = await createApp({ schema, db: 'mygraph', embed: hashEmbed() });

/** YOUR authentication — whatever the rest of your deployment already uses. */
const principalOf = (c: Context): { user: string; tenant: string } | undefined => {
	const token = c.req.header('authorization')?.replace(/^Bearer /, '');
	return token ? { user: dev.user, tenant: dev.tenant } : undefined;
};

const api = new Hono(); // your existing app, with its own routes already mounted
api.use('/mcp', async (c, next) => {
	// Reject before the MCP server ever sees the request.
	if (!principalOf(c)) return c.json({ error: 'unauthorized' }, 401);
	await next();
});
api.route(
	'/mcp',
	createMcpApp({
		app: dev.app,
		schema,
		// Resolved per request, so the identity your middleware established travels with the tool
		// call and the graph sees the caller rather than the mount.
		backend: (c) => {
			const p = principalOf(c)!;
			return localBackend(dev.app, { 'x-user': p.user, 'x-tenant': p.tenant });
		},
	}),
);
```

The server and its transport are built per request. Running stateless, Streamable HTTP keys
request → response stream on the bare JSON-RPC id, and that id is a per-client counter starting at
0 — a shared transport would cross-deliver between two clients on their very first message.

## Configuration

Read by `graphx-mcp` (the stdio binary). The library entry points take the same values as fields on
their options object instead.

| Variable               | Meaning                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GRAPHX_MCP_MODE`      | `local` or `remote`. If unset, defaults to `remote` when `GRAPHX_URL` is set, otherwise `local`.                                                                                                                                                                                                                                                                             |
| `GRAPHX_DB`            | Required in local mode. A **namespace**, not a connection string — `mygraph` means the libSQL file `./mygraph.db` in the process's working directory, created if absent. A URL here is taken literally as a namespace: `file:./graph.db` silently opens `./graph.db.db`, and `postgres://…` / `libsql://…` fail at startup. The binary throws if it is missing.              |
| `GRAPHX_SCHEMA`        | Optional, local mode only. Path to a JSON schema file (below). When set, `create_node` / `create_edge` / `bulk_load` validate against it, `describe_schema` returns a real contract, and `graphx://schema` registers as a resource. When unset, local mode runs schemaless. A missing file, malformed JSON, or an unsupported construct exits 1 with a clear stderr message. |
| `GRAPHX_URL`           | Required in remote mode: the base URL of a deployed graphx server. The binary throws at startup if missing.                                                                                                                                                                                                                                                                  |
| `GRAPHX_API_KEY`       | Optional bearer credential sent with every request in remote mode.                                                                                                                                                                                                                                                                                                           |
| `GRAPHX_MCP_READ_ONLY` | Set to `1` to register only `read`-tagged tools. Equivalent to the `--read-only` CLI flag.                                                                                                                                                                                                                                                                                   |

In remote mode, the tool surface itself still comes from a locally built app with an empty schema —
the set of tools is a property of the installed graphx version, not of the deployment being
addressed. Only the `Backend` (where calls are actually sent) points at `GRAPHX_URL`.

### `GRAPHX_SCHEMA` file format

Node types use **the JSON Schema shape `z.toJSONSchema` already emits**, so a file can be generated
straight off an existing `defineGraphSchema` and round-trips. Relations mirror `EdgeDef` — a plain
table of `from` / `to` / `single`, plus an optional `data` in the same node-property shape. A bare
`{}` is a valid, unconstrained relation.

```json
{
	"nodes": {
		"person": {
			"type": "object",
			"properties": { "name": { "type": "string" }, "age": { "type": "number" } },
			"required": ["name"]
		},
		"note": {
			"type": "object",
			"properties": { "title": { "type": "string" }, "body": { "type": "string" } },
			"required": ["title"]
		}
	},
	"edges": {
		"knows": { "from": "person", "to": "person" },
		"wrote": { "from": "person", "to": "note", "single": true }
	}
}
```

`from`/`to` accept a string or an array of strings. Property types `string`, `number`, `integer`,
`boolean`, `array` (with `items`), and nested `object` are supported; a property absent from
`required` becomes optional. `$ref`, `anyOf`, `oneOf`, `allOf`, and `enum` are out of scope — using
one throws at startup naming the node type, the property, and the construct, rather than silently
dropping it.

## Tools

25 mirrored tools (16 read, 9 write), generated from `serve.ts`'s route registry, plus
`describe_schema` — 26 as a library. The binary adds `graphx_context`, for 27. `--read-only` /
`GRAPHX_MCP_READ_ONLY=1` leaves the 16 read tools plus both of those — 18 from the binary.

| Tool               | Op    | Description                                                                                                                                                                                             |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graphx_context`   | read  | **Binary only, call it first.** The `tenant` and `project` ids every other tool takes as arguments, plus the mode. Local mode mints them fresh on each start; remote mode has none to give and says so. |
| `list_projects`    | read  | List the caller's projects in this tenant                                                                                                                                                               |
| `create_node`      | write | Create a node                                                                                                                                                                                           |
| `create_edge`      | write | Create an edge                                                                                                                                                                                          |
| `get_node`         | read  | Get a node by id                                                                                                                                                                                        |
| `update_node`      | write | Update a node                                                                                                                                                                                           |
| `delete_edge`      | write | Delete an edge                                                                                                                                                                                          |
| `delete_node`      | write | Retract a node                                                                                                                                                                                          |
| `neighbors`        | read  | Neighbors (unpaginated)                                                                                                                                                                                 |
| `neighbors_page`   | read  | Neighbors (keyset paginated)                                                                                                                                                                            |
| `list_nodes`       | read  | List nodes (keyset paginated)                                                                                                                                                                           |
| `graph_slice`      | read  | Canvas slice (nodes + links)                                                                                                                                                                            |
| `get_node_content` | read  | Live content payload (body + provenance)                                                                                                                                                                |
| `node_history`     | read  | Version trail for a node                                                                                                                                                                                |
| `retrieve`         | read  | GraphRAG vector retrieve                                                                                                                                                                                |
| `journey`          | read  | Time-respecting traversal                                                                                                                                                                               |
| `change_feed`      | read  | Change feed / CDC tail                                                                                                                                                                                  |
| `diff`             | read  | Snapshot delta over (t1, t2]                                                                                                                                                                            |
| `hybrid_search`    | read  | Hybrid retrieve (ANN + FTS + RRF + MMR)                                                                                                                                                                 |
| `bulk_load`        | write | Bulk-load nodes                                                                                                                                                                                         |
| `match_pattern`    | read  | Multi-hop pattern query                                                                                                                                                                                 |
| `shortest_path`    | read  | Shortest path                                                                                                                                                                                           |
| `pagerank`         | write | PageRank (persists)                                                                                                                                                                                     |
| `community`        | write | Community detection (persists)                                                                                                                                                                          |
| `centrality`       | write | Degree centrality (persists)                                                                                                                                                                            |
| `top_nodes`        | read  | Top nodes by a persisted metric                                                                                                                                                                         |
| `describe_schema`  | read  | The graph schema: node types as JSON Schema, and the declared relations. Read this before writing nodes or building pattern queries.                                                                    |

Destructive-by-default is deliberate: graphx deletes are temporal retracts, recoverable by `asOf`,
so `delete_node` and `delete_edge` carry `destructiveHint: true` for clients that want to confirm,
but nothing is filtered out on that basis. `update_node` carries `idempotentHint: true`. Every
`read`-tagged tool carries `readOnlyHint: true`.

## Resource

`graphx://schema` — node types as JSON Schema plus the declared `{ from, rel, to }` relation table,
read from the `GraphSchema` you passed to `createGraphxMcp` or `createMcpApp`. Loads once as
context instead of costing a round trip per session. `describe_schema` returns the same document,
for clients that don't implement resources.

## Limitations

- **`GET /events` is not mirrored.** It's Server-Sent Events, and MCP tool results are single
  values — there's no tool result shape for a live stream. The general mechanism is that a route
  opts out of mirroring by carrying no `operationId`; `/events` is the one route that does.
- **Five tools return no `structuredContent`.** `neighbors`, `retrieve`, `journey`,
  `hybrid_search`, and `top_nodes` respond with a top-level JSON array, and MCP types
  `structuredContent` as an object, so these five come back with `structuredContent` unset. The
  full payload is still there in `content[0].text` — nothing is lost, but a client reading
  `structuredContent` specifically gets nothing for these five.
- **A schemaless server registers no resources at all.** The standalone binary run without a
  schema — no library-provided schema, and no `GRAPHX_SCHEMA` — never calls `registerResource`, so
  the MCP SDK never declares the `resources` capability. A client that checks
  `getServerCapabilities()` first sees no `resources` key and knows to skip it; a client that calls
  `listResources()` unconditionally gets a thrown `-32601 Method not found` rather than an empty
  list. `describe_schema` still works in this mode (see below) — only the resource form is
  affected.
- **The binary runs schemaless unless `GRAPHX_SCHEMA` is set.** A `GraphSchema` is a TypeScript
  value, so `graphx-mcp` can't import yours directly — but `GRAPHX_SCHEMA` (above) points it at a
  JSON file instead. Without it, `describe_schema` falls back to sampling distinct `type` values off
  `GET /nodes` and returns them tagged `inferred: true`, with no property schemas and no relations.
  A failed sample (401, 403, 404, 500) comes back as an `isError` result carrying the status, so an
  unreachable graph never reads as an empty one. Tool _descriptions_ stay generic either way — embed
  the server as a library (above) for those.
- **In LOCAL mode, without `GRAPHX_SCHEMA`, the binary cannot create anything.** `Graph.addNode`
  rejects a type it has no definition for, so against a schemaless app `create_node`, `create_edge`
  and `bulk_load` always fail with `HTTP 400: addNode: unknown type '…'`, and `update_node` /
  `delete_node` have nothing to act on. Reads, and the three metric tools, work normally. This does
  **not** affect remote mode — there the deployment validates against its own schema, and the local
  empty one is used for nothing but the route registry. Point `GRAPHX_SCHEMA` at a schema file
  (above) to write to a local graph without embedding the server as a library.
- **The binary is libSQL only.** `GRAPHX_DB_DRIVER=postgres` selects the Postgres dialect, but
  `graphx-mcp` never imports `@graphx/core/pg`, so it exits at startup with `getDb: postgres driver
selected but the pg adapter is not registered`.
- **The binary defaults to `hashEmbed`.** `retrieve` and `hybrid_search` need an embedder;
  `hashEmbed()` is lexical and deterministic, not semantic, and the binary logs one line to stderr
  on startup saying so. Pass your own `embed` through the library entry points for real vector
  search.
