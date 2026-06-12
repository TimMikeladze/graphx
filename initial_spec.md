# Temporal GraphRAG on libSQL — Full Design & Build Spec

**Audience:** an autonomous coding agent. Build in the phase order in §1. Treat §2
as hard constraints — do not violate them even if a "simpler" path tempts you.
Each phase has acceptance criteria; write tests that prove them before moving on.
Everything needed is inline; there are no external references.

---

## 0. Audit corrections (AUTHORITATIVE — overrides any conflicting text below)

A full architectural audit found one systemic defect (the doc was authored against
INTEGER rowids, then half-migrated to ULID text) plus copy-drift bugs. The
resolutions below are **canonical**; where older sections disagree, this section
wins. Implementations and tests target these.

### Decisions (locked)

- **D1 — Identity is ULID text, end to end.** `node_identity.id` / `edge_identity.id`
  and all FKs (`node_versions.id`, `edge_versions.{src,dst}`) are **`TEXT PRIMARY KEY`**
  / `TEXT`. `ver INTEGER PRIMARY KEY` stays the **only** INTEGER — it is the rowid the
  `vector_top_k` and FTS5 (`content_rowid='ver'`) joins use. Keep `n.rowid = v.id`
  (do **not** rewrite to `n.id = v.id`). `NodeOf.id`/`AnyNode.id` are **`string`**;
  all wire inputs that name a node id are `z.string()` (journey `start` too; `from`
  stays `z.number()` = epoch ms).
- **D2 — Serving is Hono, not tRPC.** §14's `router({...})`/`procedure` block is
  void. Use `new Hono()` + `@hono/zod-validator` + `hc<AppType>`; `export type AppType
= typeof app`. No `@trpc/*` deps.
- **D3 — Current reads go through the `nodes`/`edges` views** (which test
  `valid_to = FOREVER` by equality). Reserve the half-open `valid_from <= :t AND :t <
valid_to` form for genuine past `asOf` where `:t < FOREVER`. Never bind `:t = FOREVER`
  into a `:t < valid_to` predicate (it is false for every live row). One convention
  across §7/§8/§9/§10.
- **D4 — Analytics live in a side table** `node_analytics(id TEXT PRIMARY KEY
REFERENCES node_identity(id), pagerank REAL, community INTEGER, degree INTEGER,
computed_at INTEGER)`, UPSERTed by jobs and JOINed by `topNodes`. Version rows stay
  byte-stable; no analytics columns on `node_versions`.
- **D5 — ANN recall via a partial vector index over live rows.** Build
  `nv_emb_idx` with `WHERE valid_to = 8640000000000000` for the current-time path;
  for past `asOf`, over-fetch (k × multiplier) then dedup-to-live-by-id then truncate.
- **D6 — Deps:** use **`ulidx`** (not `ulid`) and **`@duckdb/node-api`** (DuckDB Neo,
  not legacy `duckdb`). Bottom-of-file directives win.

### Blocker fixes (baked into the phases)

- **B1/B2** Apply D1 everywhere; journey seed binds the start node as TEXT (no
  `CAST(? AS INTEGER)` on the id — cast only the `t_arrive` timestamp).
- **B3** Apply D3 (current reads via views).
- **B4** `updateNode` carries **all** columns forward (`body,uri,content_hash,
content_type,props,emb`) via `patch.X ?? cur.X`; never null them.
- **B5** When a write omits `emb`, **carry the existing `emb` BLOB forward** (rebind
  raw `cur.emb`); only call `vector(?)` when an embedding is actually supplied.
  `addNode` without an embedding inserts SQL `NULL` for `emb` (never `vector('[]')`).
- **B6** Apply D2 (Hono).
- **B7** No global `getDb()` singleton. `getDb(namespace)` is keyed-and-cached per
  project namespace; `graphForProject(tenant, project)` resolves
  `db_namespace` from the control plane → `getDb(namespace)` → lazy `init()` once
  per namespace under a **per-namespace mutex** (also fixes M9). A separate
  `controlDb()` client serves the control plane.
- **B8** CSR builds a `idToIdx: Map<string,number>` + `idxToId: string[]` dictionary
  from a deterministic ordered scan; translate ULID↔dense-int on load and on every
  result.
- **B9** `edge_versions.weight` gets `CHECK (weight >= 0)`; `shortestPath` sql-mode is
  documented "correct for non-negative weights only."
- **B10** Apply D4 (`node_analytics` side table).

### Major fixes worth baking now

- **M3** `fts_top_k` is not real — lexical seeds come from
  `SELECT ver AS rowid, row_number() OVER (ORDER BY rank) AS r FROM nodes_fts
WHERE nodes_fts MATCH :q ORDER BY rank LIMIT :k` (bm25 `rank` ascending = better);
  sanitize user MATCH text.
- **M4** Add `model_id TEXT` to `node_versions`; `retrieve` filters seeds to the
  active model.
- **M2** FTS5 external-content index needs an `AFTER INSERT` trigger on
  `node_versions` (no FTS mutation on close); rebuild/`'delete'` companion ops on
  archival.
