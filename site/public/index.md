# graphx — Temporal GraphRAG for TypeScript

`graphx` is an open source temporal graph for TypeScript. Built on [Zod](https://zod.dev), typed end to end, and packed with retrieval, traversal and serving. Made by [linesofcode](https://x.com/linesofcode).

Currently v0.1.0. Install: `bun add graphx`

- **16** entry points, one package
- **4** server backends
- **9** cli commands
- **10** runtime dependencies

## Principles

- **One schema, no codegen.** Writes, routes, hooks and MCP tools infer from one `Schema` type. There is no generate step to forget.
- **Nothing is erased.** A delete closes a `valid_to` interval. Any read takes `asOf` and reconstructs that instant exactly.
- **One contract everywhere.** Every type, route and payload is identical across backends. The README examples compile against the build.

## Write it, query it, serve it

The same `Graph` object writes, reads and walks. `match` compiles a typed pattern to one SQL statement, and `createApp` serves all of it with a generated OpenAPI contract.

**Write**

```ts
import { getDb, init, Graph, hashEmbed } from 'graphx';
import { schema } from './graphx.config.ts';

const embedder = hashEmbed();
const db = getDb('acme__alpha'); // one cached client per namespace (tenant)
await init(db, embedder); // tables, indexes, and the vector table at the embedder's width
const g = new Graph(db, schema, { embedder });

const site = await g.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
const gw = await g.addNode({
	type: 'gateway',
	data: { name: 'gw-1', firmware: '2.1.0' },
	body: 'free text — indexed for FTS and embedded for vector search by the graph itself',
});
await g.addEdge({ rel: 'deployedAt', src: gw.id, dst: site.id });
```

**Query**

```ts
// GraphRAG: vector seeds, then a time-respecting walk out from them
await g.retrieve({ query: 'overheating sensor', k: 10, maxDepth: 2 });

// Pattern match — rows typed per alias, no codegen
const q = await match(schema, db)
	.node('g', 'gateway')
	.out('raised')
	.node('a', 'alert')
	.select('g', 'a');
const rows = await q.run(); // rows[0].g.data, rows[0].a.data

// Time travel: every version of a node, and what moved between two instants
await history(db, id);
await diff(db, t1, t2);
```

**Serve**

```ts
const { app, tenant, project, user } = await createApp({
	schema,
	embedder: hashEmbed(),
	db: 'iot_demo',
	cors: true,
	openapi: { title: 'iot-fleet', servers: [{ url: 'http://localhost:8899' }] },
	seed: async (g) => {
		await g.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
	},
});

Bun.serve({ port: 8899, fetch: app.fetch });
```

**Production**

```ts
const app = createApp({
	control, // the shared registry of tenants, projects and memberships
	schema,
	embedder: openai(),
	authenticate: async (c) => verifyJwt(c.req.header('authorization')), // → { userId, tenantId }
	limits: { maxRows: 5_000 },
	metrics,
	readiness, // /ready stays 503 until sync-before-serve finishes
});
```

## One schema, no codegen

Describe nodes and edges with Zod objects in `defineGraphSchema`. Typed writes, pattern matching, HTTP routes, hooks and MCP tools are all inferred from that one `Schema` type, so there is no generate step to run.

```ts
const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string(), region: z.enum(['us', 'eu', 'apac']) }),
		gateway: z.object({ name: z.string(), firmware: z.string() }),
		alert: z.object({ severity: z.enum(['low', 'high']) }),
	},
	edges: {
		// `from`/`to` constrain the endpoints; `single` makes the rel single-valued per source,
		// so each addEdge closes the previous live one. `data` validates edge payloads.
		deployedAt: { from: 'gateway', to: 'site', single: true },
		raised: { from: 'gateway', to: 'alert', data: z.object({ at: z.number() }) },
	},
	// Optional per-type embedding policy: what text a node is embedded from (default: its `body`),
	// and whether long inputs are split into chunks. A data-only type stays searchable this way.
	embedding: {
		site: { text: (d) => `${d.name} (${d.region})` },
		alert: { chunk: { size: 1200, overlap: 120 } },
	},
});

type Schema = typeof schema;
```

## Every write is bitemporal

Versions carry `valid_from` and `valid_to`, so a delete closes an interval instead of erasing a row. Pass `asOf` to any read to see the graph as it stood at that instant.

```sh
$ bun run examples/basic-demo.ts
listNodes  1 alerts
match      [
  [ "gw-1", "high" ]
]
…
history    2 versions
asOf t0    [
  {
    name: "gw-1",
    firmware: "2.1.0",
  }
]
```

Want the change stream instead? Tail `changeFeed`, or mount `useChangeFeedSync` from `graphx/react`.

## Vector, text and graph together

Call `hybridRetrieve` to fuse vector and full-text results with reciprocal rank fusion, then walk out from the seeds along edges valid at that time. Each row says which leg matched it in `via`.

```ts
// Vector seeds, then a time-respecting walk out from them
await g.retrieve({ query: 'overheating sensor', k: 10, maxDepth: 2, rels: ['raised'] });

// Vector + full-text fused with reciprocal rank fusion, then the same walk
await g.hybridRetrieve({
	query: 'overheating sensor',
	k: 10,
	rrfK: 60,
	rerank: async (query, candidates) => …, // optional — jevRerank() below, or your own
	mmr: { k: 10, lambda: 0.7 }, // optional diversification
});
```

## Typed pattern matching

Chain `match(schema, db)` with `.node()`, `.out()` and `.in()`. It compiles to one SQL statement and returns rows typed per alias, with `page()` for keyset pagination over the same pattern.

```ts
import { match } from 'graphx';

const q = await match(schema, db)
	.node('d', 'device')
	.in('raised') // .out(), .in(), .both(); rel options take weight, data and direction filters
	.node('a', 'alert')
	.select('d', 'a');

const rows = await q.run(); // rows[0].d.data and rows[0].a.data are typed per alias
const page = await q.page({ limit: 100 }); // keyset pagination over the same pattern
```

## The graph owns embedding

Every write embeds through the graph’s `embedder`, and re-embeds only when the input hash changes. Run `graphx doctor` to see the stored model, its width and how many nodes are stale.

```sh
$ graphx doctor
namespace      graphx (libsql)
stored model   hash:768  dim=768
configured     hash:768  dim=768
live nodes     3
embedded       3  (3 vector rows)
unembedded     0
stale          0
```

## Backend is configuration

Pick a store with the `driver` option on `getDb`. Every public type, method, route and payload is identical across libSQL, Postgres with pgvector and DuckDB over an object store.

**default, no driver**

```ts
const db = getDb('acme__alpha'); // file:acme__alpha.db
```

**driver: 'postgres'**

```ts
import 'graphx/pg'; // registers the Postgres driver (side effect)

const db = getDb('acme__alpha', {
	driver: 'postgres',
	connectionString: 'postgresql://user:pass@host:5432/graphx',
	// ssl?: boolean | tls.ConnectionOptions
	// poolMax?: number
});
```

**driver: 'duckdb'**

```ts
import 'graphx/duck'; // registers the DuckDB driver (side effect)

const db = getDb('acme__alpha', { driver: 'duckdb' });
```

## Runs in browsers and phones

Import from `graphx/core` and hand it a `DbClient`. `openLocalDb`, `openBrowserDb` and `openExpoDb` each own their connection and verify the pragmas they depend on, so a host without durable storage fails loudly.

**graphx/local, Node or Bun**

```ts
// Node or Bun — an owned native libSQL file, or a private RAM namespace
import { openLocalDb, openMemoryDb } from 'graphx/local';
import { Graph, init } from 'graphx/core';

const client = await openLocalDb('/Users/me/vault.db'); // WAL + FULL sync, verified
await init(client);
const g = new Graph(client, schema);
```

**graphx/browser, SQLite WASM on OPFS**

```ts
// Browser — SQLite WASM on OPFS, inside a dedicated worker with COOP/COEP set
import { openBrowserDb } from 'graphx/browser';

const client = await openBrowserDb(sqlite3, '/vault.sqlite3');
await init(client);
```

**graphx/expo, iOS and Android**

```ts
// Expo — native SQLite on iOS and Android
import { openExpoDb } from 'graphx/expo';
import * as SQLite from 'expo-sqlite';

const client = await openExpoDb(SQLite, 'vault.db');
await init(client);
```

Want it over the network instead? Serve the same graph with `createApp`.

## Typed HTTP with OpenAPI

Pass your schema to `createApp` and get typed routes, a generated `GET /openapi.json` and an interactive reference at `/docs`. Every route sits under `/t/{tenant}/p/{project}`, so tenant isolation holds by construction.

```ts
import { createApp, hashEmbed } from 'graphx';
import { schema } from './schema.ts';

const { app } = await createApp({
	schema,
	embedder: hashEmbed(), // every write embeds through it; no dimension to configure
	db: 'iot_demo',
	openapi: { title: 'iot-fleet' },
});

// Typed routes + GET /openapi.json + an interactive reference at /docs
Bun.serve({ port: 8899, fetch: app.fetch });
```

## Hooks with no generated client

`createGraphHooks<Schema>()` types every React Query hook from the schema type alone. The browser bundle carries no SDK runtime, and `useChangeFeedSync` invalidates exactly the keys that moved.

```tsx
import { GraphProvider, createGraphHooks } from 'graphx/react';
import type { Schema } from './schema.ts';

const g = createGraphHooks<Schema>();

// <GraphProvider bootstrap="/demo"> fetches the tenant/project/user ids itself
g.useNode(id, 'gateway'); // NodeOf<Schema,'gateway'> | null
g.useNeighbors(id, { rel: 'deployedAt' }); // site[]
g.useListNodes({ type: 'alert' }); // alert[]
g.useMatch((q) => q.node('d', 'device').in('raised').node('a', 'alert').select('d', 'a'));
g.useRetrieve({ query: 'overheating sensor', k: 10 });
g.useAddNode(); // mutations: add/update/delete node, add/delete edge, bulk load
g.useChangeFeedSync(); // tails /changes and invalidates exact keys
g.useGraphEvents(); // subscribes to the SSE stream
```

## An MCP server for free

Run `graphx mcp` and every serving route becomes a tool over stdio, validated against your `graphx.config.ts`. Add `--read-only` to expose only the read tools.

```json
{
	"mcpServers": {
		"graphx": { "command": "bunx", "args": ["graphx", "mcp", "-c", "./graphx.config.ts"] }
	}
}
```

## Access control in the graph

`graphx/auth` stores relationship tuples as edges, so `auth.check` is a temporal graph query. Pass `asOf` to ask what a user could do last week.

```ts
import { Auth, defineAuthModel, rel, tupleToUserset } from 'graphx/auth';

const model = defineAuthModel({
	user: {},
	folder: { parent: rel(), editor: rel(), viewer: rel().or('editor') },
	doc: {
		parent: rel(),
		editor: rel(),
		banned: rel(),
		// (direct ∪ editor ∪ viewer-of-the-parent-folder) − banned
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')).minus('banned'),
	},
});

const auth = new Auth(g, model);
await auth.write([{ object: 'doc:readme', relation: 'editor', subject: 'user:tim' }]);
await auth.check('doc:readme', 'viewer', 'user:tim'); // true
await auth.check('doc:readme', 'viewer', 'user:tim', { asOf: lastWeek }); // as it stood then
await auth.expand('doc:readme', 'viewer'); // the userset tree
await auth.listObjects('user:tim', 'viewer', 'doc', { limit: 100 }); // keyset-paginated
```

## One package, many entry points

Everything is a subpath of `graphx`, and each is a separate entry point. An optional peer such as `pg` only lands on your import path if you import `graphx/pg`.

| Import | What it is |
| --- | --- |
| `graphx` | The server SDK: schema, connections, data layer, retrieval, temporal reads, algorithms, serving |
| `graphx/core` | The same graph engine with no driver and no Node built-ins — for browser, native and embedded hosts |
| `graphx/local` | `openLocalDb` / `openMemoryDb` — an owned native libSQL file or RAM namespace |
| `graphx/browser` | `openBrowserDb` / `createWasmClient` — SQLite WASM over OPFS, inside a worker |
| `graphx/expo` | `openExpoDb` / `createExpoClient` — Expo SQLite on iOS and Android |
| `graphx/pg` | Registers the Postgres driver with `getDb` (side effect) |
| `graphx/duck` | Registers the DuckDB driver with `getDb` (side effect) |
| `graphx/bunql` | BunQL: a server over Hrana, or its embedded `bun:ffi` driver — `driver: 'bunql'` |
| `graphx/embedders` | `fetch`-based embedders for OpenAI, Voyage and Ollama (no SDKs) |
| `graphx/jev` | Judgments with Jev: reranking, screening, entity resolution, typing, scoring — `fetch`, no SDK |
| `graphx/blob` | S3-backed blob store for node bodies |
| `graphx/ingest` | Ingest a YAML/markdown vault into a graph (`graphx/ingest/s3` for a bucket) |
| `graphx/react` | Inference-only React Query hooks + CDC live-sync |
| `graphx/mcp` | Backs `graphx mcp` — every serving route exposed as an MCP tool |
| `graphx/auth` | Relationship-based access control (ReBAC) on graphx |
| `graphx/cli` | The `graphx` binary |

## Boundaries

Three lists, counted. The first is exercised by the test suite, the second is opinion, and the third is what you should not assume.

### What holds (4)

- Every TypeScript block in the README is compiled against the built package by the test suite.
- History is append-only: a delete closes a version, and `asOf` reads reconstruct the graph exactly.
- Tenant isolation is by route construction, not by a `WHERE` clause.
- A namespace refuses a different embedding model until `graphx reembed` switches it.

### What is a judgement (3)

- `hashEmbed` is lexical and model-free. It suits tests and demos; retrieval quality in production is your embedder’s.
- Delivery of triggers is at-least-once, so actions must be idempotent. That is a design choice, not a bug to be fixed.
- Calling it “temporal GraphRAG” is our description of retrieve-then-walk, not a benchmarked claim.

### What is not here yet (4)

- No benchmark figures on this page. `bun run bench` exists, but the README holds no captured run to reference.
- DuckDB allows one writer process per namespace; two rewriting the same table raise `SnapshotConflictError`.
- `Graph.atomic` needs a namespace with no embeddings, and browser writers can still hit `SQLITE_BUSY`.
- The admin SPA is not published. It runs from the repository.

## Start with a scaffold

Run `graphx new` to write a runnable `graphx.config.ts`, then `bun run serve`. Contributing to graphx itself runs the same gate CI does.

```sh
$ bunx graphx new my-app
Scaffolded graphx project in my-app/

  cd my-app
  bun install        # pulls graphx from npm
  bun run serve      # http://localhost:8899
```

```sh
bun install       # from the repo root
bun test          # the full suite
bun run type-check
bun run build     # bunup, every entry point
bun run dev:admin # the operator SPA against a dev server
bun run bench     # the benchmark suites
bun run bench:benchable --latest --out bench/benchable.json  # newest result as a Benchable run
bunx benchable submit --metrics bench/benchable.json           # send it (BENCHABLE_KEY, or benchable login)
```

## Guides

- [Time travel](https://graphx.sh/reference#time-travel): History, diffs and the change feed.
- [Ingest a vault](https://graphx.sh/reference#ingest): Markdown and wikilinks into typed edges.
- [Judgments with Jev](https://graphx.sh/reference#judgments-with-jev): Rerank, dedupe and type links by meaning.

## Links

- [Reference](https://graphx.sh/reference)
- [GitHub](https://github.com/TimMikeladze/graphx)
- [npm](https://www.npmjs.com/package/graphx)
