# graphx

[graphx.sh](https://graphx.sh)

Temporal GraphRAG on libSQL/SQLite, Postgres, or DuckDB. Define a graph once with Zod, then get typed
mutations, bitemporal history, vector + full-text retrieval, pattern matching, traversal, graph
algorithms, an HTTP API with a generated OpenAPI contract, React Query hooks, and an MCP server —
no codegen anywhere.

## Install

```sh
bun add graphx
```

One package, one version. Everything below is a subpath of it — there is nothing else to install
and nothing to keep in lockstep.

| Import             | What it is                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- |
| `graphx`           | The SDK: schema, embedders, data layer, retrieval, temporal reads, algorithms, serving |
| `graphx/embedders` | `fetch`-based embedders for OpenAI, Voyage, and Ollama (no SDKs)                       |
| `graphx/pg`        | Registers the Postgres driver with `getDb` (side effect)                               |
| `graphx/duck`      | Registers the DuckDB driver with `getDb` (side effect)                                 |
| `graphx/blob`      | S3-backed blob store for node bodies                                                   |
| `graphx/cli`       | The `graphx` binary                                                                    |
| `graphx/ingest`    | Ingest a YAML/markdown vault into a graph (`graphx/ingest/s3` for a bucket)            |
| `graphx/react`     | Inference-only React Query hooks + CDC live-sync                                       |
| `graphx/mcp`       | Backs `graphx mcp` — every serving route exposed as an MCP tool                        |
| `graphx/auth`      | Relationship-based access control (ReBAC) on graphx                                    |

One binary ships with it: `graphx` — `new`, `ingest`, `serve`, `triggers`, `mcp`, `reembed`, `doctor`.

Each subpath is a **separate entry point**, so an optional peer is only pulled onto your import
path if you actually reach for it — `pg` by `graphx/pg`, `@duckdb/node-api` (~123MB installed) by
`graphx/duck`, `@aws-sdk/client-s3` by `graphx/blob` and `graphx/ingest/s3`,
`@modelcontextprotocol/sdk` by `graphx/mcp`, and React + React Query by `graphx/react`. Importing
`graphx` alone drags in none of them.

The admin SPA (`packages/admin`) is not published — it is the operator UI, run from this repo
(`bun run dev:admin`).

To hack on graphx itself, work inside this repo: `bun install` from the root, and add your app's
path to the root `package.json` `workspaces` array so the `workspace:` dep resolves.

## Quickstart

```sh
bunx graphx new my-app
```

That writes a runnable `graphx.config.ts`, `package.json`, and README. The config is the whole
contract — schema, embedder, backend:

```ts
import { defineConfig, defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: { note: z.object({ title: z.string().optional() }) },
	edges: { links_to: { from: 'note', to: 'note' } },
});

export default defineConfig({
	schema,
	embedder: hashEmbed(), // deterministic, model-free — swap in openai('text-embedding-3-small') from 'graphx/embedders'
	namespace: 'graphx',
});
```

There is no dimension to configure. The embedder's width is probed from the model and recorded in
the namespace the first time it is initialised, together with the model's id; a different model later
is refused until `graphx reembed` switches the namespace over.

## CLI

```
graphx new      <dir>                     Scaffold a starter project
graphx serve    [-c config] [-p 8899]     Typed HTTP routes + /openapi.json + /docs
graphx ingest   <dir> [options]           Ingest a vault into the graph
graphx triggers [-c config]               Run declarative triggers over the event outbox
graphx mcp      [-c config] [--read-only] Serve the graph to an MCP client over stdio
graphx reembed  [-c config] [--dry-run]   Re-embed every live node (also switches models)
graphx doctor   [-c config]               Embedding model, width, and health of the namespace
```

`ingest` options: `--source <id>`, `--id-field <name>`, `--prune`, `--watch`, `--assets-type <type>`,
`--edge-field <field=rel>` (repeatable), `--dangling-type <type>`, `--tags-type <type>`.

## Using the SDK

```ts
import { getDb, init, Graph, defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string(), region: z.enum(['us', 'eu', 'apac']) }),
		gateway: z.object({ name: z.string(), firmware: z.string() }),
	},
	edges: {
		deployedAt: { from: 'gateway', to: 'site', single: true },
	},
	// Optional per-type policy: what text a node is embedded from (default: its `body`), and
	// whether long inputs are split into chunks. A data-only type stays searchable this way.
	embedding: {
		site: { text: (d) => `${d.name} (${d.region})` },
	},
});

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

await g.updateNode(gw.id, { data: { firmware: '2.2.0' } }); // shallow merge, opens a new version; body unchanged ⇒ no re-embed
await g.updateNode(gw.id, { body: 'edited' }); // the embedding input changed ⇒ re-embedded
await g.deleteNode(gw.id); // closes the version and drops its vectors; the history is kept
```

The graph owns embedding: every write embeds its type's input through the graph's embedder, hashes
that input beside the vector, and re-embeds only when the hash changes. `emb: number[]` binds a
precomputed vector instead (validated against the namespace width); `embedding: false` skips a
write; `embedding: 'lazy'` on the graph defers the work to `embedTrigger` over the outbox.

Reads on `Graph`: `getNode`, `getNodeContent`, `neighbors`, `neighborsPage`, `listNodes`,
`graphSlice`.

```ts
await g.neighbors(gw.id, { rels: ['deployedAt'], direction: 'forward' }); // AnyNode[]
const page = await g.listNodes({ type: 'alert', limit: 50 }); // { nodes, nextCursor }
```

Every write is bitemporal. Versions carry `valid_from` / `valid_to` (`FOREVER` = live), so history is
append-only and `asOf` reads reconstruct the graph as it stood at any timestamp.

### Retrieval and queries

```ts
import { match, journey, history, diff, shortestPath, pagerank } from 'graphx';

// GraphRAG: vector seeds, then a time-respecting walk out from them. Every row carries the
// node's type + data, a score, which leg matched it (vector / fts / walk), and its seed.
await g.retrieve({ query: 'overheating sensor', k: 10, maxDepth: 2, rels: ['raised'] });

// Vector + full-text fused with RRF, optional rerank / MMR
await g.hybridRetrieve({ query: 'overheating sensor', k: 10 });

// Pattern match — rows typed per alias. `select()` is async: it compiles the SQL and
// hands back the runnable query, so await it before `.run()` / `.page()`.
const q = await match(schema, db)
	.node('d', 'device')
	.in('raised')
	.node('a', 'alert')
	.select('d', 'a');
const rows = await q.run(); // rows[0].d.data, rows[0].a.data

// Traversal and analytics
await journey(db, { start: id, from: 0, maxDepth: 6, direction: 'forward' }); // `from` (epoch ms) is required
await shortestPath(db, srcId, dstId);
await pagerank(db);

// Time travel
await history(db, id); // every version of a node
await diff(db, t1, t2); // what changed between two instants
```

Read paths accept `asOf` (point-in-time), `limits` (row cap, fan-out guard, timeout), and `metrics`.

## Serving

`createApp` has two modes. Pass `control` for a production deployment; omit it for the dev bootstrap,
which mints an in-memory control plane plus one tenant/project/user and seeds the graph:

```ts
import { createApp, hashEmbed } from 'graphx';
import { schema } from './schema.ts';

const { app, tenant, project, user } = await createApp({
	schema,
	embedder: hashEmbed(), // every project namespace is sized to it on first touch; every write embeds through it
	db: 'iot_demo',
	cors: true,
	openapi: { title: 'iot-fleet', servers: [{ url: 'http://localhost:8899' }] },
	seed: async (g) => {
		await g.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
	},
});

Bun.serve({ port: 8899, fetch: app.fetch });
```

The contract is generated from the routes and served at `GET /openapi.json`, with an interactive
reference at `GET /docs` (set `docs: false` to disable).

## React

Hooks are typed from the schema _type_ alone, so the browser bundle carries no SDK runtime:

```tsx
import { GraphProvider, createGraphHooks } from 'graphx/react';
import type { Schema } from './schema.ts';

const g = createGraphHooks<Schema>();

// <GraphProvider bootstrap="/demo"> fetches the tenant/project/user ids itself
g.useNode(id, 'gateway'); // NodeOf<Schema,'gateway'> | null
g.useNeighbors(id, { rel: 'deployedAt' }); // site[]
g.useListNodes({ type: 'alert' }); // alert[]
g.useMatch((q) => q.node('d', 'device').in('raised').node('a', 'alert').select('d', 'a'));
g.useChangeFeedSync(); // tails /changes, invalidates exact keys
```

## MCP

`graphx mcp` speaks stdio and exposes every serving route as a tool. Local mode loads the same
`graphx.config.ts` every other command does (`-c`, default `./graphx.config.ts`) — schema, embedder,
namespace, backend — so writes validate against your schema and `retrieve` uses your model. Set
`GRAPHX_URL` (+ `GRAPHX_API_KEY`) to proxy a deployed server instead. Agents should call
`graphx_context` first — it returns the tenant and project ids the other tools require.

## Examples

- [`examples/iot-fleet`](./examples/iot-fleet) — end-to-end Vite + Bun + SQLite + React app. Run
  `bun run server.ts` and `bun run dev` in two shells, or `bun test` for an in-process run with no
  server and no port.
- [`examples/vault-ingest`](./examples/vault-ingest) — ingest a markdown vault.
- [`examples/file-upload-ingest.ts`](./examples/file-upload-ingest.ts) — blob-backed ingestion.
- [`examples/pantheon-graph`](./examples/pantheon-graph) — a real graph from a real corpus: ~10k
  deities across 109 pantheons, with contradictory sources kept unmerged. `bun run dev:pantheon`
  builds it and opens it in the admin UI.
- [`examples/skills-graph`](./examples/skills-graph) — occupations, skills, and 2.7M observed job
  moves dated from 1955 to 2024, so the as-of scrubber shows seventy years of a labour market.
  `bun run dev:skills`.

## Database backend

graphx runs on **libSQL/SQLite** (default), **Postgres** (with [pgvector](https://github.com/pgvector/pgvector)), or **DuckDB** over an object store. The backend is selected by configuration only — every public type, method, HTTP route, and JSON contract is identical across both.

Connections come from `getDb(namespace, config)`, which caches one client per project namespace (tenant).

### libSQL (default)

```ts
import { getDb } from 'graphx';

const db = getDb('acme__alpha'); // file:acme__alpha.db
```

No `driver` is needed. For embedded-replica mode, set `SQLD_URL` / `SQLD_TOKEN` (or `config.syncUrl` / `config.authToken`).

### Postgres

Import the `graphx/pg` subpath once to register the Postgres adapter with `getDb`. This is a side effect, and it keeps `pg` an optional peer dependency — loaded only by consumers who opt in:

```ts
import 'graphx/pg'; // registers the Postgres driver (side effect)
import { getDb } from 'graphx';

const db = getDb('acme__alpha', {
	driver: 'postgres',
	connectionString: 'postgresql://user:pass@host:5432/graphx',
	// ssl?: boolean | tls.ConnectionOptions
	// poolMax?: number
});
```

Alternatively, select Postgres globally with `GRAPHX_DB_DRIVER=postgres` (and `GRAPHX_PG_URL` for the connection string). You must still `import 'graphx/pg'` once, or `getDb` throws.

**Behind a transaction pooler** (PgBouncer, pgcat, Supavisor): nothing to configure. The adapter
normally sets the tenant `search_path` as a connect-time option; a transaction pooler rejects that,
so on the first query it switches to applying `search_path` with `SET LOCAL` inside every
statement's transaction and retries. Set `pooler: 'transaction'` to skip the probe, or
`pooler: 'none'` to forbid the switch.

**Tenant model.** Each namespace maps to a Postgres **schema** on a shared connection pool, created lazily — one server credential serves every tenant. (libSQL uses one file/replica per namespace instead.)

**Prerequisite.** The `vector` extension (pgvector) must exist in the target database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This is a one-time, idempotent setup per database and needs a role allowed to create the extension (e.g. a superuser). The `pgvector/pgvector:pg16` Docker image ships pgvector ready to enable.

### DuckDB (object-store backed)

A third adapter, registered the same way. Its durable state is a chain of immutable snapshots in an object store (S3 or a local directory): each commit writes content-addressed Parquet files and claims the next numbered manifest with a create-if-absent PUT, so the bucket is the database and the local DuckDB file is a materialization of one snapshot.

```ts
import 'graphx/duck'; // registers the DuckDB driver (side effect)
import { getDb } from 'graphx';

const db = getDb('acme__alpha', { driver: 'duckdb' });
```

`@duckdb/node-api` is an optional peer (~123MB installed) and is only pulled in by this subpath.

Local database files and DuckDB's temp spill are anchored under `./.graphx-data/` rather than the
process working directory — override with `GRAPHX_DATA_DIR`. Spill is capped by
`GRAPHX_DUCK_MAX_TEMP` (default `16GB`), so a query that outgrows memory fails as a query instead
of filling the disk.

**One writer process per namespace, readers unbounded.** Writes inside a process serialize on a client-held mutex; across processes the manifest CAS picks a winner and the loser rebases. Two processes rewriting the _same table_ of one namespace cannot merge — that raises `SnapshotConflictError` (HTTP 409) rather than silently dropping the loser's rows. `Graph.write(fn)` groups a body into a single snapshot commit.

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT © [Tim Mikeladze](https://github.com/TimMikeladze)