- **M5** RRF fuses on logical ULID `id` (map each list's `ver`→`id`, best rank per id),
  not on `ver`.
- **M6** Use a monotonic write clock: `valid_from = max(Date.now(), lastValidTo+1)` to
  avoid same-ms zero-width `[T,T)` versions.
- **M7** Client-side timeout is fail-safe abandonment, not cancellation (no
  `interrupt()` over HTTP); enforce real limits with `busy_timeout` + `LIMIT
:maxRows` + fan-out guard server-side.
- **M16** `vector_top_k`, `F32_BLOB`, `libsql_vector_idx`, and quantized type
  spellings only work on **real libSQL** — test via `@libsql/client` `file:` DBs, not
  stock sqlite.

Everything else (history immutability, the `ver`/ULID split, isolation-by-
construction, quantize-in-place) stands as written.

---

## 1. Build order (phases)

| Phase    | Deliverable                                                                                        | Done when                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **P0**   | Scaffold (`bun init`), deps (`bun install`), libSQL connection                                     | `SELECT 1` over libSQL passes; WAL set once, `foreign_keys` + `busy_timeout` on every connection; no `bun:*` imports           |
| **P0.5** | Control plane DB + auth/authz middleware + project routing (§3.2)                                  | tenant/project isolation enforced; users never get a DB token; a cross-tenant request is rejected                              |
| **P1**   | Schema init (inline, §4.1)                                                                         | All tables/views/indexes created via `init()`; re-run is a no-op; `EXPLAIN QUERY PLAN` shows adjacency + temporal indexes used |
| **P2**   | Zod schema layer (§5)                                                                              | `defineGraphSchema` infers kinds/rels; bad props throw `ZodError`                                                              |
| **P3**   | Data layer: client, `addNode`/`addEdge` (close-and-insert), `getNode`, `neighbors` (§6)            | Round-trip a node/edge; mutation creates a new version and closes the old                                                      |
| **P4**   | Vectors + `retrieve` (§7)                                                                          | ANN seed + cycle-safe walk returns a deduped subgraph; quantization knob works                                                 |
| **P5**   | `PatternBuilder` with `.asOf` (§8)                                                                 | Fixed + variable-length patterns compile to SQL; `.toSQL()` inspectable; typed rows                                            |
| **P6**   | Temporal ops: `updateNode`/`deleteEdge`, `asOf`, `history`, `diff` (§9)                            | Time-travel query returns past shape; history immutable                                                                        |
| **P7**   | `journey()` (§10)                                                                                  | Time-respecting cascade returns earliest arrival times                                                                         |
| **P8**   | Graph algos: `shortestPath`, CSR mirror, analytics (§11)                                           | Weighted path correct; PageRank persists to indexed column                                                                     |
| **P9**   | Blob layer (§12)                                                                                   | Content-addressed put/presign; dedup on identical bytes                                                                        |
| **P10**  | Tiering / cold archive (§13)                                                                       | Watermark job exports→verifies→deletes; DuckDB federates hot+cold                                                              |
| **P11**  | Serving: Hono API, embedded replicas, db-per-tenant (§14)                                          | Typed client over HTTP; tenant routing                                                                                         |
| **P12**  | Schema evolution: upcasting (§15)                                                                  | Old-version rows read through upcaster; history never rewritten                                                                |
| **P13**  | Hybrid retrieval (FTS5 + RRF) + rerank/MMR (§19.3–19.4); bulk loader (§19.8)                       | hybrid beats vector-only on a labeled set; bulk import >10× faster than per-row                                                |
| **P14**  | Write-correctness guard (§19.1), constraints (§19.5), pagination (§19.7), query governance (§19.2) | concurrent updates never overlap intervals; supernode query stays bounded; cursors stable                                      |
| **P15**  | Observability (§19.6), change feed (§19.10), backup/restore/DR (§19.11)                            | metrics emitted; `/ready` gates on sync; restore-to-T runbook verified                                                         |

Phases P0–P7 are the core product. P8–P12 are layered capabilities; ship P0–P7
first.

---

## 2. Non-negotiable decisions (do not violate)

1. **Storage split.** libSQL owns topology, current state, and vectors (native
   ANN). S3 owns content-addressed blobs. Parquet + DuckDB own cold history and
   analytics. **No LanceDB. No Iceberg. No catalog. No separate vector DB.**
2. **No Cypher / no query DSL.** Pattern matching is a programmatic builder that
   compiles to SQL.
3. **Vectors scale by quantization in place**, never by moving to another store:
   `F32_BLOB → F16_BLOB → F8_BLOB → F1BIT_BLOB`, plus `compress_neighbors=float8`
   and lower `max_neighbors` on the index.
4. **Temporal immutability.** Mutations are close-and-insert. **Never `UPDATE` or
   `DELETE` a closed historical version to migrate or correct data.** History is
   append-only; corrections are new versions; schema changes are read-time
   upcasts.
5. **FK + WAL pragmas on every connection** (`foreign_keys=ON`, `journal_mode=WAL`,
   `busy_timeout`).
6. **The SDK is a library in the app tier.** Users never connect to libSQL
   directly; they hit the app's API.
7. **One Zod schema** is the single source of validation, static types, and the
   wire contract.
8. **Bun for tooling, not for code.** Install and build with Bun, but use **no
   Bun-native packages or APIs** (`bun:sqlite`, `Bun.serve`, `Bun.file`,
   `bun:ffi`). Application code uses `node:` built-ins, `@libsql/client`, and
   Hono's portable APIs so it runs unchanged on Node/edge. The only runtime-
   specific glue allowed is the Hono serving adapter at the entrypoint.
9. **Tenant/project isolation is by construction (§3.2).** Data lives in a
   **separate libSQL DB per project**; the control plane (tenants/users/projects)
   is a separate shared DB. **End users never receive a `sqld` token** — only the
   app holds DB credentials, and it opens only the project a principal is
   authorized for, after an authz check. No shared graph table, no cross-tenant
   `JOIN`, ever.

---

## 3. Tech stack

- Runtime: portable TypeScript/ESM — runs on Node, Bun, and edge (via Hono).
- Tooling: **Bun** for package management (`bun install`) and building (`bun build`).
- DB: libSQL via `@libsql/client` — local file, or embedded replica synced from a
  **self-hosted `sqld` primary** (§3.1). No managed service required.
- DB access: `@libsql/client` directly with raw `sql\`\`` — **no ORM**. The
  query-builder value is forfeited anyway: vectors, recursive CTEs, generated
  columns, and close-and-insert all require raw SQL.
- Migrations: none — schema is created inline at startup via `init()` (§4.1),
  idempotent through `IF NOT EXISTS`. No runner, no `migrations/` dir, no drizzle-kit.
- Validation/types: `zod`.
- Object storage: `@aws-sdk/client-s3` (S3/R2-compatible).
- Cold analytics: `@duckdb/node-api` (DuckDB Neo client; reads SQLite + Parquet on S3 via `httpfs`). Node-only (no edge).
- API: `hono` + `@hono/zod-validator` (reuses the Zod schemas as the contract);
  `hono/client` for the typed client, `@hono/zod-openapi` for external/polyglot callers.
- Embeddings: pluggable `embed(text: string) => Promise<number[]>` (caller-provided).

Pin to current stable majors; the APIs used below are stable across them.

## 3.1 Connection & replication (self-hosted first)

`@libsql/client` is the only DB dependency. One `createClient` covers three modes;
env decides which. **No managed service required** — the primary is the
open-source `sqld` (libSQL server) you run yourself. Turso Cloud is an _optional_
managed host for that primary; nothing in the code depends on it.

```ts
import { createClient, type Client } from '@libsql/client';

let client: Client | undefined;
export function getDb(): Client {
	if (client) return client;
	const syncUrl = process.env.SQLD_URL; // your sqld primary, or unset = local
	client = createClient({
		url: 'file:graph.db',
		authToken: process.env.SQLD_TOKEN,
		...(syncUrl ? { syncUrl, syncInterval: 60 } : {}), // replica mode when SQLD_URL set
	});
	return client;
}
export async function syncIfReplica() {
	if (process.env.SQLD_URL) await getDb().sync();
}
```

**Modes:**

- **local / dev** — `SQLD_URL` unset → pure `file:` DB, no network.
- **embedded replica** — `SQLD_URL` set → reads hit the local file (sub-ms);
  writes go to the primary and replicate back (read-your-writes). One replica per
  app instance scales reads.
- **edge (no FS)** — set `url` to the primary directly (HTTP client), no local file.

Writes go to the primary by default (not local-first); the replica updates on
success (read-your-writes). The HTTP transport has no connection pool to exhaust —
each query is an independent request.

**Run your own primary (sqld):**

```bash
docker run -p 8080:8080 -e SQLD_NODE=primary \
  -v $(pwd)/data:/var/lib/sqld \
  ghcr.io/tursodatabase/libsql-server:latest
# SQLD_URL = https://db.internal:8080 (TLS in prod); configure auth → SQLD_TOKEN
```

`sqld` can also run read-replica servers (`SQLD_NODE=replica` + primary URL) and
host many databases (namespaces) for database-per-tenant.

**Durability-only option:** if you need backup/DR rather than live read
distribution, skip the server — run a plain local `file:` DB and stream the WAL to
**your** S3 with Litestream or libSQL `bottomless` (reuses the S3 you already have).

**Startup order (deploy gotcha):** embedded replicas don't see a remote schema
change until their next sync, so a new deploy can hit "no such column." Sync before
serving:

```ts
const db = getDb();
await syncIfReplica(); // pull latest schema first
await init(db); // §4.1 IF NOT EXISTS init (idempotent)
// ...then start Hono
```

During rollouts, drop `syncInterval` to ~5s or force `sync()` on boot.

**Per-project:** `graphForProject(tenant, project)` (§3.2, §14) is this factory
parameterized by project — each project DB gets its own `file:` replica + its own
`sqld` namespace as `syncUrl`, cached, with `init()` run lazily on first open.

## 3.2 Multi-tenancy & Auth — FOUNDATIONAL (read before §4)

**Model: `tenant → project → graph`.** A _tenant_ is a customer org — the
ownership and auth boundary, control-plane only. A _project_ is one self-contained
graph and is **the unit that maps to a libSQL database** (a `sqld` namespace, e.g.
`acme__alpha`): its own nodes/edges/vectors, schema, temporal history, and writer.
A _graph_ is a project DB's contents. **Everything per-project in this doc —
temporal history, CSR mirror, Parquet tiering, `init()` — is scoped to one project
DB.**

### Two planes

**Control plane** — one shared libSQL DB (`control.db`, same engine), the registry.
Small, low-write.

```sql
CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users   (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (user_id, tenant_id));
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL, db_namespace TEXT NOT NULL UNIQUE);    -- → sqld namespace
CREATE TABLE IF NOT EXISTS api_keys (
  hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scopes TEXT NOT NULL, created_at INTEGER);
```

**Data plane** — one libSQL DB per project. `sqld` namespaces are cheap and built
for thousands of DBs; `getDb(namespace)` (§3.1) opens the right one, cached.
Collapse to a `project_id` scope column in a shared tenant DB **only** for projects
that are many, tiny, and frequently cross-queried within the tenant; otherwise
default to DB-per-project.

### Auth — three layers; the DB credential never leaves the server

1. **Authn (user → your API).** JWT/session/OAuth (own or Clerk/Auth0/WorkOS);
   agents use API keys (hashed in `api_keys`). Token carries `userId` + `tenantId`.
   Hono middleware verifies → principal on context.
2. **Authz (principal → project).** Control-plane check: `memberships.role` for
   `(userId, tenantId)` is sufficient for the op (`viewer`=read,
   `editor`/`owner`=write) **and** `projects.tenant_id == tenantId`. Reject otherwise.
3. **DB access (API → sqld).** **End users never receive a `sqld` token.** The app
   holds sqld credentials server-side; `sqld` issues namespace-scoped tokens, so a
   leaked one grants only one project DB. Isolation is enforced by opening _only_
   the authorized project's namespace after authz.

**Guarantee:** cross-tenant access is impossible by construction — projects are
separate DB files, the only credential holder is your app, and there is no shared
table to over-read nor a cross-tenant `JOIN` to forget a `WHERE` on.

### Request flow (extends the §14 Hono middleware)

```
authn   → verify JWT/API key → { userId, tenantId } on ctx
route    → /t/:tenant/p/:project/...   (tenant may come from subdomain)
authz    → control-plane: role ≥ required for op; project ∈ tenant
resolve  → project → db_namespace → graphForProject(tenant, project) (cached) on ctx; init() lazily
handler  → runs against that ONE project DB
```

### S3 namespacing

Blobs `s3://blobs/{tenant}/{hash}`, archive `s3://archive/{tenant}/{project}/...`.
Per-tenant prefixes intentionally forgo cross-tenant content-address dedup — global
addressing would be a "does this hash exist" probe side channel.

---

## 4. Data model & schema (P1)

768-dim embeddings assumed; parameterize the dimension. `FOREVER =
8640000000000000` (max JS Date ms) is the open-interval sentinel.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- stable identity = ULID (text): branch-safe, time-sortable, no cross-branch
-- collisions. 'ver' stays the INTEGER rowid that the vector_top_k join uses.
CREATE TABLE node_identity (id TEXT PRIMARY KEY);   -- ULID
CREATE TABLE edge_identity (id TEXT PRIMARY KEY);   -- ULID

-- node versions ----------------------------------------------
CREATE TABLE node_versions (
  ver         INTEGER PRIMARY KEY,
  id          TEXT NOT NULL REFERENCES node_identity(id),   -- ULID logical identity
  kind        TEXT NOT NULL,
  body        TEXT,
  uri         TEXT,                 -- s3:// blob pointer
  content_hash TEXT,                -- = S3 key for the blob, if any
  content_type TEXT,
  props       TEXT NOT NULL DEFAULT '{}',
  emb         F32_BLOB(768),        -- quantize to F16/F8/F1BIT to scale (see note)
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER NOT NULL DEFAULT 8640000000000000
  -- + generated columns added per schema (§5 bonus), e.g.:
  -- , entity_type TEXT GENERATED ALWAYS AS (props ->> 'entity_type')
);
CREATE INDEX nv_asof    ON node_versions(id, valid_from, valid_to);
CREATE INDEX nv_kind    ON node_versions(kind);
CREATE INDEX nv_emb_idx ON node_versions( libsql_vector_idx(emb, 'metric=cosine') );
-- to shrink the ANN index at scale, recreate with:
--   libsql_vector_idx(emb, 'metric=cosine', 'compress_neighbors=float8', 'max_neighbors=20')

-- edge versions ----------------------------------------------
CREATE TABLE edge_versions (
  ver        INTEGER PRIMARY KEY,
  id         TEXT NOT NULL REFERENCES edge_identity(id),    -- ULID
  src        TEXT NOT NULL REFERENCES node_identity(id),    -- ULID
  dst        TEXT NOT NULL REFERENCES node_identity(id),    -- ULID
  rel        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0),  -- non-neg: shortestPath sql-mode is Dijkstra
  props      TEXT NOT NULL DEFAULT '{}',
  valid_from INTEGER NOT NULL,
  valid_to   INTEGER NOT NULL DEFAULT 8640000000000000
);
CREATE INDEX ev_src_asof ON edge_versions(src, valid_from, valid_to);  -- forward
CREATE INDEX ev_dst_asof ON edge_versions(dst, valid_from, valid_to);  -- reverse

