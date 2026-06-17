# ingest

Ingest a local YAML/markdown vault into a [graphx](../core) graph: **1 file = 1 node**,
links become edges, re-runs reconcile incrementally using graphx's bitemporal model.

```ts
import { defineGraphSchema, Graph, getDb, init } from 'core';
import { ingestDir } from 'ingest';
import { z } from 'zod';

const schema = defineGraphSchema({
  nodes: { note: z.object({ title: z.string().optional() }).passthrough() },
  edges: { links_to: { from: 'note', to: 'note' } },
});

const db = getDb('my-vault');
await init(db, 768);
const graph = new Graph(db, schema);

const result = await ingestDir({
  dir: './vault',
  graph,
  embed: async (text) => myEmbedder(text), // (text: string) => Promise<number[]>
});
// { added, updated, unchanged, edgesAdded, edgesClosed, skipped }
```

## Conventions

- **Identity** = relative path, stored in the node `uri` column as `file:<path>`.
- **kind** = `frontmatter.kind`, else the top-level folder name (`kindOf` overrides).
- **props** = frontmatter minus `kind`, validated by the node kind's schema.
- **body** = markdown body (also the embed input).
- **edges** = `[[wikilink]]` (by basename) and `[text](./rel.md)` (by path) → `links_to`.
- **change detection** = sha256 of the file in `content_hash`; unchanged files are skipped (no re-embed).

## v1 limitations

- Deleted files leave stale live nodes (graphx has no public `deleteNode` yet).
- A rename creates a new node and orphans the old one.
- Local filesystem only (no S3 source yet).
- Links resolve only when the basename is unambiguous; otherwise the link is skipped.

See [`docs/superpowers/specs/2026-06-17-file-ingest-static-graph-design.md`](../../docs/superpowers/specs/2026-06-17-file-ingest-static-graph-design.md).
