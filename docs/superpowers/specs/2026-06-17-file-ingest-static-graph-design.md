# File-Ingest "Static Graph over Filesystem" — Design

> Status: approved design, pre-implementation. Date: 2026-06-17.
> Scope: a v1 ingestion pipeline that turns a local directory of YAML/markdown
> files into a graphx graph, with incremental bitemporal re-sync.

## 1. Goal

Let a user keep a graph as version-controlled YAML/markdown files (an Obsidian-style
"vault") and ingest it into an existing graphx graph (libSQL or Postgres). Files are the
**source**; the graph database stays the source of truth. Re-running ingest after edits
reconciles incrementally and leverages graphx's bitemporal model, so the graph carries a
history of file edits and supports as-of / time-travel queries over the vault.

## 2. Non-goals (v1)

- **No S3 source.** Local filesystem only. The source step is shaped so an S3 reader can
  drop in later, but no `aws-sdk`/S3 code ships in v1.
- **No deleted-file handling.** When a file disappears between runs its node stays live
  (graphx has no public `deleteNode`/retract primitive yet). Documented limitation.
- **No rename tracking.** A rename = a new node at the new path + an orphaned old node
  (a direct consequence of path-as-identity + no deletion).
- **No new core primitives.** v1 uses only the existing public `core` API.

## 3. Decisions (resolved during brainstorming)

| Fork | Decision |
|---|---|
| Role of files | **Source → ingest into DB.** DB is the truth; files are input. |
| File → graph mapping | **Convention: 1 file = 1 node** (Obsidian-style). |
| Re-sync semantics | **Incremental upsert (temporal diff)** keyed on a content hash. |
| Embeddings | **On.** Inject an `EmbedFn`; populate `emb` so `retrieve` works. |
| Diff-state location | **Query the graph** each run (no sidecar). The graph can't drift. |
| Packaging | **New `packages/ingest`** depending on `core`'s public API. |
| Node identity | **Relative POSIX path** (stored as a prop). Renames orphan (see §2). |

## 4. Package & public API

New package `packages/ingest` (package name `ingest`), depending on `core` and a
frontmatter parser (`gray-matter` or equivalent). The YAML/markdown parser dependency
stays out of `core`.

One entry point:

```ts
import type { EmbedFn } from 'core';
import { Graph, type GraphSchema } from 'core';

export interface IngestOptions<S extends GraphSchema> {
  /** Local vault root. */
  dir: string;
  /** Target graph, already bound to its DbClient + schema. */
  graph: Graph<S>;
  /** Embedding function (required in v1 — embeddings-on scope). */
  embed: EmbedFn;
  /** File globs. Default: `**\/*.{md,markdown,yml,yaml}`. */
  include?: string[];
  /** Override kind resolution. Default: `frontmatter.kind ?? <top-level folder>`. */
  kindOf?: (file: ParsedFile) => string | undefined;
  /** Injectable clock for deterministic tests (graphx convention). */
  now?: number;
}

export interface IngestResult {
  added: number;
  updated: number;
  unchanged: number;
  edgesAdded: number;
  edgesClosed: number;
  /** Files/links skipped, with a reason (unknown kind/rel, unresolved link, parse error). */
  skipped: Array<{ path: string; reason: string }>;
}

export function ingestDir<S extends GraphSchema>(
  opts: IngestOptions<S>,
): Promise<IngestResult>;
```

`ingestDir` is the whole public surface for v1. Internals (discover, parse, reconcile)
are unexported helpers.

## 5. Conventions (1 file = 1 node)

- **Identity key** = the file's relative path from `dir`, POSIX-normalized (e.g.
  `notes/foo.md`), stored in the node's **`uri` column** as `file:notes/foo.md`. It is the
  link-resolution target and the diff key. The graph's own node id stays the auto-minted
  ULID; ingest maps key→ULID.
  - **Why `uri`, not `props`:** node `props` are validated by the kind's zod schema, and
    `z.object({…})` **strips unknown keys by default** — an injected `props.path` would be
    silently dropped. `uri` and `content_hash` are first-class node columns
    (`AddNodeInput.uri` / `.content_hash`), immune to props stripping.
- **kind** = `frontmatter.kind`, else the top-level folder name (e.g. `notes/foo.md` →
  `notes`). `kindOf` overrides. A vault-root file with no `frontmatter.kind` → no kind → skipped.
- **props** = the frontmatter minus the reserved key `kind`. Validated by the bound schema.
- **body** = the markdown body (frontmatter stripped). This is also the embed input.
- **content hash** = `sha256` of the raw file bytes, stored in the **`content_hash` column**
  (`AddNodeInput.content_hash`). The diff reads `uri` + `content_hash` back via `graph.raw`
  from the live `nodes` view (the typed node from `listNodes`/`getNode` carries only
  `id`/`kind`/`props`).
- **edges** = links found in the body:
  - `[[wikilink]]` → resolved by basename/slug against the path map.
  - `[text](./relative.md)` → resolved by relative path against the path map.
  - relation = `links_to` (v1 fixed default).

**Schema awareness.** The bound schema must declare the kinds the vault uses and the
`links_to` relation. A file whose resolved kind is not in the schema is **skipped**
(recorded in `skipped`), not fatal. A link whose relation/endpoints the schema rejects is
likewise skipped.

## 6. Pipeline (two-pass)

1. **Discover** — walk `dir`, apply `include` globs → file list.
2. **Parse** — for each file: split frontmatter (YAML) and body; compute
   `hash = sha256(raw)`; derive `kind`, `props`, `body`. Parse failures → `skipped`.
3. **Load live map** — one `graph.raw` query against the live `nodes` view
   (`SELECT id, uri, content_hash FROM nodes WHERE uri LIKE 'file:%'`), building
   `keyToNode: Map<key, { id, hash }>` (key = the `uri` with the `file:` prefix stripped).
4. **Reconcile nodes (pass 1)** — for each parsed file, by key:
   - **new** → `graph.addNode({ kind, body, uri: 'file:'+key, props: fm, content_hash, emb: await embed(body) })`
   - **known, hash changed** → `graph.updateNode(id, { kind, body, props: fm, content_hash, emb: await embed(body) })` (new temporal version; old one auto-closed)
   - **known, hash same** → skip (no write, **no re-embed**)
   - record the resulting `key → nodeId` for every live file (needed for link resolution).
5. **Reconcile edges (pass 2)** — only for files touched in pass 1 (added/updated): parse
   links → resolve targets via the path map → desired out-edge set `(src=fileNode, rel=links_to, dst=targetNode)`.
   Read the node's current live out-edges through `graph.raw`
   (`SELECT id, rel, dst FROM edges WHERE src = ?`), diff, then `graph.addEdge(...)` the
   new ones and `graph.deleteEdge(id)` the gone ones. Links to a missing file → `skipped`.

Unchanged files do no node or edge work — re-running a clean vault is a near-no-op (one
`listNodes` scan + hashing).

## 7. Idempotency & the temporal payoff

- Run twice on an unchanged vault → second run reports all `unchanged`, 0 writes.
- Edit a file → one `updated`, a new node version; `getNode` returns the new content,
  history / as-of returns the prior version. This is the reason for choosing temporal
  upsert over rebuild.
- Re-embedding happens only on content change (hashing gates it), so embedding cost
  tracks edits, not vault size.

## 8. Edge reconciliation detail

`deleteEdge(id)` needs an edge id; there is no dedicated public "list a node's out-edges"
method, so v1 reads them through the documented public `graph.raw` DbClient against the
live `edges` view. A future `Graph.listOutEdges(id)` helper would remove this reliance —
noted as a follow-up, not built in v1.

## 9. Dependencies

- `core` (workspace, public API).
- A frontmatter parser (`gray-matter` or similar) — `ingest`-local, not added to `core`.
- Standard library for FS walk + `sha256` (Bun/Node `node:crypto`, `node:fs/promises`).

## 10. Testing strategy

- Temp-dir fixtures written per test; teardown removes them.
- Deterministic fake `embed` (e.g. hash-seeded vector) so vector writes are reproducible.
- Cases:
  - first ingest → expected `added` count, nodes + edges present;
  - **idempotency**: second run → all `unchanged`, 0 writes;
  - edit a file → `updated` + version history shows both versions;
  - add a link → `edgesAdded`; remove a link → `edgesClosed`;
  - unknown kind / unresolved link → recorded in `skipped`, not fatal.
- Runs on **both** backends (libSQL default + Postgres) via the existing
  `GRAPHX_TEST_DRIVER` harness, since `ingest` only touches the dialect-neutral public
  API. Assert set-membership (not exact order) anywhere vector ranking is involved.

## 11. Future / out-of-scope (deliberate)

- **S3 source** — a second source reader behind the discover step.
- **`deleteNode`/retract core primitive** — enables deleted-file handling and clean
  renames; a real SDK gap surfaced by this work.
- **Frontmatter `id`** as an optional rename-stable identity override.
- **Per-link relation** (e.g. `rel` in link syntax or frontmatter) beyond `links_to`.
- **`Graph.listOutEdges(id)`** helper (see §8).

## 12. Grounded API references (verified against the tree)

- `EmbedFn = (text: string) => Promise<number[]>` — `retrieve.ts`.
- `AddNodeInput { kind, props, emb?, body?, uri?, content_hash?, content_type? }` — `graph.ts`.
- `Graph.updateNode(id, { body?, uri?, content_hash?, content_type?, kind?, props?, emb? })`
  creates a new version — `graph.ts`.
- `Graph.addEdge(AddEdgeInput) → EdgeRef { id, rel, ... }`; `Graph.deleteEdge(id)` — `graph.ts`.
- `Graph.listNodes({ kind?, cursor?, … }) → { nodes: AnyNode[], nextCursor: string | null }`
  (keyset) — `graph.ts`. The typed node (`rowToNode`) carries only `id`, `kind`, `props`.
- Live `nodes` view exposes `id, kind, body, uri, content_hash, content_type, props, emb`
  (both dialects); live `edges` view exposes `id, src, dst, rel, weight, props` — `schema.ts` / `dialect-sql.ts`.
- `graph.raw` is the public DbClient escape hatch — `graph.ts`.