-- NOW VIEWS: all non-temporal code targets these unchanged ----
CREATE VIEW nodes AS
  SELECT id, kind, body, uri, content_hash, content_type, props, emb
  FROM node_versions WHERE valid_to = 8640000000000000;
CREATE VIEW edges AS
  SELECT id, src, dst, rel, weight, props
  FROM edge_versions WHERE valid_to = 8640000000000000;

-- archival watermark (Part P10) -------------------------------
CREATE TABLE archival_state (
  table_name TEXT PRIMARY KEY, watermark INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

### 4.1 Schema init — inline at startup (no runner)

The schema is nearly static, so there is no migration runner and no `migrations/`
dir. Inline the §4 DDL as a `SCHEMA` constant with **`IF NOT EXISTS` on every
`CREATE`**, and run it once on startup. `executeMultiple` runs the whole
multi-statement script (no `;`-splitting); `IF NOT EXISTS` makes re-runs no-ops.

```ts
import { createClient } from '@libsql/client';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_identity (id TEXT PRIMARY KEY);   -- ULID (D1)
CREATE TABLE IF NOT EXISTS edge_identity (id TEXT PRIMARY KEY);   -- ULID (D1)
CREATE TABLE IF NOT EXISTS node_versions ( /* …§4… */ );
CREATE INDEX IF NOT EXISTS nv_asof    ON node_versions(id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS nv_emb_idx ON node_versions( libsql_vector_idx(emb, 'metric=cosine') );
CREATE TABLE IF NOT EXISTS edge_versions ( /* …§4… */ );
CREATE INDEX IF NOT EXISTS ev_src_asof ON edge_versions(src, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS ev_dst_asof ON edge_versions(dst, valid_from, valid_to);
CREATE VIEW  IF NOT EXISTS nodes AS SELECT /* …§4… */ ;
CREATE VIEW  IF NOT EXISTS edges AS SELECT /* …§4… */ ;
CREATE TABLE IF NOT EXISTS archival_state ( /* …§4… */ );
`;

export async function init(url: string) {
	const raw = createClient({ url });
	await raw.execute('PRAGMA journal_mode = WAL'); // persists in the file — set once
	await applyConnPragmas(raw); // per-connection — see below
	await raw.executeMultiple(SCHEMA); // idempotent via IF NOT EXISTS
	return raw;
}

// foreign_keys & busy_timeout are PER-CONNECTION (they do NOT persist) — run on
// EVERY client/connection, not only at init.
export async function applyConnPragmas(raw) {
	await raw.execute('PRAGMA foreign_keys = ON');
	await raw.execute('PRAGMA busy_timeout = 5000');
}
```

Call `init()` once at startup before serving. With **database-per-tenant**, call
it lazily the first time a tenant's DB is opened (cache that it's done) so a new
tenant file gets the schema on first touch.

**Additive ALTERs** (e.g. a new generated column): `IF NOT EXISTS` covers creation
but not change, and SQLite has no `ADD COLUMN IF NOT EXISTS`, so guard with a
column check:

```ts
export async function ensureColumn(raw, table: string, col: string, ddl: string) {
	const info = await raw.execute(`PRAGMA table_info(${table})`);
	if (!info.rows.some((r: any) => r.name === col)) await raw.execute(ddl);
}
// ensureColumn(raw, "node_versions", "dev_status",
//   "ALTER TABLE node_versions ADD COLUMN dev_status TEXT GENERATED ALWAYS AS (props ->> 'status')");
```

Most evolution is JSON props with zero DDL (§15), so this stays short.

**Acceptance:** `EXPLAIN QUERY PLAN` on a `src = ?` edge lookup shows
`USING INDEX ev_src_asof`; reverse uses `ev_dst_asof`. Running `init()` twice is a
no-op; `foreign_keys` is ON on every connection.

---

## 5. Zod schema layer (P2)

One schema yields kinds, rels, prop types, validation, and (bonus) the generated
columns.

```ts
import { z } from 'zod';
type ZObj = z.ZodType<Record<string, unknown>>;
interface EdgeDef<K extends string> {
	props?: ZObj;
	from?: K | readonly K[];
	to?: K | readonly K[];
}

export function defineGraphSchema<
	N extends Record<string, ZObj>,
	E extends Record<string, EdgeDef<Extract<keyof N, string>>>,
>(s: { nodes: N; edges: E }) {
	return s;
}

// inference
type Nodes<S> = S extends { nodes: infer N } ? N : never;
type Edges<S> = S extends { edges: infer E } ? E : never;
export type Kind<S> = Extract<keyof Nodes<S>, string>;
export type Rel<S> = Extract<keyof Edges<S>, string>;
export type PropsOf<S, K extends Kind<S>> = z.infer<Nodes<S>[K]>;
export type NodeOf<S, K extends Kind<S>> = { id: number; kind: K; props: PropsOf<S, K> };
export type AnyNode<S> = { [K in Kind<S>]: NodeOf<S, K> }[Kind<S>]; // discriminated union
```

Validation rule: `addNode` runs `schema.nodes[kind].parse(props)` and stores the
**parsed output** (defaults applied). `addEdge` validates props per rel and checks
endpoint kinds against `from`/`to` at runtime (cache id→kind).

**Generated columns (bonus):** an `INDEXED` map (`{ device: ["type"] }`) drives
`ALTER TABLE node_versions ADD COLUMN <kind>_<f> TEXT GENERATED ALWAYS AS
(props ->> '<f>')` + an index. One schema, validation + types + physical indexes.

**Acceptance:** wrong prop type throws `ZodError`; result types narrow by `kind`.

---

## 6. Data layer (P3)

Client construction (local-first; distribution is additive):

```ts
import { createClient } from '@libsql/client';
const raw = createClient({ url: 'file:graph.db' /*, syncUrl, authToken, syncInterval */ });
// run the pragmas (§2.5) on every fresh connection
```

**`addNode`** — generate a ULID, insert identity + first version. No
`lastInsertRowid` round-trip — you know the id before writing, and it's collision-
free across branches:

```ts
import { ulid } from 'ulidx'; // D6: ulidx (maintained fork), pure-JS, portable (no bun:*)

async function addNode(raw, n: { kind; props; emb?; uri?; content_hash?; content_type? }) {
	const id = ulid(); // 26-char, time-sortable, branch-safe
	await raw.batch(
		[
			{ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] },
			{
				sql: `INSERT INTO node_versions (id, kind, body, uri, content_hash, content_type, props, emb, valid_from)
            VALUES (?,?,?,?,?,?,?, vector(?), ?)`,
				args: [
					id,
					n.kind,
					n.body ?? null,
					n.uri ?? null,
					n.content_hash ?? null,
					n.content_type ?? null,
					JSON.stringify(n.props),
					JSON.stringify(n.emb ?? []),
					Date.now(),
				],
			},
		],
		'write',
	);
	return { id, kind: n.kind, props: n.props };
}
// addEdge mirrors this: id = ulid(); insert edge_identity + edge_versions (src/dst are ULIDs).
```

**`updateNode` / `deleteEdge`** — close-and-insert (SCD-2), atomic:

```sql
BEGIN IMMEDIATE;
  UPDATE node_versions SET valid_to = :now WHERE id = :id AND valid_to = 8640000000000000;
  -- updateNode: also INSERT the successor version with :now as valid_from
  -- deleteEdge: just the UPDATE, no successor
