# graphx

A **temporal GraphRAG SDK** — a bitemporal property graph with native vector + full-text retrieval,
multi-tenant isolation, and a typed HTTP serving layer. Runs on **libSQL/SQLite**, **Postgres**, or
**DuckDB** behind a single dialect seam.

- **Bitemporal SCD-2** — every node/edge is versioned with a half-open `[valid_from, valid_to)`
  interval (close-and-insert; history is immutable, `as-of` reads are first-class).
- **GraphRAG retrieve** — vector ANN + graph walk (`retrieve`), plus hybrid FTS5 + RRF + MMR
  (`hybridRetrieve`).
- **Typed, schema-validated** — `defineGraphSchema(...)` (zod) drives per-kind/per-rel validation and
  the inferred TypeScript types end-to-end.
- **Multi-tenant by construction** — one DB per project; a control plane + ReBAC-style authz.
- **Serving** — a [Hono](https://hono.dev) app exposing the SDK over HTTP (`createApp`).

## Install

```sh
bun add graphx zod
```

One package. Everything else is a subpath of it, and each one is a separate entry point — so an
optional peer only reaches your import path if you actually import the subpath that needs it.

| Import          | What it is                                        | Optional peer                    |
| --------------- | ------------------------------------------------- | -------------------------------- |
| `graphx`        | The SDK                                           | —                                |
| `graphx/core`   | Driver-free graph engine for local hosts           | —                                |
| `graphx/browser` | Persistent OPFS / SQLite WASM driver             | `@sqlite.org/sqlite-wasm`         |
| `graphx/expo`   | Expo native SQLite driver (injected module)        | Host supplies `expo-sqlite`       |
| `graphx/pg`     | Registers the Postgres driver (side effect)       | `pg`                             |
| `graphx/duck`   | Registers the DuckDB driver (side effect)         | `@duckdb/node-api` (~123MB)      |
| `graphx/blob`   | Content-addressed blob store                      | `@aws-sdk/client-s3`             |
| `graphx/cli`    | The `graphx` binary's internals                   | —                                |
| `graphx/ingest` | Vault ingestion (`graphx/ingest/s3` for a bucket) | `@aws-sdk/client-s3` for s3      |
| `graphx/react`  | Inference-only React Query hooks                  | `react`, `@tanstack/react-query` |
| `graphx/mcp`    | Backs the `graphx mcp` subcommand                 | `@modelcontextprotocol/sdk`      |
| `graphx/auth`   | ReBAC over the graph                              | —                                |

One binary ships with the package: `graphx` — `new`, `ingest`, `serve`, `triggers`, `mcp`.

### Local browser and native hosts

`graphx/core` exposes the same graph, schema, temporal, retrieval, constraint, and
algorithm implementation without native connection factories or HTTP/control-plane
APIs. Supply a `DbClient` from the host. `createConnectionClient` adapts an
exclusively owned SQLite-family connection and queues unrelated work until an
interactive transaction commits or rolls back. Await its `close()` to observe
shutdown errors.

`openBrowserDb(sqlite3, '/vault.sqlite3')` from `graphx/browser` accepts an
initialized SQLite WASM module inside a dedicated worker. The host must serve
the module, WASM and OPFS proxy worker assets locally and supply COOP/COEP
isolation headers. Missing OPFS fails explicitly. The driver uses standard OPFS
with DELETE journaling and FULL synchronization; competing writers may report
SQLITE_BUSY and callers must retry the complete operation. Keep domain operations
inside the worker and expose those operations to the UI. The test harness
`bun scripts/test-browser-driver.ts` exercises durable reopen and interrupted
transactions in a browser; add `?peer` to open a tab for cross-tab tests.

`openExpoDb(SQLite, 'vault.sqlite3')` from `graphx/expo` accepts the native
`expo-sqlite` module and opens its own connection. It requires a persistent native
directory, uses WAL/FULL synchronization, and rejects unsafe numeric bindings.
Named bindings must include their SQL prefix (`:name`, `@name` or `$name`);
positional arrays work across every driver. Expo does not expose parameter-name
introspection, so bare named keys fail instead of guessing which prefix to bind.
An existing, exclusively owned database can use `createExpoClient(database)`.
The adapter matches Expo SDK 57; native-device persistence requires testing in
the consuming app.

Both drivers use the explicit `sqlite` dialect: FTS5 is required, embeddings use
JSON arrays, and exact cosine retrieval reads all stored vector components.
That costs O(total vector components) read/memory work plus O(nodes log nodes)
sorting per vector query. Journal mode belongs to the driver. Native libSQL
continues to use its vector functions and file database driver.

`createLocalBlobStore(client)` from `graphx/core` stores attachment bytes in the
same SQLite/libSQL database under SHA-256 addresses. Initialize the graph first.
Use `store.inTransaction(tx)` to commit bytes with their graph references;
`gc()` is explicit and preserves references in all historical node versions.

Hosts need standard timers and secure `crypto.getRandomValues` for graph IDs.
On Hermes, install a secure randomness provider before creating graph identities.
Hashing and cursor encoding do not require Node's `Buffer`, `TextEncoder`,
`TextDecoder`, `atob`, or `btoa`. Native connections and server APIs remain in
`graphx`; remote embedding adapters remain in `graphx/embedders`.

## Quickstart

```ts
import { getDb, init, defineGraphSchema, Graph, hashEmbed } from 'graphx';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string() }),
		doc: z.object({ title: z.string() }),
	},
	edges: {
		wrote: { from: 'person', to: 'doc' },
		knows: { from: 'person', to: 'person' },
	},
});

const embedder = hashEmbed(); // dev embedder; openai(...) from 'graphx/embedders' for production
const client = getDb('my-project'); // libSQL: file:my-project.db
await init(client, embedder); // create schema + the vector table at the embedder's width

const g = new Graph(client, schema, { embedder });
const ada = await g.addNode({ type: 'person', data: { name: 'Ada' } });
const paper = await g.addNode({
	type: 'doc',
	data: { title: 'Notes' },
	body: 'analytical engine', // embedded by the graph; re-embedded when it changes
});
await g.addEdge({ rel: 'wrote', src: ada.id, dst: paper.id });

const neighbors = await g.neighbors(ada.id, { rels: ['wrote'] }); // omit `rels` for every relation
const page = await g.listNodes({ type: 'doc' }); // { nodes, nextCursor }
```

The graph embeds every write through its embedder — the type's `body` by default, or the text a
per-type `embedding` policy in the schema declares — hashes that input beside the vector, and
re-embeds only when it changes. A node whose policy yields no text has no vector: FTS and
`hybridRetrieve` still find it, the vector seeds behind `retrieve` never do. Vectors live in a
side table keyed by node and model, so a model change is `graph.reembed()` / `graphx reembed`,
never a rewrite of history.

### Retrieval

```ts
// vector seeds + graph expansion — rows carry type, data, score, via, seed, snippet
const hits = await g.retrieve({ query: 'computing', k: 10, maxDepth: 2 });

// hybrid: vector + full-text fused by RRF, optional MMR diversification
const hybrid = await g.hybridRetrieve({ query: 'computing', k: 10, mmr: { k: 5 } });
```

### Time travel

```ts
import { history, diff, changeFeed } from 'graphx';

const versions = await history(client, id); // full immutable version trail for an id
const delta = await diff(client, t1, t2); // what changed in (t1, t2]
const page = await changeFeed(client); // tailable CDC log (keyset cursor)

// as-of reads run through the retrieval/traversal ops (and match().asOf(t)), not getNode:
const past = await g.retrieve({ query: 'computing', asOf: 1_700_000_000_000 });
```

Other ops: `match()` / `PatternBuilder` (multi-hop patterns), `journey()` (time-respecting
traversal), `bulkLoad()` (batch ingest), graph algorithms (`shortestPath`, `pagerank`, `community`,
`centrality`, `topNodes`), schema evolution (`defineUpcasters`), constraints
(`declareUniqueNodeProp`, `declareSingleValuedRel`).

## Serving over HTTP

**Dev / single-tenant** — pass a `schema` (no control/auth) and `createApp` bootstraps an in-memory
control plane, seeds, and serves. One call:

```ts
import { createApp } from 'graphx';

const { app, tenant, project, user } = await createApp({
	schema,
	embedder: hashEmbed(), // optional; enables /retrieve + /hybrid and embeds every write through it
	cors: true, // optional; browser SPA on another origin, no dev proxy
	logger: true, // optional; log every request
	seed: async (g) => {
		await g.addNode({ type: 'device', data: { name: 'temp-1' } });
	},
});
export default { fetch: app.fetch }; // GET /demo returns { tenant, project, user }
```

Or skip the file entirely: `bunx graphx new my-app && cd my-app && bun run serve` scaffolds a
project and `graphx serve` (loads `graphx.config.ts`) exposes the graph — the same one `graphx
ingest` writes to.

**Production / multi-tenant** — supply your own `control` + `authenticate`; returns the app
synchronously:

```ts
const app = createApp({
	control, // control-plane DB (tenants/projects/memberships)
	schema,
	authenticate: (c) => verifyToken(c), // -> { userId, tenantId }; throw to 401
	embedder, // sizes every project namespace on first touch; every write and /retrieve use it
});
export default { fetch: app.fetch }; // Bun.serve / Cloudflare / Node
```

Routes mount under `/t/:tenant/p/:project/...`: nodes/edges CRUD (`POST`/`GET`/`PATCH`/`DELETE`),
`neighbors`(+`neighborsPage`), `nodes` list, `graph` slice, `schema`, `history`, `retrieve`,
`hybrid`, `journey`, `match`, `bulk`, `changes` (CDC), `diff`, and `algorithms/*`. `GET /schema`
returns the project's declared node types and rels as JSON Schema (derived from your zod schema) —
what a client needs to render typed editors without hard-coding your shapes. Errors map to `{ error,
issues? }` JSON (400 validation/constraint, 401 authn, 403 authz, 404 not-found/cross-tenant). Pair
it with `graphx/react` for typed hooks.

> Typed client caveat: under isolated declarations the published `AppType` is env-level only, so
> `hc<AppType>` is runtime-correct but statically `unknown` — consume the source for precise route
> types, or use `graphx/react`.

### Machine-readable contract

`GET /openapi.json` serves an OpenAPI 3.1 document (unauthenticated, like `/health`). The app is a
[`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi) app: each
route declares its path, request schemas and response schemas in one place, and the document is
generated from those declarations — so the contract can't drift from what is served. An interactive
reference (Scalar) is served at `GET /docs` by default — pass `docs: false` to disable it (it loads
the viewer from a CDN; the spec itself is served locally). Use the spec to generate clients in any
language; `openapi: { title, version, servers }` sets the document's `info`/`servers`.

### Pagination

Two models — know which a route uses:

- **Keyset cursor** (stable; no skip/duplicate; thread the prior `nextCursor` back as `cursor`):
  `GET /nodes`, `GET /nodes/:id/neighborsPage`, `POST /match` (with a `page`), and `GET /changes`
  (per-stream `nextCursor.{nodes,edges}` — the CDC tail).
- **Bounded single response** (no cursor; the set is capped server-side by the `maxRows` governance
  limit): `GET /nodes/:id/neighbors`, `GET /graph`, `GET /retrieve`, `POST /hybrid`, `POST /journey`,
  `GET /diff`, `GET /nodes/:id/history`, and `/algorithms/*`. These return depth-ordered/deduped or
  whole-window results that aren't a flat keyset, so they're bounded rather than paged (raise the cap
  via operator `limits`, not from the client).

## Backends

Default is libSQL. For Postgres, import `graphx/pg` once (registers the driver) and select it via
`getDb(ns, { driver: 'postgres', connectionString })` or `GRAPHX_DB_DRIVER=postgres`. The namespace
becomes a libSQL DB file or a Postgres schema. A few libSQL-native probes (FTS5 internals, `F32_BLOB`)
have no Postgres analog; the user-facing contracts run on both.

## Design

Key decisions: ULID-text identity end-to-end; current reads via `nodes`/`edges` views (never bind
`asOf = FOREVER`); analytics in a `node_analytics` side table; partial vector index on live rows.
