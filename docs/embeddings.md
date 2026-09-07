# Embeddings

graphx owns the embedding lifecycle. You declare an embedder once; the graph embeds on write,
re-embeds when the text changes, refuses a model that does not match the namespace, and can be
re-indexed with one command. There is no `dim` to configure and nothing to keep in sync.

This document is both the design record for the rewrite (what changed and why) and the guide.

## The model

- **One embedder per namespace.** Its `id` and width are recorded in `graph_meta` the first time
  the namespace is initialised with it. A later `init` with a different embedder throws
  `EmbeddingError` (`code: 'model'`) naming both models. `graphx reembed` (or `Graph.reembed`)
  switches models: it drops the vectors, recreates the table at the new width, and re-embeds every
  live node.
- **Vectors are derived data in a side table.** `node_embeddings(id, chunk, emb, embed_hash, text)`
  keyed by `(id, chunk)`. `node_versions` carries no vector: history stays byte-stable across model
  changes, and a version row is never rewritten because of a re-embed. Only the live version of a
  node has vectors; time-travel retrieval seeds from live vectors and filters to the versions valid
  at the requested instant, as before.
- **Embedding input is declared per type.** Default is `body`. `defineGraphSchema({ embedding:
{ person: { text: (data, body) => ... } } })` overrides it, so data-only nodes are searchable.
- **Chunking is per type.** `embedding: { note: { chunk: { size: 800, overlap: 100 } } }` splits
  the input on paragraph boundaries into windows; each chunk is one vector row and the best chunk
  is returned as `snippet`. Without `chunk`, one vector per node.
- **Staleness is a hash.** `embed_hash = sha256(embedder.id + '\0' + text)` is stored beside each
  vector. `updateNode` re-embeds only when the hash changes; a data-only edit on a body-embedded
  type costs nothing.
- **Validation is graphx's, not the database's.** Every vector is checked against the
  namespace width before SQL. A mismatch is `EmbeddingError` (`code: 'dimension'`) with the two
  widths in the message, 400 on the wire. Non-finite components are rejected. An empty query
  returns `[]`.

## Declaring an embedder

```ts
import { defineEmbedder } from 'graphx';

export const embedder = defineEmbedder({
	id: 'openai:text-embedding-3-small',
	embed: async (texts) => {
		const res = await fetch('https://api.openai.com/v1/embeddings', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
		});
		const json = await res.json();
		return json.data.map((d: { embedding: number[] }) => d.embedding);
	},
	// dim: 1536,      — optional; probed once with a constant string and cached
	// batchSize: 64,  — texts per embed() call (default 64)
	// maxChars: 32000 — inputs are truncated to this before embedding
});
```

`embed` is batch-first: it takes `string[]` and returns `number[][]`. The wrapper splits large
batches, checks every vector's width, caches `dim`, and applies `maxChars`.

Adapters that ship in the box, all model-free or `fetch`-only so they add no dependency:

| Import                                            | What it is                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `hashEmbed(dim = 768)`                            | Deterministic hashed bag-of-tokens. Lexical, not semantic. Dev, tests, demos. |
| `fixtureEmbed({ path, embedder })`                | Record/replay over a real embedder into a committed JSON file.                |
| `graphx/embedders` → `openai`, `voyage`, `ollama` | `fetch`-based adapters; pass a model name and (optionally) a key/base URL.    |

## Using it

```ts
const embedder = hashEmbed();
const db = getDb('acme__alpha');
await init(db, embedder); // creates node_embeddings at the embedder's width, records the model
const g = new Graph(db, schema, { embedder });

await g.addNode({ type: 'note', data: {}, body: 'free text' }); // embedded
await g.updateNode(id, { body: 'edited' }); // re-embedded — the hash changed
await g.updateNode(id, { data: { title: 'x' } }); // not re-embedded — body unchanged
await g.deleteNode(id); // vectors removed; the version history is untouched

await g.retrieve({ query: 'free text', k: 10, maxDepth: 2 });
await g.hybridRetrieve({ query: 'free text', k: 10 });
```

Escape hatches on every write: `emb: number[]` binds a precomputed vector (validated), `embedding:
false` skips embedding for that write, and `embedding: <PreparedEmbedding>` binds rows produced by
`g.prepareEmbeddings(...)` — the batch path ingest uses.