COMMIT;
```

**`neighbors(id, {direction, rels})`** — join `edges`/`edge_versions` by direction
with optional `rel IN (...)`; return `AnyNode<S>[]`.

**Acceptance:** `updateNode` produces 2 rows (closed + open) for that id; the now-
view shows only the new one.

---

## 7. Vectors & GraphRAG retrieve (P4)

`retrieve({query, k, maxDepth, direction, rels, asOf})`: embed the query, ANN-seed,
cycle-safe walk. `:t` = `asOf ?? FOREVER` (current).

```sql
WITH seeds AS (
  SELECT n.id FROM vector_top_k('nv_emb_idx', vector(:qEmb), :k) v
  JOIN node_versions n ON n.rowid = v.id
  WHERE n.valid_from <= :t AND :t < n.valid_to
),
adj AS (   -- direction at read time; store edges ONCE
  SELECT src AS a, dst AS b FROM edge_versions WHERE valid_from <= :t AND :t < valid_to
  UNION ALL
  SELECT dst AS a, src AS b FROM edge_versions WHERE valid_from <= :t AND :t < valid_to
),
walk AS (
  SELECT n.id, n.body, n.uri, 0 AS depth, ',' || n.id || ',' AS path
  FROM node_versions n JOIN seeds USING (id)
  WHERE n.valid_from <= :t AND :t < n.valid_to
  UNION ALL
  SELECT n.id, n.body, n.uri, walk.depth+1, walk.path || n.id || ','
  FROM walk JOIN adj ON adj.a = walk.id
  JOIN node_versions n ON n.id = adj.b AND n.valid_from <= :t AND :t < n.valid_to
  WHERE walk.depth < :maxDepth AND walk.path NOT LIKE '%,' || n.id || ',%'
)
SELECT DISTINCT id, body, uri, MIN(depth) AS depth FROM walk GROUP BY id, body, uri ORDER BY depth;
```

For `direction`, filter `adj` to forward/reverse/both. **Quantization:** the `emb`
column type and `compress_neighbors`/`max_neighbors` on `nv_emb_idx` are the only
levers; same query.

**Acceptance:** seeds come from ANN; result deduped; no infinite loop on a cyclic graph.

---

## 8. PatternBuilder (P5)

Fluent, no DSL. Each `.node()` adds `{alias: kind}` to a type accumulator; `.out()
/.in()/.both()` add edge steps; `.asOf(t)` switches sources from now-views to
`*_versions` with a temporal predicate; `.toSQL()` exposes the SQL.

**Compile — fixed length:** a JOIN chain.

```
FROM <nodeSrc> a0 [temporal a0] WHERE <conds a0>
per edge+node:
  out:  JOIN <edgeSrc> eK ON eK.src=prev.id AND eK.rel=? [temporal eK]
        JOIN <nodeSrc> aK ON aK.id=eK.dst <conds aK> [temporal aK]
  in:   swap src/dst;   both: ON (eK.src=prev.id OR eK.dst=prev.id), next via CASE
