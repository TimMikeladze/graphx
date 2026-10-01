# graphx

[graphx.sh](https://graphx.sh) · [npm](https://www.npmjs.com/package/graphx) · [GitHub](https://github.com/TimMikeladze/graphx)

Temporal GraphRAG for TypeScript. Define a graph once with Zod and get typed mutations, bitemporal
history, vector + full-text retrieval, pattern matching, traversal, graph algorithms, an HTTP API
with a generated OpenAPI contract, React Query hooks and an MCP server — running on libSQL/SQLite,
Postgres, DuckDB, the browser or Expo, with no codegen anywhere.

## Install

```sh
bun add graphx
```

One package, one version. Everything below is a subpath of it — there is nothing else to install and
nothing to keep in lockstep.

| Import             | What it is                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `graphx`           | The server SDK: schema, connections, data layer, retrieval, temporal reads, algorithms, serving     |
| `graphx/core`      | The same graph engine with no driver and no Node built-ins — for browser, native and embedded hosts |
| `graphx/local`     | `openLocalDb` / `openMemoryDb` — an owned native libSQL file or RAM namespace                       |
| `graphx/browser`   | `openBrowserDb` / `createWasmClient` — SQLite WASM over OPFS, inside a worker                       |
| `graphx/expo`      | `openExpoDb` / `createExpoClient` — Expo SQLite on iOS and Android                                  |
| `graphx/pg`        | Registers the Postgres driver with `getDb` (side effect)                                            |
| `graphx/duck`      | Registers the DuckDB driver with `getDb` (side effect)                                              |
| `graphx/bql`       | bql.sh: a server over Hrana, or its embedded `bun:ffi` driver — `driver: 'bql'`                     |
| `graphx/embedders` | `fetch`-based embedders for OpenAI, Voyage and Ollama (no SDKs)                                     |
| `graphx/jev`       | Judgments with Jev: reranking, screening, entity resolution, typing, scoring — `fetch`, no SDK      |
| `graphx/blob`      | S3-backed blob store for node bodies                                                                |
| `graphx/ingest`    | Ingest a YAML/markdown vault into a graph (`graphx/ingest/s3` for a bucket)                         |
| `graphx/react`     | Inference-only React Query hooks + CDC live-sync                                                    |
| `graphx/mcp`       | Backs `graphx mcp` — every serving route exposed as an MCP tool                                     |
| `graphx/auth`      | Relationship-based access control (ReBAC) on graphx                                                 |
| `graphx/cli`       | The `graphx` binary                                                                                 |

Each subpath is a **separate entry point**, so an optional peer only lands on your import path if you
reach for it: `pg` by `graphx/pg`, `@duckdb/node-api` (~123 MB installed) by `graphx/duck`,
`@aws-sdk/client-s3` by `graphx/blob` and `graphx/ingest/s3`, `@modelcontextprotocol/sdk` by
`graphx/mcp`, React + React Query by `graphx/react`, and `@sqlite.org/sqlite-wasm` by
`graphx/browser`. Importing `graphx` alone drags in none of them; `graphx/expo` and `graphx/bql`
depend on nothing at all — they type Expo's SQLite module and bql.sh's driver structurally, so neither
ever loads React Native or `bql.sh` itself.

## Why graphx

Three properties of the design, rather than a feature list — each one is what the rest of this
document keeps running into.

### One schema, no codegen

Nodes and edges are Zod objects. Typed mutations, pattern matching, HTTP routes, the OpenAPI
contract, React Query hooks and MCP tools are all inferred from that one `Schema` type — there is no
generate step to run and nothing to keep in sync.

### Every write is bitemporal

Versions carry `valid_from` / `valid_to`, so history is append-only and nothing is erased — a delete
closes a version. An `asOf` read reconstructs the graph exactly as it stood at any instant.

### One contract, everywhere it runs

libSQL/SQLite, Postgres with pgvector, DuckDB over an object store, a bql.sh server, SQLite WASM in a
browser tab, or Expo SQLite on a phone. The backend is a configuration choice; every public type, method, HTTP route
and JSON payload is identical across all of them.

## Quickstart

Scaffolding a project writes a runnable `graphx.config.ts`, a `package.json` and a README. That
config is the whole contract — schema, embedder, backend — and every CLI command (and `graphx mcp`)
loads it.

```sh
$ bunx graphx new my-app
Scaffolded graphx project in my-app/

  cd my-app
  bun install        # pulls graphx from npm
  bun run serve      # http://localhost:8899
```

```ts
import { defineConfig, defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string(), region: z.enum(['us', 'eu']) }),
		gateway: z.object({ name: z.string(), firmware: z.string() }),
		alert: z.object({ severity: z.enum(['low', 'high']) }),
	},
	edges: {
		deployedAt: { from: 'gateway', to: 'site', single: true },
		raised: { from: 'gateway', to: 'alert' },
	},
});

export default defineConfig({ schema, embedder: hashEmbed(), namespace: 'graphx' });
```

Open a connection, initialise the namespace once, and write:

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

Then query it:

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

And serve it:

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

## Schema

`defineGraphSchema` is identity at runtime — its job is to capture the node and edge types precisely
enough that everything downstream can read them back out.

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

Useful inferred types: `NodeType<S>`, `Rel<S>`, `DataOf<S, K>`, `NodeOf<S, K>` and `AnyNode<S>` (a
discriminated union on `type`).

Schemas evolve without a migration step. Register upcasters and stored data is lifted to the latest
shape at read time, on every surface including HTTP:

```ts
import { defineUpcasters } from 'graphx';

const upcasters = defineUpcasters({
	// `current` is the type's schema version, stamped into data on write; `steps[i]` lifts
	// v(i+1) to v(i+2), so `steps.length` is always `current - 1`.
	gateway: { current: 2, steps: [(d) => ({ name: d.name, firmware: String(d.version ?? '0') })] },
});
const g = new Graph(db, schema, { upcasters });
```

Two constraints are enforceable in the database rather than only in code:

```ts
import { declareSingleValuedRel, declareUniqueNodeProp, materializeConstraints } from 'graphx';

await declareSingleValuedRel(db, 'deployedAt');
await declareUniqueNodeProp(db, { type: 'site', prop: 'name' });
await materializeConstraints(db, schema); // every `single` rel in the schema, in one call
```

## Writing

```ts
const gw = await g.addNode({
	type: 'gateway',
	data: { name: 'gw-1', firmware: '2.1.0' },
	body: '…',
});

await g.updateNode(gw.id, { data: { firmware: '2.2.0' } }); // shallow merge, opens a new version
await g.updateNode(gw.id, { body: 'edited' }); // the embedding input changed ⇒ re-embedded
await g.addEdge({ rel: 'raised', src: gw.id, dst: alert.id, data: { at: Date.now() } });
await g.deleteEdge(edgeId);
await g.deleteNode(gw.id); // closes the version and drops its vectors; the history is kept
```

`addNode` also accepts `uri`, `content_type` and `content_hash` for content-addressed bodies, and
`emb` / `embedding` to bind precomputed vectors. `updateNode` takes `null` to clear a content field.

**Optimistic concurrency.** Node versions carry a `revision`. Pass `expectedRevision` and a
concurrent writer's win surfaces as `RevisionConflict` instead of a silent overwrite.

**Bulk loading.** `bulkLoad` and `bulkEdges` insert history-shaped rows directly — multi-row inserts,
a shared `loadTs`, batched embedding, and (on libSQL) the ANN index and FTS trigger deferred across
the load and rebuilt after.

```ts
import { bulkLoad, bulkEdges } from 'graphx';

await bulkLoad(db, schema, rows, { embedder, chunkSize: 500 });
await bulkEdges(db, schema, edgeRows);
```

**Grouping writes.** On DuckDB, `Graph.write(fn)` folds everything the body does into one snapshot
commit; on libSQL and Postgres it just runs `fn`, because the durable state is already the database.
On SQLite and libSQL, `Graph.atomic(fn)` commits one callback inside a single transaction without
ever replaying it — use the passed scope for all database work inside the body. It requires a
namespace with no embeddings configured or recorded, which is what makes it safe to hold a writer
lease across the callback.

```ts
await g.write(async (graph) => {
	await graph.addNode({ type: 'site', data: { name: 'eu-west-1', region: 'eu' } });
	await graph.addNode({ type: 'gateway', data: { name: 'gw-2', firmware: '2.2.0' } });
});

const note = await g.atomic((scope) => scope.addNode({ type: 'note', data: { path: 'A.md' } }));
```

## Embeddings

The graph owns embedding. Every write embeds its type's input through the graph's embedder, stores
the input's hash beside the vector, and re-embeds only when that hash changes.

There is no dimension to configure. The embedder's width is probed from the model the first time a
namespace is initialised and recorded there with the model's id; a different model later is refused
until `graphx reembed` switches the namespace over.

```ts
import { openai, voyage, ollama } from 'graphx/embedders';
import { hashEmbed, fixtureEmbed, defineEmbedder } from 'graphx';

openai('text-embedding-3-small'); // OPENAI_API_KEY, optional `dim`, `baseUrl`, `batchSize`
voyage('voyage-3'); // VOYAGE_API_KEY
ollama('nomic-embed-text'); // local, no key
hashEmbed(); // deterministic and model-free — tests, demos, offline
fixtureEmbed({ path: './fixtures/emb.json' }); // record real vectors once, replay them offline
defineEmbedder({ id: 'acme:v1', embed: async (texts) => … }); // anything else
```

Each adapter is one `fetch` call, so `graphx/embedders` adds no dependency and no install weight, and
every embedder's `id` is `<provider>:<model>` — which is what a namespace recognises or refuses later.

Per-write control: `emb: number[]` binds a precomputed vector (validated against the namespace
width), `embedding: false` skips a write. Per-graph control: `embedding: 'lazy'` defers the work to
an `embedTrigger` over the outbox, and `embedding: 'off'` never embeds automatically.

Two operations keep a namespace honest, as methods or as CLI commands:

```ts
await g.embeddingReport(); // stored model + width, live/embedded/unembedded/stale counts
await g.reembed({ onProgress: (done) => … }); // re-embed every live node, or switch models
```

After three writes to a scaffolded project, `graphx doctor` reports the namespace:

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

## Reading and retrieval

```ts
await g.getNode(id); // AnyNode<S> | null
await g.getNodeVersion(id); // the version row: data, body, uri, revision, valid_from/valid_to
await g.getNodeContent(id); // body + content_type + hash
await g.neighbors(id, { rels: ['deployedAt'], direction: 'forward' }); // AnyNode[]
await g.neighborsPage(id, { rels: ['raised'], limit: 100 }); // keyset-paginated
await g.listNodes({ type: 'alert', q: 'overheating', limit: 50 }); // { nodes, nextCursor }
await g.listNodeVersions({ type: 'alert', limit: 50 }); // the same page, each row with body + revision
await g.listEdges({ rel: 'raised', source: 'jev' }); // { edges: [{ id, src, dst, weight, data, … }] }
await g.graphSlice({ type: 'gateway' }); // canvas projection: ids, labels, links
```

Every read accepts `asOf` (epoch ms) for a point-in-time view, `limits` (row cap, fan-out guard,
timeout) and `metrics`. Governance caps are the operator's, not the caller's: served over HTTP they
are set by `ServeConfig.limits` and cannot be raised by a client.

Retrieval has two entry points. Both return the same rows — the node's type and data, a score, which
leg matched it, its depth from the seed, and which seed's walk reached it.

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

A row's `via` is `'vector' | 'fts' | 'walk'`, `depth` is `0` for a seed, and `snippet` carries the
best-matching chunk for a chunked type. An `asOf` retrieve seeds from live vectors and keeps the ids
that had a version valid then — a fully retracted node cannot be seeded for a past query.

`rerank` takes any `(query, candidates) => scores` function; [Judgments with Jev](#judgments-with-jev)
has one that reads meaning, and screens for prompt injection in the same request.

## Pattern matching

`match` builds a typed pattern and compiles it to one SQL statement. `select()` is async — it does
the compiling and hands back the runnable query.

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

## Time travel

Every write is bitemporal: versions carry `valid_from` / `valid_to` (`FOREVER` = live), so history is
append-only and a delete closes an interval rather than erasing a row.

```ts
import { history, diff, changeFeed, timeline } from 'graphx';

await history(db, id); // every version of a node, oldest first
await diff(db, t1, t2); // nodes and edges added, changed and removed between two instants
await changeFeed(db, cursor, { limit: 500 }); // CDC: keyset stream of node + edge versions
await timeline(db, { buckets: 120 }); // change-point extent + density histogram + snap ticks
```

Run against the scenario above, `examples/basic-demo.ts` writes a gateway at firmware `2.1.0`, then
updates it. The read taken at the earlier instant still sees the old firmware (an excerpt of the real
output — the ids and timestamps between these lines are dropped):

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

`changeFeed` is what `graphx/react`'s `useChangeFeedSync` tails to invalidate exactly the query keys
that moved; `timeline` is what drives the admin UI's as-of scrubber.

### Branching

`fork` branches a namespace into another, empty one — the same nodes, edges, history and vectors
under the same ids — and from then on the two diverge: a write to either is invisible to the other.
With `asOf` the branch is the graph as it stood at that instant: later versions stay behind and the
versions live then are live again, so a what-if can replay from any point in the past.

```ts
import { fork } from 'graphx';

const whatIf = await g.fork(getDb('acme__what-if')); // a Graph over the branch, same schema + options
await whatIf.updateNode(id, { data: { firmware: '3.0.0' } }); // g never sees this

const replay = await g.fork(getDb('acme__replay'), { asOf: lastWeek }); // the graph as of last week

// The raw form takes two clients — on any backend, so a fork can also move a graph between them.
const { nodes, edges, needsEmbedding } = await fork(db, getDb('acme__copy'), { asOf: t1 });
```

Node and edge ids are preserved. Vectors, local blobs, declared constraints and (on a full fork) the
analytics tables travel too. On an `asOf` fork, a node whose stored vector belongs to a later version
is listed in `needsEmbedding`, and `Graph.fork` re-embeds it when the graph has an embedder. The
outbox and trigger cursors do not travel: a branch starts a fresh event log. A fork that fails
leaves nothing behind: a copy deletes what it wrote, and a native branch is deleted.

By default (`method: 'auto'`) a fork lets the backend branch the database itself when it can, and
copies rows otherwise; `ForkResult.method` says which ran (`'native'` or `'copy'`). The backend that
can today is bql.sh, for two databases on one server — see [bql.sh](#bqlsh). A copy costs time linear
in the history copied, works between any two backends, and re-mints each version's `revision`;
`method: 'copy'` forces one. `asOf` gives a consistent cut even while the source keeps writing; a full
copy of a namespace under live writes can see one write half-copied, so pass `asOf: Date.now()` for a
live namespace. `graphx fork <namespace> [--as-of <ms|ISO>]` does the same from the CLI.

## Traversal and algorithms

Traversal respects time; the analytics run over a compressed mirror of the graph and persist their
scores, so `topNodes` reads them back rather than recomputing.

```ts
import { journey, shortestPath, pagerank, community, centrality, topNodes, buildCSR } from 'graphx';

// A time-respecting walk: only edges valid at each step are followed. `from` (epoch ms) is required.
await journey(db, { start: id, from: 0, maxDepth: 6, direction: 'forward' });

await shortestPath(db, srcId, dstId, { weighted: true, rels: ['deployedAt'] });
await pagerank(db, { damping: 0.85 }); // Map<id, score>
await community(db); // label propagation → Map<id, community>
await centrality(db, 'degree'); // 'degree' | 'in' | 'out'
await topNodes(db, { by: 'pagerank', type: 'gateway', limit: 10 }); // reads persisted analytics
await topNodes(db, { by: 'score:risk', type: 'alert' }); // or a persisted score — see scoreNodes
await buildCSR(db); // the compressed mirror the analytics run over, if you want it directly
```

## Events and triggers

Three layers, each durable in a different way.

**In-process events.** Give a `Graph` an `events` sink and it emits typed create/update/delete/
supersede events after commit. Best effort, and deliberately so.

**A durable outbox.** With `events: { outbox: true }`, each event is co-written into `graph_outbox`
inside the mutation's own transaction, so it cannot be lost to a dropped driver ack. Tail it with
`outboxTail`, trim it with `pruneOutbox`.

**Declarative triggers.** Rules that ride the outbox, hosted by a process you run (`graphx triggers`)
rather than stored as rows — because their actions are functions.

```ts
import { TriggerRunner, embedTrigger, webhookAction, deadLetters } from 'graphx';

const runner = new TriggerRunner(g, {
	name: 'alerts',
	triggers: [
		{
			name: 'notify',
			match: { op: 'node.create', label: 'alert' }, // an absent field matches anything
			action: webhookAction({ url: 'https://example.com/hook', secret: process.env.HOOK }),
			retries: 5,
		},
		embedTrigger(), // the other half of `embedding: 'lazy'`
	],
});
await runner.runOnce(); // or .start() to poll
await deadLetters(db, { subscription: 'alerts' }); // what exhausted its retries, and why
```

A trigger may also carry `when: (event, graph) => boolean`, a condition on content checked before the
action and retried like it — [`jevCondition`](#filtering-and-triggering-on-meaning) asks Jev.

Delivery is at-least-once (`seq` is the dedupe key, so actions must be idempotent), and cascade
safety is provenance-based: the runner hands each action a graph tagged `trigger:<name>`, and a match
that omits `source` sees only untagged user writes — so a trigger cannot eat its own output unless it
asks to with `source: 'any'`.

## Serving over HTTP

`createApp` has two modes. Pass `control` for a production deployment; omit it for the dev bootstrap,
which mints an in-memory control plane plus one tenant/project/user and seeds the graph.

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

Production takes the control-plane client and an authn function instead:

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

Every route lives under `/t/{tenant}/p/{project}/…` and resolves to one project database, so tenant
isolation is by construction rather than by a `WHERE` clause: nodes and edges (and the edge list),
neighbors, list and slice, schema, content and history, `retrieve` and `hybrid`, `match`, `journey`, `diff`, `timeline`,
`bulk`, the `changes` CDC feed, an SSE `events` stream, and the algorithm routes. `/health` and
`/ready` sit outside it.

The OpenAPI document is generated from the route definitions — not hand-written — and served at
`GET /openapi.json`, with an interactive reference at `GET /docs` (`docs: false` disables it). The
typed client is `hc<AppType>`, with no codegen step. Mount `createAdminApp` under `/admin` for
operator-gated control-plane CRUD.

## React

Hooks are typed from the schema _type_ alone, so the browser bundle carries no SDK runtime and no
generated client.

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

The rest of the set: `useHistory`, `useGraphSlice`, `useHybrid`, `useJourney`, `useDiff`,
`useShortestPath`, `useTopNodes`, `usePagerank`, `useCommunity`, `useCentrality`, `useKeys`.

## MCP

`graphx mcp` speaks stdio and exposes every serving route as a tool. Local mode loads the same
`graphx.config.ts` every other command does (`-c`, default `./graphx.config.ts`) — schema, embedder,
namespace, backend — so writes validate against your schema and `retrieve` uses your model. Set
`GRAPHX_URL` (plus `GRAPHX_API_KEY`) to proxy a deployed server instead, and `--read-only` to expose
only the read tools.

```json
{
	"mcpServers": {
		"graphx": { "command": "bunx", "args": ["graphx", "mcp", "-c", "./graphx.config.ts"] }
	}
}
```

Agents should call `graphx_context` first — it returns the tenant and project ids the other tools
require. The schema is also published as an MCP resource, so a client can read the node types, edge
relations and endpoint constraints before writing anything.

## Access control

`graphx/auth` is a Zanzibar-style ReBAC engine stored in the graph itself: relationship tuples are
edges, so a permission check is a temporal graph query and `asOf` works on authorization too.

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

`createAuthApp` serves `check`, `expand`, `listObjects` and tuple writes over HTTP, with your own
`authenticate` and `resolveAuth` deciding who may ask.

## Ingest

`graphx ingest <dir>` walks a YAML/markdown vault and reconciles it into the graph: frontmatter
becomes node data, the body becomes the FTS and embedding input, and `[[wikilinks]]` become edges.
Re-running is a diff, not a re-import — unchanged files are skipped by content hash.

```ts
import { ingestDir, watchDir } from 'graphx/ingest';

await ingestDir({
	dir: './vault',
	graph: g,
	source: 'notes', // namespaces the node `uri`, so two vaults never reconcile each other
	idField: 'id', // frontmatter key giving stable identity across renames
	edgeFields: { author: 'written_by' }, // frontmatter field → typed edge
	assets: { type: 'asset' }, // ![[embeds]] become nodes
	dangling: { type: 'stub' }, // links to unwritten notes become stubs
	tags: { type: 'tag' }, // #tags become shared nodes (off by default — they make hubs)
	prune: true, // retract nodes whose files vanished, scoped to this source
});
```

Sources are pluggable: `fsSource` reads a directory, `graphx/ingest/s3` reads a bucket, and anything
implementing `Source` works. `watchDir` keeps a vault live after the first pass.

Large bodies belong in a blob store rather than a row. `graphx/blob` puts bytes in S3 —
content-addressed, with anything under `inlineLimit` kept inline as a `data:` URL — and hands back a
`uri` to store on the node:

```ts
import { createBlobStore } from 'graphx/blob';

const blobs = createBlobStore({ client: s3, bucket: 'graphx', inlineLimit: 32_768 });
const ref = await blobs.put(bytes, 'application/pdf');
await g.addNode({ type: 'doc', data: { title }, uri: ref.uri, content_hash: ref.hash });
await blobs.presign(ref.uri, 900); // a short-lived download URL
await blobs.gc(liveHashes); // drop what no live node references
```

`createLocalBlobStore` is the same interface backed by the database itself, for local-first hosts
with no bucket.

## Judgments with Jev

Some steps in a graph pipeline need judgment rather than lookup: which of these passages answers the
question, are these two nodes one entity, which relation does this link assert. `graphx/jev` makes
those steps calls to Jev, TypeSafe's System One model: state and typed questions in, calibrated
answers out — a probability of yes, a choice from options you define, or a score along levels you
describe — in a few hundred milliseconds. Answers are closed sets, so they slot into typed code, and
every choice and score comes with a confidence to gate on. Like `graphx/embedders` it is one `fetch`
call and no SDK; the key is `TYPESAFE_API_KEY`.

`createJev` is the client. Every question about one state goes in one request, answered in parallel,
and each answer is typed from its question:

```ts
import { choice, createJev, noul, score } from 'graphx/jev';

const jev = createJev(); // model 'jev-latest'; retries 429, 529 and 5xx with backoff
const { answers } = await jev.ask(
	{ alert: 'gw-7 probe read 96C, fan failed' },
	{
		team: choice('Which team owns this?', { hardware: null, firmware: null, network: null }),
		urgent: noul('Does this need action today?'),
		severity: score('How severe is it?', ['cosmetic', 'degraded', 'down']),
	},
);
answers.team.choice; // 'hardware' | 'firmware' | 'network', plus probabilities and confidence
answers.urgent.noul; // probability of yes
answers.severity.score; // 0–2, landing between levels
```

### Reranking and screening retrieval

Fusion finds candidates by shared words and nearby vectors; it cannot tell which of them answers the
question. `jevRerank` asks one yes/no relevance question per candidate, all in flight at once, and
orders by the probability of yes. A request takes a few hundred milliseconds, so reranking can be
the default rather than an opt-in.

```ts
import { jevRerank } from 'graphx/jev';

// Reads TYPESAFE_API_KEY
await g.hybridRetrieve({ query: 'overheating sensor', k: 10, rerank: jevRerank() });

jevRerank({
	minScore: 0.2, // drop candidates Jev judges unlikely to be relevant
	concurrency: 8, // requests in flight
	onError: 'keep', // an outage returns the fused order instead of failing the search
	guard: { onFlagged: (c, p) => console.warn('injection', c.id, p) }, // see below
});
```

Jev reads each candidate's type, its data and its matching chunk (or body). Replace the question
with `question: noul('…')`, or the whole state with `state: (query, candidate) => …`.

Served, the reranker belongs to the operator: `createApp({ …, rerank: jevRerank() })` applies it to
every `/hybrid` call, and `rerank` in `graphx.config.ts` does the same for `graphx serve` and
`graphx mcp`. It is never part of the request body.

What it buys, measured on real data: `examples/pantheon-graph/eval-rerank.ts` takes 171 Greek
figures two sources describe in different words, uses one source's description (name masked) as
the query, and asks retrieval to find the other source's record among 1,533.

| retrieval                 | top-1 | top-3 | top-10 |   MRR |
| ------------------------- | ----: | ----: | -----: | ----: |
| `hybridRetrieve`          |   35% |   50% |    65% | 0.449 |
| `hybridRetrieve` + rerank |   70% |   77% |    77% | 0.730 |

The right record was in the 20-candidate shortlist 77% of the time, so the reranked top-3 is at the
ceiling; the first stage there is lexical (`hashEmbed`), and a semantic embedder would raise both
rows. The run was 3,420 Jev requests in 57 seconds.

Node bodies are data, and in any ingest pipeline they are someone else's data — which an agent
reading them over `graphx mcp` would otherwise take as instructions. `guard` adds a second question
to each candidate's request — does this text try to instruct its reader? — and drops the ones that
do, at no extra latency. `jevGuard()` screens without reranking, keeping the original order; it is a
plain function, so it screens `retrieve` rows as well:

```ts
import { jevGuard } from 'graphx/jev';

const rows = await g.retrieve({ query: 'overheating sensor', k: 10 });
const safe = new Set((await jevGuard()('overheating sensor', rows)).map((s) => s.id));
rows.filter((r) => safe.has(r.id));
```

Served, `guard` is the operator's too: `createApp({ …, guard: jevGuard() })`, or `guard` in
`graphx.config.ts`, screens every `/retrieve` and `/hybrid` result before it leaves the server —
which is every retrieval an agent makes through `graphx mcp`, and `graphx mcp` says so at startup
when a config has an embedder but no guard. Reads addressed by id — a node's content, its history —
are not screened.

### Resolving duplicate entities

Two sources describing one thing produce two nodes. `resolveEntities` finds likely pairs with the
graph's own search, then asks Jev one question per pair whose three answers are the three things you
can do with it — leave it, hand it to a curator, or link it — so the outcome is the nearest answer
and there is no threshold to tune. A yes/no per compared field rides in the same request, so a
curator sees which field the two disagree on.

```ts
import { defineGraphSchema } from 'graphx';
import { sameEntityData } from 'graphx/jev';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: { deity: z.object({ name: z.string(), pantheon: z.string(), source: z.string() }) },
	edges: {
		sameAs: { from: 'deity', to: 'deity', data: sameEntityData },
		maybeSameAs: { from: 'deity', to: 'deity', data: sameEntityData },
	},
	// Candidates come from search, so a data-only type needs text to be found by.
	embedding: { deity: { text: (d) => d.name } },
});
```

```ts
import { judgePairs, resolveEntities } from 'graphx/jev';

const report = await resolveEntities(g, {
	type: 'deity',
	fields: ['name', 'pantheon'], // what Jev sees and compares — leave `source` out
	candidates: 5, // nearest same-type neighbours judged per node
	rels: { same: 'sameAs', review: 'maybeSameAs' }, // omit to report without writing
});
report.pairs.filter((p) => p.outcome === 'review'); // the curator's queue, with per-field agreement

// Or judge pairs you already have — an audit of an earlier matcher's links, say.
await judgePairs(g, [[srcId, dstId]], { fields: ['name', 'pantheon'] });
```

A written edge's `weight` is the probability of "same", and with `sameEntityData` on the rel its
data keeps the whole judgment: score, confidence, per-field agreement and the model that answered.
The write is bitemporal like any other, so a link a curator rejects is closed, not lost — and the
history of what Jev decided, and what people overturned, stays queryable.

A second run skips pairs already linked by either rel. Pairs judged different are not recorded, so
they are judged again.

The admin UI's **Review** page (`/t/:tenant/p/:project/review`) is the curator's side: it lists a
review rel's pairs with both nodes side by side, where Jev's score fell and which fields disagree,
and accepts a pair into the rel you pick — keeping the judgment, with `method: 'curator'` — or
rejects it. Either way the review edge closes, so `jevCalibration` sees the decision.

From the CLI, against the config's graph:

```sh
graphx dedupe deity --fields name,pantheon --same-rel sameAs --review-rel maybeSameAs
graphx dedupe deity --limit 100 --dry-run   # judge and report; write nothing
```

### Typing links and nodes

`graphx ingest` turns every `[[wikilink]]` into one generic `links_to` edge. `typeEdges` reads each
link in context and picks the relation it asserts, from the rels whose endpoints fit and whose data
needs nothing — or none of them. A confident answer becomes a second, typed edge beside the untyped
one, tagged `source: 'jev'`, so ingest's own reconcile never touches it; an unsure one is reported,
not written.

```ts
import { typeEdges } from 'graphx/jev';

// "Depends on [[bitemporal]]" → depends_on; "Contrast this with [[bitemporal]]" → contrasts_with
const links = await typeEdges(g, { from: 'links_to', minConfidence: 0.6 });
links.uncertain; // chosen below the bar: a curator's call
```

`inferNode` types a node from its text before it is written, and fills the fields Jev can _choose_
rather than write: enums, booleans, and strings you hand it candidates for. Every type's fields are
asked at once, in one request, and only the chosen type's are kept. Free text with no candidates is
left to you — `missing` names it.

```ts
import { inferNode } from 'graphx/jev';

const guess = await inferNode(schema, {
	body: 'PAGE: gw-2 unreachable since 03:10, checkout failing for EU customers',
	candidates: { name: ['gw-1', 'gw-2'] }, // found in code — Jev picks one, or none
});
guess.type; // 'alert' — with confidence, the filled `data`, per-field confidence, and `missing`
if (guess.valid) await g.addNode({ type: guess.type, data: guess.data as never });
```

### Filtering and triggering on meaning

`match` compiles to SQL, so it filters on structure. `jevFilter` adds the condition SQL cannot state:
one yes/no per row, in parallel, over any array — `match` rows, a `listNodes` page, `neighbors`.

```ts
import { jevFilter } from 'graphx/jev';

const rows = await (await match(schema, db).node('a', 'alert').select('a')).run();
const risky = await jevFilter(rows, {
	question: 'Does this alert describe a physical safety risk?',
	min: 0.7,
});
```

A trigger's `match` is structural too. `when` is a condition on content, checked before the action
and retried like it; `jevCondition` asks Jev, reading the node the event touched as it stood then.

```ts
import { jevCondition } from 'graphx/jev';

new TriggerRunner(g, {
	name: 'oncall',
	triggers: [
		{
			name: 'page',
			match: { op: 'node.create', label: 'alert' },
			when: jevCondition('Does this alert indicate customer-facing downtime right now?', {
				min: 0.8,
			}),
			action: webhookAction({ url: 'https://example.com/page' }),
		},
	],
});
```

### Judging what changed

`diff` lists what was written between two instants; `judgeChanges` says whether it mattered. For
every node updated in the window it compares the version at the start with the version at the end
and asks how material the edit is (cosmetic, substantive, structural), whether it contradicts what
was there, and what kind of edit it is — correction, enrichment, retraction or restatement.

```ts
import { judgeChanges } from 'graphx/jev';

for (const c of await judgeChanges(g, { from: t1, to: t2 })) {
	c.change; // 'created' | 'deleted' | 'updated' — updates carry the judgment:
	c.materiality; // 0–2
	c.contradicts; // probability the new version contradicts the old
	c.kind; // 'correction' | 'enrichment' | 'retraction' | 'restatement'
}
```

### Asking in plain words

`askGraph` turns a question into a typed call and runs it. One request picks the operation —
search, list or rank — and, asked alongside, the node type and ranking metric, all from closed sets
the schema defines. The plan is a valid call or an admission that it is unsure (`rows: null`); it is
never a malformed one.

```ts
import { askGraph } from 'graphx/jev';

const { plan, rows } = await askGraph(g, 'which gateways are the most connected?');
plan; // { op: 'top', type: 'gateway', metric: 'degree', confidence, typeConfidence }
```

`graphx ask "<question>"` does the same from the CLI, and offers every persisted `score:` metric as a
ranking.

### Scored dimensions

`topNodes` ranks by persisted analytics. `scoreNodes` makes a judgment one of them: ask one question
of every node of a type — a Score along levels you describe, or a yes/no — and it persists the answer
as `score:<metric>`, 0–1. Ranking by it is then a read, and so is combining it with other
dimensions: weights live in code, and changing one re-asks nothing.

```ts
import { score, scoreNodes } from 'graphx/jev';

await scoreNodes(g, {
	type: 'alert',
	metric: 'risk',
	question: score('How much risk does this alert describe?', [
		'None: informational',
		'Some: degraded, with a workaround',
		'Severe: an outage or a safety risk',
	]),
});
await topNodes(db, { by: 'score:risk', type: 'alert', limit: 10 });
```

`persistScores(db, metric, [[id, score], …])` writes a `score:` metric from anywhere else.

### Classifying into a taxonomy

When the taxonomy lives in the graph, classify down it. `classifyInto` starts at a root and descends
a rel: at each category one choice over its children — or "none, stop here" — with the `beam` most
probable paths going on. A new category is a new node, with nothing to retrain, and `asOf`
classifies against the taxonomy as it stood then.

```ts
import { classifyInto } from 'graphx/jev';

const [best] = await classifyInto(g, {
	root: id,
	rel: 'subcategory',
	text: 'a humpback whale',
	beam: 3,
});
best?.path; // [{ label: 'life' }, { label: 'animals' }, { label: 'mammals' }, { label: 'cetaceans' }]
```

### Checking calibration

Every edge Jev writes carries its probability as `weight` and `source: 'jev'`, and the write is
bitemporal — so history already records what Jev decided and what people later closed.
`jevCalibration` buckets those edges by weight and reads off each bucket's overturn rate: the number
to set `minConfidence` and review thresholds against, measured on your own data.

```ts
import { jevCalibration } from 'graphx/jev';

for (const b of await jevCalibration(g, { rel: 'sameAs', buckets: 5 })) {
	b.range; // e.g. [0.8, 1]
	b.closedRate; // share of those links a curator has since closed
}
```

## Backends

The backend is selected by configuration only. Connections come from `getDb(namespace, config)`,
which caches one client per project namespace.

### libSQL and SQLite (default)

```ts
const db = getDb('acme__alpha'); // file:acme__alpha.db
```

No `driver` needed. For embedded-replica mode set `SQLD_URL` / `SQLD_TOKEN` (or `config.syncUrl` /
`config.authToken`) and call `syncIfReplica` before serving. Vector search uses libSQL's ANN index;
full text uses FTS5.

### Postgres

Import `graphx/pg` once to register the adapter. It is a side effect, and it is what keeps `pg` an
optional peer — loaded only by consumers who opt in.

```ts
import 'graphx/pg'; // registers the Postgres driver (side effect)

const db = getDb('acme__alpha', {
	driver: 'postgres',
	connectionString: 'postgresql://user:pass@host:5432/graphx',
	// ssl?: boolean | tls.ConnectionOptions
	// poolMax?: number
});
```

`GRAPHX_DB_DRIVER=postgres` (with `GRAPHX_PG_URL`) selects it globally, but the `import 'graphx/pg'`
is still required or `getDb` throws. Each namespace holds its own pool (10 connections unless
`poolMax` says otherwise); a host serving many namespaces sets `GRAPHX_PG_POOL_MAX` to shrink every
pool it did not size explicitly.

Each namespace maps to a Postgres **schema** on a shared pool, created lazily — one server credential
serves every tenant. **Behind a transaction pooler** (PgBouncer, pgcat, Supavisor) there is nothing
to configure: the adapter normally sets the tenant `search_path` as a connect-time option, and when a
pooler rejects that it switches to `SET LOCAL` inside every statement's transaction and retries. Set
`pooler: 'transaction'` to skip the probe, or `pooler: 'none'` to forbid the switch.

**Prerequisite:** pgvector must exist in the target database.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

One-time and idempotent per database; it needs a role allowed to create extensions. The
`pgvector/pgvector:pg16` image ships it ready to enable.

### DuckDB over an object store

Its durable state is a chain of immutable snapshots in S3 or a local directory: each commit writes
content-addressed Parquet and claims the next numbered manifest with a create-if-absent PUT, so the
bucket is the database and the local DuckDB file is a materialization of one snapshot.

```ts
import 'graphx/duck'; // registers the DuckDB driver (side effect)

const db = getDb('acme__alpha', { driver: 'duckdb' });
```

**One writer process per namespace, readers unbounded.** Writes inside a process serialize on a
client-held mutex; across processes the manifest CAS picks a winner and the loser rebases. Two
processes rewriting the _same table_ of one namespace cannot merge — that raises
`SnapshotConflictError` (HTTP 409) rather than silently dropping the loser's rows. `Graph.write(fn)`
groups a body into a single snapshot commit.

Local database files and DuckDB's temp spill are anchored under `./.graphx-data/` rather than the
process working directory — override with `GRAPHX_DATA_DIR`. Spill is capped by `GRAPHX_DUCK_MAX_TEMP`
(default `16GB`), so a query that outgrows memory fails as a query instead of filling the disk.

### bql.sh

[bql.sh](https://bql.sh) is SQLite as a multi-tenant server for Bun: thousands
of small databases in one process, their WAL frames streamed to replicas, continuous backup to any
S3-compatible bucket with point-in-time restore, and realtime driven by SQLite's own hooks. graphx's
namespace-per-tenant model is the shape bql.sh was built for, so one namespace is one bql.sh database.

It is a **plain libsqlite3**, so graphx speaks the `sqlite` dialect to it — the one the browser and
Expo drivers use — rather than the libSQL one, whose `F32_BLOB` and `vector_top_k` exist only in
libSQL's fork. FTS5 is compiled into bql.sh's pinned build, so lexical retrieval is unchanged; vector
search is exact rather than ANN.

```ts
import 'graphx/bql'; // registers the bql.sh driver (side effect)

const db = getDb('acme__alpha', {
	driver: 'bql',
	bqlUrl: 'http://127.0.0.1:4321', // the server's ORIGIN
	authToken: process.env.BQL_TOKEN,
});
```

`GRAPHX_DB_DRIVER=bql` with `GRAPHX_BQL_URL` / `GRAPHX_BQL_TOKEN` selects it globally, and the
`import 'graphx/bql'` is still required or `getDb` throws. The namespace becomes the database name,
case-folded — a bql.sh database name is lower case and a ULID is not. The driver creates that database on first
use, the way the Postgres adapter creates a tenant's schema; creating one is an admin route, so the
token has to be an admin key. Call `createBqlRemoteClient` with `ensureDatabase: false` when
namespaces are provisioned outside graphx.

Two things to know before choosing it:

- **Vector search is exact, not ANN.** This dialect stores embeddings as JSON text and ranks them in
  the client, so every vector in the namespace crosses the socket on every query and a large one
  meets bql.sh's `maxRows` cap first. Fine for a lexical-first graph or a small vector set; libSQL and
  Postgres are the ANN-backed backends.
- **Foreign keys are off by default in bql.sh**, and graphx's schema declares them. The driver turns
  them on for a database it creates (`PATCH /v1/db/{db}`); for one you provisioned, set `[sqlite]
foreignKeys` on the node or configure that database. A tenant statement cannot set a pragma at all
  — bql.sh's authorizer denies it — so this client is tagged `managedPragmas` and graphx issues none.

Writes must address the primary: a replica's Hrana surface answers `NOT_PRIMARY` rather than
forwarding.

**Forks are native.** When [`fork`](#branching)'s source and target are two databases on the same
bql.sh server and the target does not exist yet, graphx asks bql.sh to branch the database
(`POST /v1/db` with `from`) instead of copying rows. bql.sh copies the database file — a reflink,
sharing every block until one side writes, where the filesystem has them — and records the branch's
parent. graphx then trims the branch in place to exactly what a copy would have produced: the event
log is cleared and, with `asOf`, versions that began after the cut are dropped and those open at it
reopened. bql.sh's own point-in-time fork is not used for `asOf`: it cuts by commit time, graphx cuts
by valid time, and history loaded with `bulkLoad` carries valid times from before the database
existed. A target that already exists, another server or a token that cannot create databases falls
back to the copy.

```ts
import 'graphx/bql';
import { fork, getDb } from 'graphx';

const bql = {
	driver: 'bql',
	bqlUrl: 'http://127.0.0.1:4321',
	authToken: process.env.BQL_TOKEN,
} as const;
const branch = await fork(getDb('city', bql), getDb('city__what_if', bql), { asOf: lastWeek });
branch.method; // 'native': bql.sh branched the file, graphx trimmed it to lastWeek
```

**Embedded**, bql.sh's `bun:ffi` driver replaces the `libsql` package inside your own process and adds
what no other graphx driver has — commit and preupdate hooks, an authorizer, session changesets, a
statement deadline and `interrupt()`. Pass the module; `graphx/bql` never imports it.

```ts
import { openBqlDb } from 'graphx/bql';

const client = await openBqlDb(bqlSqlite, '/var/lib/graphx/acme__alpha.db');
await init(client, embedder);

// A change feed with nothing to poll: the hook fires on the mutation's own commit.
client.database.onCommit(() => {
	refresh();
});
```

bql.sh, as a server or embedded, needs the libsqlite3 it pins, built once per machine with a C
compiler — `bun run node_modules/bql.sh/packages/db/scripts/sqlite.ts` after `bun add bql.sh` — which
is why bql.sh is opt-in rather than the default. In this repo, `bun run bql:build` builds it and
`bun run bql:serve` starts a local bql.sh server and prints the `GRAPHX_BQL_URL` /
`GRAPHX_BQL_TOKEN` it serves on.

## Local-first runtimes

`graphx/core` is the same graph engine with the drivers and the HTTP/control-plane layer removed: no
Node built-ins, no `TextEncoder`, no `atob`. Give it a `DbClient` and it runs wherever you are —
schema init, typed writes, bitemporal reads, FTS, pattern matching, traversal and algorithms all
included. Hosts need standard timers and `crypto.getRandomValues` for ULID creation.

```ts
// Node or Bun — an owned native libSQL file, or a private RAM namespace
import { openLocalDb, openMemoryDb } from 'graphx/local';
import { Graph, init } from 'graphx/core';

const client = await openLocalDb('/Users/me/vault.db'); // WAL + FULL sync, verified
await init(client);
const g = new Graph(client, schema);
```

```ts
// Browser — SQLite WASM on OPFS, inside a dedicated worker with COOP/COEP set
import { openBrowserDb } from 'graphx/browser';

const client = await openBrowserDb(sqlite3, '/vault.sqlite3');
await init(client);
```

```ts
// Expo — native SQLite on iOS and Android
import { openExpoDb } from 'graphx/expo';
import * as SQLite from 'expo-sqlite';

const client = await openExpoDb(SQLite, 'vault.db');
await init(client);
```

Each opener owns its connection exclusively and verifies the pragmas it depends on rather than
assuming them — a host that cannot give durable storage fails loudly instead of quietly running in
memory. `openBrowserDb` uses rollback journaling so several tabs can share the file; competing
writers can still get `SQLITE_BUSY` and must retry the whole operation. `Graph.atomic` is the
transaction primitive on these runtimes, and it requires a namespace without embeddings.

## CLI

```
graphx new      <dir>                     Scaffold a starter project
graphx serve    [-c config] [-p 8899]     Typed HTTP routes + /openapi.json + /docs
graphx ingest   <dir> [options]           Ingest a vault into the graph
graphx triggers [-c config]               Run declarative triggers over the event outbox
graphx mcp      [-c config] [--read-only] Serve the graph to an MCP client over stdio
graphx reembed  [-c config] [--dry-run]   Re-embed every live node (also switches models)
graphx doctor   [-c config]               Embedding model, width and health of the namespace
graphx fork     <namespace> [-c config]   Branch the namespace into an empty one (--as-of <ms|ISO>)
graphx dedupe   <type> [-c config] [...]  Find duplicate nodes of a type and judge them with Jev
graphx ask      "<question>" [-c config]  Plan a plain-language question as a graph call, and run it
```

Every command except `new` loads `graphx.config.ts` (`--config`, `-c`; default `./graphx.config.ts`).
The CLI runs on Node >= 22.18 (`npx graphx`), which loads the TypeScript config natively, or on Bun
(`bunx --bun graphx`).

`ingest` options: `--source <id>`, `--id-field <name>`, `--prune`, `--watch`, `--assets-type <type>`,
`--edge-field <field=rel>` (repeatable), `--dangling-type <type>`, `--tags-type <type>`.

## Examples

Every example in this repo runs against a real graph — two of them against corpora large enough that
the as-of scrubber has something to say.

- [`examples/basic-demo.ts`](https://github.com/TimMikeladze/graphx/blob/main/examples/basic-demo.ts) — the whole API in one file: schema, init,
  write, read, query, retrieve, time travel. `bun run examples/basic-demo.ts`.
- [`examples/seaport-traffic.ts`](https://github.com/TimMikeladze/graphx/blob/main/examples/seaport-traffic.ts) — a traffic-engineering what-if on
  a geospatial graph: intersections with lat/lng and signal timing, road segments weighted in
  seconds, rush hour as a new version of the roads, and a retimed light in a branch forked at 8am.
  `bun run examples/seaport-traffic.ts`.
- [`examples/seaport-traffic-bql`](https://github.com/TimMikeladze/graphx/blob/main/examples/seaport-traffic-bql) — the same what-if on an
  embedded bql.sh server, where the 8am branch is a native fork: bql.sh branches the database file
  and graphx trims it to 8am. `bun run sqlite:build` once, then `bun run start`.
- [`examples/iot-fleet`](https://github.com/TimMikeladze/graphx/blob/main/examples/iot-fleet) — end-to-end Vite + Bun + SQLite + React app. Run
  `bun run server.ts` and `bun run dev` in two shells, or `bun test` for an in-process run with no
  server and no port.
- [`examples/vault-ingest`](https://github.com/TimMikeladze/graphx/blob/main/examples/vault-ingest) — ingest a markdown vault.
- [`examples/mma-graph`](https://github.com/TimMikeladze/graphx/blob/main/examples/mma-graph) — a real vault at real scale, scraped to order:
  every fighter, fight and event across MMA history pulled from Wikipedia into markdown, ingested
  with `graphx/ingest`, and served by a Next.js app — server-component dashboard, temporal API
  (records as of any date, championship reigns rebuilt from title fights) and graphx's generated
  routes side by side — plus `scrape.ts tail` to keep it minutes-fresh or watch a card land
  live as bitemporal history. `bun run dev:mma` after `bun scrape.ts full` in the example dir.
- [`examples/file-upload-ingest.ts`](https://github.com/TimMikeladze/graphx/blob/main/examples/file-upload-ingest.ts) — blob-backed ingestion.
- [`examples/pantheon-graph`](https://github.com/TimMikeladze/graphx/blob/main/examples/pantheon-graph) — a real graph from a real corpus: ~10k
  deities across 109 pantheons, with contradictory sources kept unmerged. `bun run dev:pantheon`
  builds it and opens it in the admin UI.
- [`examples/skills-graph`](https://github.com/TimMikeladze/graphx/blob/main/examples/skills-graph) — occupations, skills and 2.7M observed job
  moves dated from 1955 to 2024, so the as-of scrubber shows seventy years of a labour market.
  `bun run dev:skills`.

## Contributing

```sh
bun install       # from the repo root
bun test          # the full suite — runs in a temp dir that is deleted afterwards
bun run clean:db  # sweep stray scratch databases (also runs on install and pre-commit)
GRAPHX_TEST_DRIVER=bql bun test  # the suite on bql.sh, with `bun run bql:serve`'s two variables set
bun run type-check
bun run build     # bunup, every entry point
bun run dev:admin # the operator SPA against a dev server
bun run bench     # the benchmark suites
bun run bench:benchable --latest --out bench/benchable.json  # newest result as a Benchable run
bunx benchable submit --metrics bench/benchable.json           # send it (BENCHABLE_KEY, or benchable login)
bun run release                            # bump, rebuild site + package README, commit, tag, push
bun run publish:npm                        # build and publish `graphx` to npm (prompts for the OTP)
```

This file is the documentation. Two things are generated from it and checked by the suite, so
neither can drift: `packages/graphx/README.md`, the copy npm shows on the package page
(`bun run sync:readme`), and the [graphx.sh](https://graphx.sh) landing page, which is generated
from it (`site/`, output committed in `site/public/`). Every TypeScript block here is compiled against the built package
by `test/readme-examples.test.ts`.

The admin SPA (`packages/admin`) is not published — it is the operator UI, run from this repo. To
hack on graphx from another project, add that project's path to the root `package.json` `workspaces`
array so the `workspace:` dependency resolves.

See [CONTRIBUTING.md](https://github.com/TimMikeladze/graphx/blob/main/CONTRIBUTING.md) for the rest.

## License

MIT © [Tim Mikeladze](https://github.com/TimMikeladze)
