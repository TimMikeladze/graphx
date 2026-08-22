# graphx

Temporal GraphRAG on libSQL/SQLite, Postgres, or DuckDB. Define a graph once with Zod, then get typed
mutations, bitemporal history, vector + full-text retrieval, pattern matching, traversal, graph
algorithms, an HTTP API with a generated OpenAPI contract, React Query hooks, and an MCP server —
no codegen anywhere.

## Packages

| Package          | What it is                                                                   |
| ---------------- | ---------------------------------------------------------------------------- |
| `@graphx/core`   | The SDK: schema, data layer, retrieval, temporal reads, algorithms, serving  |
| `@graphx/cli`    | `graphx` binary — `new`, `ingest`, `serve`, `triggers`                       |
| `@graphx/ingest` | Ingest a YAML/markdown vault (or S3 bucket) into a graph                     |
| `@graphx/react`  | Inference-only React Query hooks + CDC live-sync                             |
| `@graphx/mcp`    | `graphx-mcp` — every serving route exposed as an MCP tool                    |
| `@graphx/auth`   | Relationship-based access control (ReBAC) on graphx                          |
| `@graphx/admin`  | Admin SPA (Vite + shadcn; Cosmograph / xyflow canvas, node + edge authoring) |

```sh
bun add @graphx/core          # the SDK
bun add @graphx/react         # + React Query hooks
bun add -d @graphx/cli        # + the `graphx` binary
```

`@graphx/admin` is not published — it is the operator SPA, run from this repo (`bun run dev:admin`).

To hack on graphx itself, work inside this repo: `bun install` from the root, and add your app's
path to the root `package.json` `workspaces` array so the `workspace:` deps resolve.

## Quickstart

```sh
bunx @graphx/cli new my-app
```

That writes a runnable `graphx.config.ts`, `package.json`, and README. The config is the whole
contract — schema, embedder, dimension, backend:

```ts
import { defineGraphSchema, hashEmbed } from '@graphx/core';
import { z } from 'zod';

export const schema = defineGraphSchema({
	nodes: { note: z.object({ title: z.string().optional() }) },
	edges: { links_to: { from: 'note', to: 'note' } },
});

export default {
	schema,
	embed: hashEmbed(768), // deterministic, model-free — swap in a real model for production
	dim: 768,
	namespace: 'graphx',
};
```

`dim` is baked into the vector column at first init and cannot be changed later. It must match your
embedder's output width, or every insert fails on a dimension mismatch.

## CLI

```
graphx new      <dir>                     Scaffold a starter project
graphx serve    [-c config] [-p 8899]     Typed HTTP routes + /openapi.json + /docs
graphx ingest   <dir> [options]           Ingest a vault into the graph
graphx triggers [-c config]               Run declarative triggers over the event outbox
```

`ingest` options: `--source <id>`, `--id-field <name>`, `--prune`, `--watch`, `--assets-type <type>`,
`--edge-field <field=rel>` (repeatable), `--dangling-type <type>`, `--tags-type <type>`.

## Using the SDK

```ts
import { getDb, init, Graph, defineGraphSchema, hashEmbed } from '@graphx/core';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string(), region: z.enum(['us', 'eu', 'apac']) }),
		gateway: z.object({ name: z.string(), firmware: z.string() }),
	},
	edges: {
		deployedAt: { from: 'gateway', to: 'site', single: true },
	},
});

const embed = hashEmbed(768);
const db = getDb('acme__alpha'); // one cached client per namespace (tenant)
await init(db, 768); // tables, indexes, vector column
const g = new Graph(db, schema);

const site = await g.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
const body = 'free text — indexed for FTS, and embedded for vector search when `emb` is supplied';
const gw = await g.addNode({
	type: 'gateway',
	data: { name: 'gw-1', firmware: '2.1.0' },
	body,
	emb: await embed(body), // `Graph` never calls the embedder for you — see below
});
await g.addEdge({ rel: 'deployedAt', src: gw.id, dst: site.id });

await g.updateNode(gw.id, { data: { firmware: '2.2.0' } }); // shallow merge, opens a new version
await g.deleteNode(gw.id); // closes the version; nothing is erased
```

`Graph` is embedder-free by design: `emb` is a plain `number[]` you pass in (the serving layer and
`bulkLoad` embed on your behalf). Omit it and the node's vector column stays NULL — it is still
found by FTS and by `hybridRetrieve`, but never by the ANN seeds `retrieve` runs on.

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
import {
	retrieve,
	hybridRetrieve,
	match,
	journey,
	history,
	diff,
	shortestPath,
	pagerank,
} from '@graphx/core';

