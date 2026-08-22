# core (graphx)

A **temporal GraphRAG SDK** — a bitemporal property graph with native vector + full-text retrieval,
multi-tenant isolation, and a typed HTTP serving layer. Runs on **libSQL** or **Postgres** behind a
single dialect seam.

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
bun add @graphx/core zod
```

Optional subpaths pull optional peers only when imported: `@graphx/core/pg` (Postgres, peer `pg`),
`@graphx/core/blob` (content-addressed blob store, peer `@aws-sdk/client-s3`).

## Quickstart

```ts
import { getDb, init, defineGraphSchema, Graph, hashEmbed } from '@graphx/core';
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

const client = getDb('my-project'); // libSQL: file:my-project.db
await init(client, 768); // create schema + vector index (dim 768)

const embed = hashEmbed(768);
const g = new Graph(client, schema);
const ada = await g.addNode({ type: 'person', data: { name: 'Ada' } });
const paper = await g.addNode({
	type: 'doc',
	data: { title: 'Notes' },
	body: 'analytical engine',
	emb: await embed('analytical engine'), // `Graph` never calls the embedder itself
});
await g.addEdge({ rel: 'wrote', src: ada.id, dst: paper.id });

const neighbors = await g.neighbors(ada.id, { rels: ['wrote'] }); // omit `rels` for every relation
const page = await g.listNodes({ type: 'doc' }); // { nodes, nextCursor }
```

A node written without `emb` has a NULL vector: FTS and `hybridRetrieve` still find it, the ANN
seeds behind `retrieve` never do. The serving layer and `bulkLoad` embed for you; `Graph` does not.

### Retrieval

```ts
import { retrieve, hybridRetrieve, hashEmbed } from '@graphx/core';

// Your embedding model in production; `hashEmbed()` is a deterministic, model-free stand-in for
// dev/tests/demos (its default width is 768, matching `init`'s — no dimension bookkeeping).
const embed = hashEmbed();

// vector ANN + graph expansion
const hits = await retrieve(client, embed, { query: 'computing', k: 10, maxDepth: 2 });

// hybrid: ANN + FTS5 fused by RRF, optional MMR diversification
const hybrid = await hybridRetrieve(client, embed, { query: 'computing', k: 10, mmr: { k: 5 } });
```

### Time travel

```ts
import { history, diff, changeFeed, retrieve } from '@graphx/core';

const versions = await history(client, id); // full immutable version trail for an id
const delta = await diff(client, t1, t2); // what changed in (t1, t2]
const page = await changeFeed(client); // tailable CDC log (keyset cursor)

// as-of reads run through the retrieval/traversal ops (and match().asOf(t)), not getNode:
const past = await retrieve(client, embed, { query: 'computing', asOf: 1_700_000_000_000 });
```

Other ops: `match()` / `PatternBuilder` (multi-hop patterns), `journey()` (time-respecting
traversal), `bulkLoad()` (batch ingest), graph algorithms (`shortestPath`, `pagerank`, `community`,
`centrality`, `topNodes`), schema evolution (`defineUpcasters`), constraints
(`declareUniqueNodeProp`, `declareSingleValuedRel`).

## Serving over HTTP

**Dev / single-tenant** — pass a `schema` (no control/auth) and `createApp` bootstraps an in-memory
control plane, seeds, and serves. One call:

```ts
import { createApp } from '@graphx/core';

const { app, tenant, project, user } = await createApp({
	schema,
	embed: hashEmbed(), // optional; enables /retrieve + /hybrid. Auto-dim sizes the vector column to it.
	cors: true, // optional; browser SPA on another origin, no dev proxy
	logger: true, // optional; log every request
	seed: async (g) => {
		await g.addNode({ type: 'device', data: { name: 'temp-1' } });
	},
});
export default { fetch: app.fetch }; // GET /demo returns { tenant, project, user }
```

Or skip the file entirely: `bunx @graphx/cli new my-app && cd my-app && bun run serve` scaffolds a
project and `graphx serve` (loads `graphx.config.ts`) exposes the graph — the same one `graphx
ingest` writes to.

**Production / multi-tenant** — supply your own `control` + `authenticate`; returns the app
synchronously:

```ts
const app = createApp({
	control, // control-plane DB (tenants/projects/memberships)
	schema,
	authenticate: (c) => verifyToken(c), // -> { userId, tenantId }; throw to 401
	embed,
});
export default { fetch: app.fetch }; // Bun.serve / Cloudflare / Node
```

Routes mount under `/t/:tenant/p/:project/...`: nodes/edges CRUD (`POST`/`GET`/`PATCH`/`DELETE`),
`neighbors`(+`neighborsPage`), `nodes` list, `graph` slice, `schema`, `history`, `retrieve`,
`hybrid`, `journey`, `match`, `bulk`, `changes` (CDC), `diff`, and `algorithms/*`. `GET /schema`
returns the project's declared node types and rels as JSON Schema (derived from your zod schema) —
what a client needs to render typed editors without hard-coding your shapes. Errors map to `{ error,
issues? }` JSON (400 validation/constraint, 401 authn, 403 authz, 404 not-found/cross-tenant). Pair
it with [`@graphx/react`](../react) for typed hooks.

> Typed client caveat: under isolated declarations the published `AppType` is env-level only, so
> `hc<AppType>` is runtime-correct but statically `unknown` — consume the source for precise route
> types, or use `@graphx/react`.

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

Default is libSQL. For Postgres, import `@graphx/core/pg` once (registers the driver) and select it via
`getDb(ns, { driver: 'postgres', connectionString })` or `GRAPHX_DB_DRIVER=postgres`. The namespace
becomes a libSQL DB file or a Postgres schema. A few libSQL-native probes (FTS5 internals, `F32_BLOB`)
have no Postgres analog; the user-facing contracts run on both.

## Design

The authoritative design lives in `initial_spec.md` (§0 "Audit corrections" overrides later sections).
Key decisions: ULID-text identity end-to-end; current reads via `nodes`/`edges` views (never bind
`asOf = FOREVER`); analytics in a `node_analytics` side table; partial vector index on live rows.