```

**Compile — variable length** (`A -[rel*min..max]- B`): `anchor` CTE → recursive
`walk` (cycle-safe, depth-bounded) → join target conds, `WHERE depth >= min`.

`nodeSrc/edgeSrc` = `nodes`/`edges` (no asOf) or `node_versions`/`edge_versions`
(asOf, with `valid_from <= ? AND ? < valid_to`). **Param order must match textual
SQL order** — push rel param before its temporal params. Props filters use
`json_extract(alias.props, '$.<k>') = ?`.

Typed result: `.select(...aliases).run()` returns `{ [alias]: NodeOf<kind> }[]` via
the accumulator; project `id|kind|props` per alias and reshape.

**Acceptance:** `.toSQL()` for a 3-node fixed pattern is a valid JOIN chain;
variable-length emits a recursive CTE; rows typed per alias.

---

## 9. Temporal ops (P6)

- Mutations: close-and-insert (§6). **Never rewrite closed versions.**
- `asOf` threads `:t` into every node/edge predicate (retrieve, match, neighbors).
- `history(id, {includeCold})`: all versions for an id (hot; + Parquet if cold, P10).
- `diff(t1, t2)`: rows whose `[valid_from,valid_to)` changed between the two times.

**Acceptance:** after an update, `asOf(beforeUpdate)` returns the old props,
`asOf(now)` the new; original version bytes unchanged.

---

## 10. journey() — time-respecting traversal (P7)

Earliest-arrival cascade. Edge usable iff `valid_to > t_arrive`; arrival =
`max(t_arrive, valid_from)`.

```ts
export async function journey(raw, o: { start; from; rels?; direction?; maxDepth? }) {
	const dir = o.direction ?? 'forward',
		maxDepth = o.maxDepth ?? 6;
	const rels = o.rels?.length ? o.rels : null;
	const [edgeMatch, nextExpr] =
		dir === 'forward'
			? ['e.src = j.node', 'e.dst']
			: dir === 'reverse'
				? ['e.dst = j.node', 'e.src']
				: [
						'(e.src = j.node OR e.dst = j.node)',
						'CASE WHEN e.src = j.node THEN e.dst ELSE e.src END',
					];
	const relClause = rels ? ` AND e.rel IN (${rels.map(() => '?').join(',')})` : '';
	const params = [o.start, o.from, o.start, ...(rels ?? []), maxDepth, o.start];

	const sql = `
  WITH RECURSIVE journey(node, t_arrive, depth, path) AS (
    SELECT CAST(? AS INTEGER), CAST(? AS INTEGER), 0, ',' || CAST(? AS TEXT) || ','
    UNION ALL
    SELECT ${nextExpr}, MAX(j.t_arrive, e.valid_from), j.depth+1, j.path || ${nextExpr} || ','
    FROM journey j JOIN edge_versions e ON ${edgeMatch} AND e.valid_to > j.t_arrive${relClause}
    WHERE j.depth < ? AND j.path NOT LIKE '%,' || ${nextExpr} || ',%'
  ),
  reached AS (SELECT node AS id, MIN(t_arrive) AS arrival_t, MIN(depth) AS hops
              FROM journey WHERE node <> ? GROUP BY node)
  SELECT r.id, r.arrival_t, r.hops, n.kind, n.props ->> 'name' AS name
  FROM reached r JOIN node_versions n
    ON n.id = r.id AND n.valid_from <= r.arrival_t AND r.arrival_t < n.valid_to
  ORDER BY r.arrival_t, r.hops;`;
	return (await raw.execute({ sql, args: params })).rows;
}
```

**Acceptance:** reverse journey over `depends_on` from a node returns dependents
with non-decreasing arrival times; severed (expired) edges are skipped.

---

## 11. Graph algorithms (P8)

- **shortestPath(src, dst, {weighted, mode, rels, heuristic})**:
  - `mode:'sql'` — priority-queue recursive CTE (`ORDER BY cumulative cost`),
    cycle-safe, `LIMIT 1` on target. Correct but no node-settling.
  - `mode:'memory'` — Dijkstra/A\* over the CSR mirror (binary heap).
- **CSR mirror** (`buildCSR()` / `snapshotCSR(t)`): load `SELECT src,dst,weight
FROM edges ORDER BY src` into `{offsets:Int32Array, targets:Int32Array,
weights:Float32Array}`; `neighbors(u)` = slice. Rebuild after `sync()`.
- **analytics**: `pagerank()` (power iteration over CSR), `community()` (label
  propagation), `centrality(kind)`. Persist to indexed columns `pagerank`,
  `community`, `degree`; `topNodes({kind, by, limit})` reads them.

**Acceptance:** weighted path matches a reference Dijkstra; PageRank values persist
and are queryable/orderable.

---

## 12. Blob layer (P9)

Content-addressed S3. **Order: blob.put BEFORE node insert** (orphan-safe).

```ts
async function put(bytes: Uint8Array, contentType: string) {
	const hash = sha256hex(bytes);
	const key = `blobs/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
	try {
		await s3.putObject({
			Bucket: BUCKET,
			Key: key,
			Body: bytes,
			ContentType: contentType,
			IfNoneMatch: '*',
			Metadata: { sha256: hash, bytes: String(bytes.length) },
		});
	} catch (e) {
		if (!isPreconditionFailed(e)) throw e;
	} // 412 = dedup hit
	return { uri: `s3://${BUCKET}/${key}`, hash, bytes: bytes.length };
}
// presign(uri, ttl=900) → GET url;  get(uri) → bytes (rare, server-side)
```

Inline policy: `bytes < 32KB && hot → store in body; else → S3`. `content_hash`
always set. GC default **off** (lifecycle-tier instead); if enabled, mark-sweep
must scan live **and** Parquet archive before deleting.

**Acceptance:** identical bytes uploaded twice → one S3 object, same uri.

---

## 13. Tiering / cold archive (P10)

External cron (not a SQLite trigger). Per table, advance the watermark in **time
slices** (never row-count LIMIT), export→verify→delete atomically. The past is
immutable, so windows behind the cutoff never receive new rows.

```
cutoff = now - retentionWindow            // e.g. 90d
while wm < cutoff:
  sliceEnd = min(cutoff, wm + SLICE)       // e.g. 1 month
  rows = SELECT * FROM {table} WHERE valid_to != FOREVER AND valid_to >= wm AND valid_to < sliceEnd
  if rows: write Parquet at deterministic key  s3://archive/{table}/vt_year=Y/vt_month=M/part-{wm}-{sliceEnd}.parquet
           assert parquet_count == len(rows)            // verify
  BEGIN IMMEDIATE;
    DELETE same predicate;
    UPDATE archival_state SET watermark = sliceEnd;
  COMMIT;
  wm = sliceEnd
