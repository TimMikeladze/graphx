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
bun add core zod
```

Optional subpaths pull optional peers only when imported: `core/pg` (Postgres, peer `pg`),
`core/blob` (content-addressed blob store, peer `@aws-sdk/client-s3`).

## Quickstart

```ts
import { getDb, init, defineGraphSchema, Graph } from 'core';
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
await init(client, 768);            // create schema + vector index (dim 768)

const g = new Graph(client, schema);
const ada = await g.addNode({ kind: 'person', props: { name: 'Ada' } });
const paper = await g.addNode({ kind: 'doc', props: { title: 'Notes' }, body: 'analytical engine' });
await g.addEdge({ rel: 'wrote', src: ada.id, dst: paper.id });

const neighbors = await g.neighbors(ada.id);
```

### Retrieval

```ts
import { retrieve, hybridRetrieve } from 'core';

const embed = async (text: string) => /* your embedding model */ [/* ...768 floats */];

// vector ANN + graph expansion
const hits = await retrieve(client, embed, { query: 'computing', k: 10, maxDepth: 2 });

// hybrid: ANN + FTS5 fused by RRF, optional MMR diversification
const hybrid = await hybridRetrieve(client, embed, { query: 'computing', k: 10, mmr: { k: 5 } });
```

### Time travel

```ts
import { history, diff, changeFeed, retrieve } from 'core';

const versions = await history(client, id);   // full immutable version trail for an id
const delta = await diff(client, t1, t2);     // what changed in (t1, t2]
const page = await changeFeed(client);        // tailable CDC log (keyset cursor)

// as-of reads run through the retrieval/traversal ops (and match().asOf(t)), not getNode:
const past = await retrieve(client, embed, { query: 'computing', asOf: 1_700_000_000_000 });
```

Other ops: `match()` / `PatternBuilder` (multi-hop patterns), `journey()` (time-respecting
traversal), `bulkLoad()` (batch ingest), graph algorithms (`shortestPath`, `pagerank`, `community`,
`centrality`, `topNodes`), schema evolution (`defineUpcasters`), constraints
(`declareUniqueNodeProp`, `declareSingleValuedRel`).

## Serving over HTTP

```ts
import { createApp, initControl } from 'core';

const app = createApp({
  control,                       // control-plane DB (tenants/projects/memberships)
  schema,
  authenticate: (c) => verifyToken(c), // -> { userId, tenantId }; throw to 401
  embed,                         // enables /retrieve and /hybrid
});

export default { fetch: app.fetch }; // Bun.serve / Cloudflare / Node
```

Routes mount under `/t/:tenant/p/:project/...`: nodes/edges CRUD (`POST`/`GET`/`PATCH`/`DELETE`),
`neighbors`(+`neighborsPage`), `nodes` list, `graph` slice, `history`, `retrieve`, `hybrid`,
`journey`, `match`, `bulk`, `changes` (CDC), `diff`, and `algorithms/*`. Errors map to `{ error,
issues? }` JSON (400 validation/constraint, 401 authn, 403 authz, 404 not-found/cross-tenant). Pair
it with [`@graphx/react`](../react) for typed hooks.

> Typed client caveat: under isolated declarations the published `AppType` is env-level only, so
> `hc<AppType>` is runtime-correct but statically `unknown` — consume the source for precise route
> types, or use `@graphx/react`.

## Backends

Default is libSQL. For Postgres, import `core/pg` once (registers the driver) and select it via
`getDb(ns, { driver: 'postgres', connectionString })` or `GRAPHX_DB_DRIVER=postgres`. The namespace
becomes a libSQL DB file or a Postgres schema. A few libSQL-native probes (FTS5 internals, `F32_BLOB`)
have no Postgres analog; the user-facing contracts run on both.

## Design

The authoritative design lives in `initial_spec.md` (§0 "Audit corrections" overrides later sections).
Key decisions: ULID-text identity end-to-end; current reads via `nodes`/`edges` views (never bind
`asOf = FOREVER`); analytics in a `node_analytics` side table; partial vector index on live rows.
