# graphx — Vector / Embedding Architecture Review

> **Status (2026-09-06): implemented.** Everything in §3–§4 below shipped in the embedding rewrite —
> see [`embeddings.md`](./embeddings.md) for the resulting design and API. This file is kept as the
> record of what was wrong and why.

> Audit of `main` @ `5239c1c`, 2026-09-06. Companion to [`GAPS.md`](./GAPS.md) (unbuilt features) and
> [`RISKS.md`](./RISKS.md) (latent risks). This one is narrower: **why the vector layer feels half-baked,
> what is actually broken, and what "seamless" should look like.** Every 🔴 below was reproduced with a
> script against the current source, not inferred from reading.

---

## 0. The one-sentence diagnosis

`Graph` is "embedder-free by design" (`graph.ts`, README). That single decision makes embeddings a
loose `number[]` the _caller_ has to thread through every write path by hand, so nothing in core can
own their lifecycle — dimension, model identity, staleness, chunking, re-embedding — and each layer
above (`serve`, `bulkLoad`, MCP, admin, ingest) either re-invents a piece of it or silently skips it.
`dim` is the visible symptom: it exists only because the column is fixed-width and is created before
any embedder is ever called, so the user has to state the model's width in a config file, keep it in
sync with the embedder, and can never change it.

---

## 1. Confirmed defects (reproduced)

### 🔴 Body edits keep the old vector — vector search returns stale results silently