```

`dropVectorsOnArchive=true` → omit `emb` from Parquet. Federated read routes by
watermark (hot: `valid_to >= wm OR FOREVER`; cold: `read_parquet(...) WHERE
valid_to < wm`) via DuckDB — no overlap, no dedup. Compaction job merges small
files behind the cutoff.

**Acceptance:** crash after export/before delete → re-run is idempotent (same key
overwritten); DuckDB query spans hot+cold with no double-count.

---

## 14. Serving (P11)

SDK is a library; expose **Hono** routes (D2) that reuse the Zod schemas via
`@hono/zod-validator`. The typed client is `hc<AppType>` (no codegen). **Not tRPC.**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';

// mounted under the tenant/project-scoped path; c.get("graph") is the per-project SDK
const app = new Hono<{ Variables: { graph: Graph } }>()
	.post('/t/:tenant/p/:project/nodes', zValidator('json', nodeInputSchema), (c) =>
		c.json(c.get('graph').addNode(c.req.valid('json'))),
	)
	.get(
		'/t/:tenant/p/:project/retrieve',
		zValidator(
			'query',
			z.object({
				query: z.string(),
				k: z.coerce.number().optional(),
				asOf: z.coerce.number().optional(),
			}),
		),
		(c) => c.json(c.get('graph').retrieve(c.req.valid('query'))),
	)
	.post(
		'/t/:tenant/p/:project/journey',
		zValidator(
			'json',
			z.object({
				start: z.string(),
				from: z.number(), // start = ULID; from = epoch ms
				rels: z.array(z.string()).optional(),
				direction: z.enum(['forward', 'reverse', 'both']).optional(),
			}),
		),
		(c) => c.json(journey(c.get('graph').raw, c.req.valid('json'))),
	);
export type AppType = typeof app; // hc<AppType> consumes this
```