// GraphRAG: ANN seeds, then a time-respecting walk out from them
await retrieve(db, embed, { query: 'overheating sensor', k: 10, maxDepth: 2, rels: ['raised'] });

// Vector + FTS5 fused with RRF, optional rerank / MMR
await hybridRetrieve(db, embed, { query: 'overheating sensor', k: 10 });

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
import { createApp, hashEmbed } from '@graphx/core';
import { schema } from './schema.ts';

const { app, tenant, project, user } = await createApp({
	schema,
	embed: hashEmbed(), // dim is derived from the embedder when omitted
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
import { GraphProvider, createGraphHooks } from '@graphx/react';
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

`graphx-mcp` speaks stdio and exposes every serving route as a tool. Configure it with environment
variables: `GRAPHX_DB` (local mode) or `GRAPHX_URL` + `GRAPHX_API_KEY` (remote mode), plus
`GRAPHX_SCHEMA` (path to a JSON schema document) and `GRAPHX_MCP_READ_ONLY`. Without `GRAPHX_SCHEMA`,
local mode runs schemaless and every write tool returns 400. Agents should call `graphx_context`
first — it returns the tenant and project ids the other tools require.

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
import { getDb } from '@graphx/core';

const db = getDb('acme__alpha'); // file:acme__alpha.db
```

No `driver` is needed. For embedded-replica mode, set `SQLD_URL` / `SQLD_TOKEN` (or `config.syncUrl` / `config.authToken`).

### Postgres

Import the `core/pg` subpath once to register the Postgres adapter with `getDb`. This is a side effect, and it keeps `pg` an optional peer dependency — loaded only by consumers who opt in:

```ts
import '@graphx/core/pg'; // registers the Postgres driver (side effect)
import { getDb } from '@graphx/core';

const db = getDb('acme__alpha', {
	driver: 'postgres',
	connectionString: 'postgresql://user:pass@host:5432/graphx',
	// ssl?: boolean | tls.ConnectionOptions
	// poolMax?: number
});
```

Alternatively, select Postgres globally with `GRAPHX_DB_DRIVER=postgres` (and `GRAPHX_PG_URL` for the connection string). You must still `import '@graphx/core/pg'` once, or `getDb` throws.

**Tenant model.** Each namespace maps to a Postgres **schema** on a shared connection pool, created lazily — one server credential serves every tenant. (libSQL uses one file/replica per namespace instead.)

**Prerequisite.** The `vector` extension (pgvector) must exist in the target database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

This is a one-time, idempotent setup per database and needs a role allowed to create the extension (e.g. a superuser). The `pgvector/pgvector:pg16` Docker image ships pgvector ready to enable.

See [docs/POSTGRES_SUPPORT.md](./docs/POSTGRES_SUPPORT.md) for the full dual-backend design and per-dialect details.

### DuckDB (object-store backed)

A third adapter, registered the same way. Its durable state is a chain of immutable snapshots in an object store (S3 or a local directory): each commit writes content-addressed Parquet files and claims the next numbered manifest with a create-if-absent PUT, so the bucket is the database and the local DuckDB file is a materialization of one snapshot.

```ts
import '@graphx/core/duck'; // registers the DuckDB driver (side effect)
import { getDb } from '@graphx/core';

const db = getDb('acme__alpha', { driver: 'duckdb' });
```

`@duckdb/node-api` is an optional peer (~123MB installed) and is only pulled in by this subpath.

Local database files and DuckDB's temp spill are anchored under `./.graphx-data/` rather than the
process working directory — override with `GRAPHX_DATA_DIR`. Spill is capped by
`GRAPHX_DUCK_MAX_TEMP` (default `16GB`), so a query that outgrows memory fails as a query instead
of filling the disk.

**One writer process per namespace, readers unbounded.** Writes inside a process serialize on a client-held mutex; across processes the manifest CAS picks a winner and the loser rebases. Two processes rewriting the _same table_ of one namespace cannot merge — that raises `SnapshotConflictError` (HTTP 409) rather than silently dropping the loser's rows. `Graph.write(fn)` groups a body into a single snapshot commit.

See [docs/DUCKDB_SUPPORT.md](./docs/DUCKDB_SUPPORT.md) for the snapshot format, the commit protocol, and the parity record.

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT
