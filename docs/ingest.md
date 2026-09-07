# graphx/ingest

Ingest a local YAML/markdown vault into a [graphx](../packages/graphx) graph: **1 file = 1 node**,
links become edges, re-runs reconcile incrementally using graphx's bitemporal model.

```ts
import { defineGraphSchema, Graph, getDb, hashEmbed, init } from 'graphx';
import { ingestDir } from 'graphx/ingest';
import { z } from 'zod';

const schema = defineGraphSchema({
	nodes: { note: z.object({ title: z.string().optional() }).passthrough() },
	edges: { links_to: { from: 'note', to: 'note' } },
});

const embedder = hashEmbed(); // or openai(...) from 'graphx/embedders'
const db = getDb('my-vault');
await init(db, embedder);
const graph = new Graph(db, schema, { embedder });

const result = await ingestDir({
	dir: './vault',
	graph, // its embedder embeds every body — batched, one embedder call per run
});
// { added, updated, unchanged, edgesAdded, edgesClosed, skipped }
```

## Conventions

- **Identity** = relative path, stored in the node `uri` column as `ingest:<source>:<path>` (`source` defaults to `default`; set it per vault so each ingest only reconciles its own nodes).
- **kind** = `frontmatter.kind`, else the top-level folder name (`kindOf` overrides).
- **props** = frontmatter minus `kind`, validated by the node kind's schema.
- **body** = markdown body (also the embed input).
- **edges** = `[[wikilink]]` (by basename) and `[text](./rel.md)` (by path) → `links_to`.
- **assets** (opt-in `assets: { kind, rel? }`) = `![[x]]` / `![alt](x)` embeds → an edge to the
  embedded note if it's ingested, else a metadata-only asset node (path + MIME, no bytes).
- **change detection** = sha256 of the file in `content_hash`; unchanged files are skipped. A changed
  file is re-embedded only if its embedding input (per the type's policy) changed — a frontmatter-only
  edit costs no embedder call. A model change is `graphx reembed`, not an ingest option.

## v1 limitations

- Deleted files leave stale live nodes unless you pass `prune: true`, which retracts this
  source's nodes (and their incident edges) for files removed from disk.
- Give a file a frontmatter `id` (the `idField` option, default `id`) for rename-stable
  identity: renaming the file keeps the same node, history, and edges. Without an `id`, a
  rename is delete+add (the old node is pruned only when `prune` is set).
- Filesystem by default (`dir`); for other backends pass a `fileSource` implementing
  `Source { list(); read(key) }`. An optional S3 reader ships at `ingest/s3` (`s3Source`,
  gated behind an optional `@aws-sdk/client-s3` peer — not pulled in unless you import it).
- Wikilinks resolve by unique basename; a collision is disambiguated by a folder-qualified
  link (`[[dir/Note]]`) or a same-folder match, else reported as `ambiguous-link` (with the
  candidates) in `result.skipped` rather than silently guessed.
- `result.skipped` entries are structured: `{ key, stage, code, reason, detail? }` — e.g.
  `schema-reject` carries the Zod issues, `ambiguous-link` carries the candidate paths.