- **Reads scale:** embedded replica per app instance (`syncUrl`), `sync()` on a
  timer or before read-your-writes-critical queries.
- **Writes / tenancy:** prefer **database-per-tenant** (one libSQL file per
  tenant) — physical isolation, free per-tenant backup/delete, and each tenant has
  its own writer (removes the single-writer bottleneck). Route to the tenant's DB
  per request.
- Edge runtimes (no FS): HTTP client to the primary, no embedded replica.

**Acceptance:** typed client call over HTTP returns typed rows; tenant A can't read
tenant B.

### 14.1 API surface options (one spine, many consumers)

All surfaces mount on the **same Hono app**, share the tenant-routing middleware,
and call the **same SDK**. The Zod schema is the single contract feeding all of
them. Pick per consumer; add surfaces as consumers appear.

| Consumer                   | Surface                               | Notes                                   |
| -------------------------- | ------------------------------------- | --------------------------------------- |
| TS frontend / internal     | `hc<AppType>` (hono/client)           | typed, no codegen — **the main case**   |
| Polyglot / external teams  | OpenAPI via `@hono/zod-openapi`       | generated from the same Zod schemas     |
| LLM agents                 | the REST/RPC routes as named tools    | `retrieve` / `journey` / `shortestPath` |
| Field-selective UI clients | **GraphQL on Hono** (optional, §14.2) | bounded reads only                      |

### 14.2 Optional: GraphQL layer

Add **only** when a consumer needs field selection + fixed-depth nested reads over
_current_ state. Mount it as one route (e.g. `graphql-yoga`) on the same app:

```ts
import { createYoga, createSchema } from 'graphql-yoga';
const yoga = createYoga({
	schema: createSchema({
		typeDefs: /* GraphQL */ `
			type Node {
				id: ID!
				kind: String!
				props: JSON
			}
			type Query {
				node(id: ID!): Node
				neighbors(id: ID!, rel: String, direction: Direction): [Node!]! # fixed depth only
				retrieve(query: String!, k: Int, maxDepth: Int, asOf: Float): [Node!]! # OPAQUE → SDK
			}
		`,
		resolvers: {
			Query: {
				node: (_p, a, c) => c.graph.getNode(a.id),
				neighbors: (_p, a, c) =>
					c.graph.neighbors(a.id, { direction: a.direction, rels: a.rel ? [a.rel] : undefined }),
				retrieve: (_p, a, c) => c.graph.retrieve(a), // recursive walk hidden behind ONE field
			},
		},
	}),
});
app.use('/graphql', (c) => yoga.handle(c.req.raw, { graph: c.get('graph') })); // same tenant ctx
```

**Rules for the GraphQL layer (important):**

- **Transport, not traversal.** GraphQL is tree-shaped; it cannot express
  variable-depth walks, cycles, journeys, or pathfinding. Graph operations
  (`retrieve`, `journey`, `shortestPath`, variable-length patterns) are exposed as
  **single opaque query fields** that pass through to the SDK — never modeled as
  nested schema fields. This does **not** conflict with the no-Cypher rule
  (§2.2/§17): that forbids a graph-traversal DSL; this is an API transport whose
  graph ops stay in the SDK.
- **N+1.** Nested `neighbors` resolvers will N+1, and graph fan-out makes it acute
  — exactly the per-hop cost the adjacency indexes + CSR avoid. Wrap per-node
  fetches in DataLoader batching, or keep nesting shallow.
- **Temporal.** Thread `asOf` as a root argument into the resolver context; don't
  scatter it across resolvers. Without it, GraphQL reads current state only.

**Decision rule:** GraphQL is never the core and never the agent surface. It's an
opt-in convenience for field-selective UI clients, added on the Hono spine when
such a consumer actually exists.

---

## 15. Schema evolution (P12)

JSON props make add/remove free (no DDL). Generated-column changes are additive
DDL on the primary; replicas sync. **Because history is immutable, never rewrite
old versions.** Stamp `_v` on props; upcast at read time:

```ts
function upcastDevice(raw: any) {
	let p = raw;
	if ((p._v ?? 1) === 1) p = { name: p.name, criticality: p.crit, status: 'online', _v: 2 };
	return deviceV2.parse(p); // in-memory always latest; storage keeps what was written
}
```

Multi-tenant version skew handled by the same upcaster chain. Forward-only
re-versioning (write new versions) only when a new generated-column index must be
populated; prefer read-time upcast otherwise.

**Acceptance:** a row written under v1 reads back as v2 in memory; the stored v1
bytes are unchanged; `asOf` over the v1 era still returns v1 shape.

---

## 16. Testing & acceptance (cross-cutting)

- **Index usage:** `EXPLAIN QUERY PLAN` on every traversal/temporal query asserts
  `USING INDEX` (ev_src_asof/ev_dst_asof/nv_asof), never a full scan.
- **Temporal invariants:** updates never reduce a row's count of historical
  versions; `asOf(past)` is stable after later writes; no `UPDATE`/`DELETE` on rows
  with `valid_to != FOREVER` anywhere except the archival job.
- **Cycle safety:** retrieve/journey/variable-pattern terminate on a graph with a
  cycle.
- **Idempotency:** archival re-run after simulated crash double-counts nothing.
- **Param order:** `PatternBuilder.toSQL()` params line up with placeholders
  (snapshot test).
- **Dedup:** blob put of identical bytes yields one object.

---

## 17. Non-goals (do not build)

- No Cypher/Gremlin/any query DSL or parser.
- No LanceDB, Iceberg, Delta, or external vector DB.
- No in-place history mutation / eager backfill migrations.
- No multi-variable-segment pattern compilation (single variable segment is
  enough; chain calls or raw SQL otherwise).
- No as-of-past ANN beyond over-fetch-then-temporal-filter.
- No graph engine integration (Neo4j/Kùzu) — revisit only at billions-of-edges
  scale, out of scope here.

---

## 18. Open question to flag, not solve