`createApp({ schema, embedder })` in both the dev and production overloads: every tenant namespace
is initialised at the embedder's width on first touch, and `/retrieve`, `/hybrid`, `POST /nodes`,
`PATCH /nodes/:id`, `POST /bulk` all embed through the same `Graph`.

`bulkLoad(db, schema, rows, { embedder })` batch-embeds every live row that has no `emb`, inside
the same deferred-index bracket it already used.

### Lazy embedding

`new Graph(db, schema, { embedder, embedding: 'lazy', events: { outbox: true } })` writes nodes
without vectors and leaves the work to a trigger:

```ts
import { embedTrigger } from 'graphx';
export default { schema, embedder, triggers: [embedTrigger()] };
```

`graphx triggers` (or a `TriggerRunner`) then embeds each node after its write commits. Interactive
writes never wait on the embedding API.

### Retrieval results

```ts
interface RetrievedNode<S> {
	id: string;
	type: NodeType<S>;
	data: DataOf<S, ...>;
	body: string | null;
	uri: string | null;
	depth: number; // 0 = seed
	score: number | null; // cosine similarity for vector seeds, RRF score for hybrid seeds, null when walked
	via: ('vector' | 'fts' | 'walk')[];
	seed: string; // the seed whose walk reached this node (itself for seeds)
	snippet: string | null; // the best-matching chunk when the type is chunked
}
```

`k` is the number of seeds; the result is the seeds plus everything reached within `maxDepth`,
bounded by `limits.maxRows`.

## Operations

```
graphx doctor  [-c config]              Model, width, embedded / unembedded / stale counts, index state
graphx reembed [-c config] [--dry-run]  Re-embed every live node; switches the namespace to the configured model
graphx mcp     [-c config] [--read-only] Loads the same config — schema, embedder, namespace — so MCP local mode is never lexical by accident
```

## Backend notes

|                   | libSQL                                     | Postgres                 | DuckDB                                                   |
| ----------------- | ------------------------------------------ | ------------------------ | -------------------------------------------------------- |
| Column            | `F32_BLOB(dim)`                            | `vector(dim)`            | `FLOAT[]` (width enforced by graphx)                     |
| Index             | `libsql_vector_idx` DiskANN over the table | HNSW `vector_cosine_ops` | none — brute-force `list_cosine_distance` over live rows |
| Width recorded in | `graph_meta`                               | `graph_meta`             | `graph_meta` (+ manifest)                                |

libSQL's DiskANN build is superlinear: measured at dim 128, 2k vectors take ~6s, 5k ~16s, 10k ~36s,
25k ~108s. Query latency stays single-digit milliseconds. Above ~50k vectors use Postgres. `bulkLoad`
and `reembed` drop and rebuild the index around the load; interactive writes pay one index insert each,
or none with `embedding: 'lazy'`.

## What changed (2026-09)

- `EmbedFn` (a bare `(text) => number[]`) is gone. `defineEmbedder` / `Embedder` replaces it everywhere: `init`, `Graph`, `createApp`, `bulkLoad`, `retrieve`, `hybridRetrieve`, `ingestDir`, the CLI config.
- `dim` is gone from `init`, `createApp`, `graphx.config.ts`, and the scaffold. `readEmbDim` is replaced by `readEmbeddingMeta`.
- `node_versions.emb` and `node_versions.embed_hash` are gone. Vectors live in `node_embeddings`.
- `Graph`'s constructor takes one options object: `new Graph(db, schema, { upcasters, events, embedder, embedding })`.
- `RetrievedNode` carries `type`, `data`, `score`, `via`, `seed`, `snippet`.
- libSQL as-of retrieval ranks by true cosine distance (it ranked by rowid before).
- `graphx mcp` reads `graphx.config.ts`. `GRAPHX_DB`, `GRAPHX_SCHEMA`, and the JSON schema-file format are gone.
- `ingestDir` no longer takes `embed`, `embedId`, or `embedConcurrency`; the graph's embedder is used.
- New: `graphx reembed`, `graphx doctor`, `embedTrigger`, `Graph.embedNode`, `Graph.reembed`, `Graph.embeddingReport`, `Graph.prepareEmbeddings`, `graphx/embedders`.