`graph.ts:1147-1168`. `updateNode({ body })` without `emb` rebinds `cur.emb` forward. Reproduced:
node embedded from `"hello world"`, body patched to `"completely different zebra giraffe"`, query
`"hello world"` still returns it at depth 0. `embed_hash` is written `null` by core and never
compared. The admin content editor **knows** (`content-tab.tsx:203`: "Vector and hybrid search still
match the pre-edit text until this node is re-embedded") and shows a warning instead of fixing it.
Only `ingestDir` handles this correctly, with its own private `embed_hash`/`embedId` logic
(`ingest.ts:366-370, 466-486`).

### 🔴 The production `createApp` ignores the embedder's dimension and bakes 768

`serve.ts:77-140` (`ServeConfig`) has no `dim`; `graphForProject` → `resolveProjectDb` →
`initOnce(client)` → `init(client)` with the 768 default (`authz.ts:94-104`). Only the dev overload
derives `dim` from `embed` (`serve.ts:1650`). So a multi-tenant deployment with a 1536-dim model gets a
768-wide column in every lazily-created tenant namespace, and every embedded insert and every
`/retrieve` fails with the database's own error. The examples work around it by hand
(`pantheon-graph/server.ts:111-113`: `await init(getDb(NAMESPACE), DIM)` before `createApp`).

### 🔴 `graphx mcp` local mode cannot open a database not built at dim 768

`mcp/bin.ts:120-125` always passes `embed: hashEmbed()` (768) to the dev `createApp`, which calls
`init(db, 768)` → `readEmbDim` returns the real width → `init` throws "dimension is immutable". Any
graph built with a real model is unreachable from MCP local mode. Root cause: the MCP entry reads a
JSON schema file instead of `graphx.config.ts`, so it has no access to the configured embedder.

### 🔴 libSQL as-of-past ANN seeds are ranked by rowid, not similarity

`dialect-sql.ts:535-549` (`annSeedsAsOf`, libsql arm) uses `MIN(v.id)` as the rank, and `v.id` is the
base table **rowid**, not the ANN rank. Reproduced: three nodes inserted far → mid → near, query equal
to `near`; live `k=1` returns `near`, as-of `k=1` returns **`far`**, as-of `k=2` returns `[far, mid]`.
So on the default backend, time-travel retrieval returns the _oldest_ of the over-fetched candidates.
Postgres and DuckDB rank by true distance and are correct. `retrieve.ts:120-124` documents the rowid
as a "proxy for ANN rank" — it is not one.

### 🔴 DuckDB accepts a wrong-width vector, then every retrieve in the namespace fails

`emb` is `FLOAT[]` (`dialect-sql.ts:283-286`) so the width is unenforced. Reproduced: one dim-4 row
inserted into a dim-8 namespace is accepted; the next `retrieve` fails with
`list_cosine_distance: list dimensions must be equal, got left length '4' and right length '8'`.
One bad write poisons the tenant. Nothing in `Graph`/`bulkLoad` validates `emb.length` before SQL.

### 🟡 Errors are the database's, not graphx's

libSQL: `SQLITE_ERROR: vector index(insert): dimensions are different: 4 != 8`. Postgres:
`expected 8 dimensions, not 4`. These surface as 500s on the wire and give no hint that `dim` in
`graphx.config.ts` is the thing to change.

### 🟡 The README is wrong about who embeds

README §"Using the SDK": "the serving layer and `bulkLoad` embed on your behalf". Neither does:
`POST /nodes`, `PATCH /nodes/:id`, `POST /bulk` (`serve.ts:876, 937, 1392`) and `bulkLoad`
(`bulk.ts:186`) pass `emb` straight through. Only `ingestDir` embeds.

### 🟡 `graphx.config.ts` with `driver: 'duckdb'` fails

`cli.ts:156`: `loadConfig` registers only the Postgres driver; `buildServeApp` forwards only Postgres
env. A DuckDB config throws `duck adapter is not registered`.

### 🟢 Zero-vector queries return arbitrary results

`hashEmbed('')` → all zeros; cosine is undefined; libSQL returns whatever. Should short-circuit to `[]`.

---

## 2. What is missing (design gaps, not bugs)

| Gap                                                                                                                                                                                                                                                                                                                                                         | Where it bites                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No model identity on vectors.** Spec §19.9 (tag with `model_id`, re-embed via bulk path, filter to active model) was never built. `embedId` in ingest is a private half-version.                                                                                                                                                                          | Swapping models with the same width silently mixes two vector spaces. Different width = "delete the namespace" — incoherent for a store whose pitch is _nothing is erased_. |
| **`dim` is a user-facing concept at all.** It appears in 3 places (`config.dim`, `hashEmbed(768)`, `init(db, 768)`) with 4 behaviours (dev derives it, CLI ingest refuses without it, CLI serve derives it, prod ignores it).                                                                                                                               | Every quickstart has to explain it; every mismatch is a 500.                                                                                                                |
| **Embedding input is hardcoded to `body`.** No per-type "what text represents this node".                                                                                                                                                                                                                                                                   | A `person { name, bio }` node with no `body` is invisible to vector search unless the caller concatenates fields by hand.                                                   |
| **No chunking.** One vector per node body; ingested markdown of any length gets one vector, and real models truncate at ~8k tokens.                                                                                                                                                                                                                         | GraphRAG retrieval granularity is the whole document.                                                                                                                       |
| **`EmbedFn` is one-text-at-a-time.** Every real API is batch; ingest fakes it with concurrency 8.                                                                                                                                                                                                                                                           | Cost and latency on real models; `bulkLoad` can't batch-embed even if it wanted to.                                                                                         |
| **No adapters shipped.** `hashEmbed` (lexical) and `fixtureEmbed` (replay) only.                                                                                                                                                                                                                                                                            | First real-model integration is the user's job on day one.                                                                                                                  |
| **Retrieval result is thin.** `RetrievedNode = { id, body, uri, depth }` — no `type`, `data`, score, or which leg (vector/fts/walk) produced it.                                                                                                                                                                                                            | Admin re-joins against `GET /nodes` to show type; React hooks and MCP agents get ids and fetch again.                                                                       |
| **No re-embed path.** No command, no job, no progress, no resumability.                                                                                                                                                                                                                                                                                     | The only way to change models is to rebuild.                                                                                                                                |
| **No async/lazy embedding.** Every write pays the embedder + index insert on the request path. The trigger/outbox infrastructure that would make this trivial already exists (`triggers.ts`).                                                                                                                                                               | Interactive writes block on a network call.                                                                                                                                 |
| **libSQL index build is superlinear and undocumented as a ceiling.** Measured in `scripts/seed/apply.ts` / `bench/corpus.ts`: 2k=6s, 5k=16s, 10k=36s, 25k=108s at **dim 128**. Every example and the bench cap embedded nodes at 5k. Query latency is fine (1.7–7ms p50 at 10k vectors). No DiskANN params (`max_neighbors`, `compress_neighbors`) exposed. | Users hit a wall at tens of thousands of vectors with no warning and no knob.                                                                                               |
| **No `doctor`/inspection.** Nothing reports model, dim, embedded vs. unembedded counts, stale count, index state per namespace.                                                                                                                                                                                                                             | Operators find out by 500.                                                                                                                                                  |

---

## 3. What "seamless" should look like

Principle: **embeddings are derived data that graphx owns, keyed by model.** The user declares an
embedder once; core does the rest. Everything below follows from that.

### A. `defineEmbedder` — a first-class object, not a bare function

```ts
import { defineEmbedder } from 'graphx';

export const embedder = defineEmbedder({
	id: 'openai:text-embedding-3-small', // model identity, stored with every vector
	dim: 1536, // optional — probed once and cached if omitted
	embed: (texts: string[]) => Promise<number[][]>, // batch-first
	maxChars?: number, // truncation guard
});
```

- `id` + `dim` persist in `graph_meta` (libSQL/PG) and the manifest (DuckDB). `init(db, embedder)`
  replaces `init(db, 768)`. A mismatch is a **graphx** error: "namespace `acme__alpha` was embedded
  with `openai:text-embedding-3-small` (1536); config has `voyage-3` (1024). Run `graphx reembed` or
  use a new namespace."
- `dim` disappears from `graphx.config.ts`, `DevServeConfig`, the scaffold, and the docs.
- Ship adapters under `graphx/embedders`, each an optional peer like `pg`/`duck`: `openai`,
  `voyage`, `ollama`, `transformers` (local, no key), `hash`. OpenAI/Voyage/Ollama are `fetch`
  calls and need no SDK.
- `hashEmbed`/`fixtureEmbed` become `defineEmbedder` instances; the bare `EmbedFn` stays accepted for
  one release with a deprecation.

### B. `Graph` owns the embedding lifecycle

```ts
const g = new Graph(db, schema, { embedder });
await g.addNode({ type: 'note', body }); // embedded
await g.updateNode(id, { body: newBody }); // re-embedded — embed_hash changed
await bulkLoad(db, schema, rows, { embedder }); // batch-embedded before insert
```

- `embed_hash = sha256(embedder.id + '\0' + text)` computed and compared **in core**, so
  `updateNode` re-embeds only when the input text changed. This kills the stale-vector bug and gives
  `embed_hash` a meaning outside ingest. `ingestDir` drops its private copy of this logic.
- `emb: number[]` still accepted (bypass); `embed: false` per call to skip.
- `serve`, MCP, admin, and React get correct behaviour for free because they all go through
  `Graph`. `ServeConfig` and `DevServeConfig` take `embedder`; `graphForProject` passes it to
  `initOnce` so the production path sizes the column correctly.
- `embedding: 'lazy'` on the Graph writes the node with `emb = NULL` and enqueues an outbox event
  that a built-in `embedAction` trigger consumes. Same machinery as `webhookAction`; nothing new.

### C. Embedding input is declared per type

```ts
defineGraphSchema({
	nodes: {
		note: z.object({ title: z.string().optional() }), // default: body
		person: {
			schema: z.object({ name: z.string(), bio: z.string() }),
			embed: (data, body) => `${data.name}\n${data.bio}\n${body ?? ''}`,
		},
	},
});
```

Default stays `body`. Data-only nodes stop being invisible.

### D. Vectors move to a side table keyed by model

```sql
CREATE TABLE node_embeddings (
  id        TEXT NOT NULL,     -- node identity
  ver       INTEGER NOT NULL,  -- node_versions.ver this vector was computed from
  model_id  TEXT NOT NULL,
  chunk     INTEGER NOT NULL DEFAULT 0,
  emb       F32_BLOB(<dim>) / vector(<dim>) / FLOAT[],
  embed_hash TEXT NOT NULL,
  PRIMARY KEY (ver, model_id, chunk)
);
-- partial live index per model, same shape as today's nv_emb_idx
```

This is the same pattern the codebase already uses for analytics (D4/B10: "version rows stay
byte-stable — no analytics columns on node_versions"). It buys:

- `dim` becomes a per-model property created lazily on first embed — `init` needs no width.
- Multiple models coexist; switching is **additive**, not "delete the namespace". Fits bitemporal.
- `graphx reembed --model <id>` is a resumable bulk job (cursor in `trigger_cursors`, progress on
  stderr). Old vectors can be dropped or kept.
- As-of-past retrieval becomes honest: historical versions can be embedded on demand, and the seed
  query filters `model_id = active`.
- `chunk` is in the key from day one so chunking (E) is not a second migration.

Migration: copy `node_versions.emb` → `node_embeddings` with `model_id` from `graph_meta` (or
`'unknown:<dim>'`), keep the old column one release, drop it after. `readEmbDim` goes away.

**Smaller alternative** if the side table is too much now: add `emb_model TEXT` to `node_versions`
plus the meta row. Gets model identity and fail-fast, but not multi-model, not dim-free init, not
chunking.

### E. Chunking

Per-type `chunk: { size: 800, overlap: 100 }`. Seeds are chunks; results are grouped to nodes
(max score) with the matching chunk text returned as `snippet`. Phase 3, but the table shape in D
already accommodates it.

### F. A retrieval result worth returning

```ts
interface RetrievedNode<S> {
	id: string;
	type: NodeType<S>;
	data: DataOf<S, ...>;
	body: string | null;
	uri: string | null;
	depth: number;
	score: number | null; // cosine (or RRF) — null for walked-only rows
	via: ('vector' | 'fts' | 'walk')[];
	seed: string; // which seed's walk reached it
	snippet?: string; // best chunk, once E lands
}
```

One round trip for the admin, React, and agents. `k` documented as _seed count_, not result count.

### G. Fix the libSQL as-of rank

Replace `MIN(v.id)` with a true distance: over-fetch `k×4` ids from `vector_top_k`, then
`ORDER BY vector_distance_cos(n.emb, vector(?))` over that set. Forty rows; cost is nil. Add the
three-node probe from §1 as a regression test on all three dialects.

### H. Validate in graphx, fail with graphx errors

`Graph`, `bulkLoad`, and the wire schemas check `emb.length === dim`, reject NaN/non-finite, and
short-circuit zero-vector queries to `[]`. New `EmbeddingDimensionError` → 400 on the wire with the
namespace's model and width in the message. DuckDB needs this most (§1).

### I. One source of truth for the CLI and MCP

- `graphx mcp` local mode loads `graphx.config.ts` (the CLI already does; it is Bun) instead of a
  JSON schema + `hashEmbed`. `schema-file.ts` and `GRAPHX_SCHEMA` go away. Remote mode unchanged.
- `loadConfig` registers the DuckDB driver too, and `buildServeApp` forwards its config.
- `graphx doctor`: per namespace — model, dim, embedded / unembedded / stale counts, index present,
  backend ceiling warning.
- `graphx reembed [--model <id>] [--dry-run]`.

### J. Be honest about libSQL scale

Document the measured build curve as a ceiling; expose DiskANN params
(`max_neighbors`, `compress_neighbors=float8`) via `defineEmbedder({ index: {...} })`; measure at 768
and 1536; state plainly that above ~50k vectors Postgres/pgvector is the recommended backend. Lazy
embedding (B) keeps interactive writes off the index-insert path.

---

## 4. Order of work

| Phase                                   | Scope                                                                                                                                                                                                                                                                   | Why first                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **P0 — stop the bleeding** (1–2 days)   | Dim validation + graphx errors in `Graph`/`bulkLoad`/wire (H); production `createApp` and `graphForProject` honour the embedder's dim; MCP loads the config; libSQL as-of rank fix + parity test (G); README correction; CLI DuckDB driver.                             | Every item is a reproduced defect with a user-visible failure. No API change.                      |
| **P1 — core owns embedding** (2–3 days) | `defineEmbedder` with id/dim/batch (A); `Graph { embedder }` + auto re-embed on `embed_hash` change + `bulkLoad` batch embed (B); per-type embed input (C); `model_id` in meta with fail-fast on mismatch; `graphx/embedders` adapters. `dim` removed from config/docs. | Removes the entire class of "I forgot to embed" and "dim doesn't match" bugs. `ingestDir` shrinks. |
| **P2 — model-keyed vectors** (3–5 days) | Side table + migration (D); `graphx reembed`; richer `RetrievedNode` (F); `graphx doctor`; DiskANN params + documented ceiling (J).                                                                                                                                     | Makes model changes additive and gives operators visibility.                                       |
| **P3 — chunking + lazy embedding**      | E; `embedding: 'lazy'` via a built-in trigger action.                                                                                                                                                                                                                   | Needed for real-model quality on ingested documents; builds on the outbox that already exists.     |

---

## 5. Things that are fine

Worth saying so they are not re-litigated: the three-dialect seed/walk SQL is well factored
(`dialect-sql.ts`); the partial live index is the right shape; RRF + walk + MMR is a sound hybrid
pipeline; `fixtureEmbed` is a genuinely good record/replay design; the eval harness
(`eval-golden`, `eval-parity`) is the right way to keep the legs honest; query latency at 10k vectors
is single-digit milliseconds on all three backends. The problems above are ownership and lifecycle,
not the query engine.