Benchmark **ANN recall + latency on the real corpus at the chosen vector
precision** early; it decides the quantization level and whether vectors stay
comfortably inline. It is empirical — measure, don't assume.

---

## 19. Production hardening (gap fixes)

Each subsection refines an earlier section (pointer given). Phases P13–P15 cover
the net-new pieces; the rest amend P3/P4/P6.

### 19.1 Write correctness — conditional close + retry (1.1; amends §6/§9)

Do the whole read-merge-write in one transaction; close conditionally and retry on
supersession so concurrent updates can't create overlapping `valid_from` intervals.

```ts
async function updateNode(raw, id, patch) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const tx = await raw.transaction('write'); // BEGIN IMMEDIATE
		try {
			const cur = (
				await tx.execute({
					sql: 'SELECT kind, props, emb FROM node_versions WHERE id=? AND valid_to=8640000000000000',
					args: [id],
				})
			).rows[0];
			if (!cur) {
				await tx.rollback();
				throw new Error('no live version');
			}
			const now = Date.now();
			const closed = await tx.execute({
				sql: 'UPDATE node_versions SET valid_to=? WHERE id=? AND valid_to=8640000000000000',
				args: [now, id],
			});
			if (closed.rowsAffected !== 1) {
				await tx.rollback();
				continue;
			} // superseded → retry
			const props = { ...JSON.parse(cur.props as string), ...patch.props };
			await tx.execute({
				sql: 'INSERT INTO node_versions (id, kind, props, emb, valid_from) VALUES (?,?,?,vector(?),?)',
				args: [
					id,
					patch.kind ?? cur.kind,
					JSON.stringify(props),
					JSON.stringify(patch.emb ?? []),
					now,
				],
			});
			await tx.commit();
			return;
		} catch (e) {
			await tx.rollback();
			throw e;
		}
	}
	throw new Error('updateNode: too much contention');
}
```

Same conditional-close pattern for `deleteEdge`.

### 19.2 Query governance (1.3; new — P14)

Every query path enforces a wall-clock **timeout** (cancel via statement
interrupt), a **row cap**, and a traversal **fan-out guard**; heavy/analytical
reads use a **read-replica** connection, not the primary. Enforced per-tenant so
one project can't starve others.

```ts
const LIMITS = { timeoutMs: 5000, maxRows: 10_000, maxFanout: 1000 };
// • wrap execute in Promise.race([q, timeout→interrupt])
// • append LIMIT :maxRows to generated SQL
// • in walks, skip nodes whose live degree > maxFanout (supernode guard)
```

### 19.3 Hybrid retrieval — vector + FTS5 + RRF (1.4; amends §4, §7)

Add an FTS5 index to the §4.1 SCHEMA; run lexical + vector in parallel, fuse by
Reciprocal Rank Fusion, then feed fused seeds into the §7 cycle-safe walk.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts
  USING fts5(body, content='node_versions', content_rowid='ver');
-- keep current: triggers on insert/close, or rebuild over live rows
```

```ts
// seeds = RRF( vector_top_k(qEmb,k), fts_top_k(qText,k) ),  score = Σ 1/(60 + rank_i)
```

### 19.4 Reranking + MMR (3.5; amends §7)

After expansion, optional cross-encoder **rerank** of candidates vs. the query,
then **MMR** (λ·rel − (1−λ)·max-sim-to-chosen) to drop near-duplicate multi-hop
results before returning top-k.

### 19.5 Constraints (3.1; amends §4/§5)

- **Uniqueness:** partial unique index over live rows —
  `CREATE UNIQUE INDEX ... ON node_versions(serial_no) WHERE valid_to=8640000000000000`
  (historical versions don't collide).
- **Edge cardinality** (e.g. one live `attached_to` per sensor): close any existing
  live edge of that `(src, rel)` in the same insert transaction, or a partial unique
  index on `(src, rel)` over live rows for rels marked single-valued in the Zod def.
- **Required relationships:** validated on the write path from the schema.

### 19.6 Observability (2.1; new — P15)

Metrics: **replica sync-lag**, **write-queue depth**, **ANN recall/latency**,
traversal depth/fan-out histograms, per-tenant query counts. Structured slow-query
log (> timeout/2). `/health` (process up) + `/ready` (true only after
sync-before-serve completes — gates the load balancer).

### 19.7 Pagination / cursors (2.5; amends §6/§7)

Keyset pagination on `neighbors`/`match`/`retrieve`: order by a stable key, accept
an opaque `cursor`, return `nextCursor`; always apply the `maxRows` cap (19.2).
Prevents supernode/broad-match OOM.

### 19.8 Bulk ingestion (2.3; new — P13)

A loader path distinct from live writes: large multi-row inserts in big
transactions, **defer the ANN index build** to after load, **skip versioning** (all
rows `valid_from = load_ts`, `valid_to = FOREVER`), `ANALYZE` after. Orders of
magnitude faster than per-row close-and-insert for initial import.

### 19.9 Embedding model versioning / re-embedding (3.2; amends §4/§15)

Embeddings are **derived, not facts** — decouple them from immutable history so a
model change is a re-index, not a history rewrite:

- Tag vectors with `model_id`.
- On model change, recompute current-version embeddings in place via the bulk path
  (the one sanctioned write to derived data; stale historical-version vectors may be
  left or dropped — as-of-past ANN is already best-effort).
- `retrieve` filters candidates to the active `model_id`.

### 19.10 Change feed / CDC (3.3; amends §9)

The temporal log **is** the changelog — expose a tailable feed with no new infra:
`SELECT … FROM node_versions WHERE valid_from > :cursor ORDER BY valid_from`
(∪ edges). Consumers poll with the last `valid_from`; optional webhook dispatch on
top. Covers subscriptions / dashboards / agent triggers.

### 19.11 Backup, restore, DR (2.2; new — P15)

- **Backup:** stream each project DB + `control.db` WAL to S3 (Litestream /
  `bottomless`); blobs and Parquet are already durable in S3.
- **Cross-store restore to time T:** restore each DB to the WAL frame at/just-before
  T; S3 blobs (content-addressed) and Parquet (watermark-routed) written _after_ T
  are harmless if ahead — no coordination needed. Document **RPO** (= WAL ship
  interval) and **RTO**.
- **Failover:** `sqld` is single-primary — on loss, promote a replica or restore
  from S3 WAL; embedded replicas re-sync to the new primary URL. Document the
  procedure and accepted RTO.

use ulidx.
use duckdb neo https://duckdb.org/docs/stable/clients/node_neo/overview.html
