# Ingest + Graph Completeness — Design / Roadmap

> Status: COMPLETE (all 11 clusters shipped + final review READY, 2026-06-18).
> Final: libSQL 449/0, Postgres 431 pass/18 skip/0 fail. Branch: `feat/ingest-graph-completeness`
> (off `feat/file-ingest`, which carries the Postgres dual-backend infra + `packages/ingest`).
> Scope: close all 16 gaps surfaced after the file-ingest v1, plus the full P9 blob layer.

## Goal

Make the file-ingest "static graph over a vault" promise actually hold over time
(deletes/renames reconcile, not just grow), make the graph expressive (typed edges,
edge props, frontmatter edges), scale (streaming + batched embeds + re-embed gating),
reach further (S3 source, CLI, watch), and ship the missing P9 blob byte-storage layer.
Every change keeps libSQL + Postgres at parity.

## Grounding correction (from the survey)

Three "gaps" are smaller than first stated:

- **`deleteNode`** = ~15-line mechanical copy of `deleteEdge` (graph.ts:772-792) on
  `node_versions`, reusing `runConditionalClose` (graph.ts:647-666) verbatim → MVCC retry
  - dialect tx seam inherited free. No new SQL fragment, no schema change.
- **Edge weight/props** = NOT a core gap. `edge_versions.weight`/`.props` columns, the
  `edges` view, `AddEdgeInput.weight`/`.props`, per-rel validation, and the writer all
  already exist on both backends. Only ingest's `LooseGraph.addEdge` narrows them away.
- **Image embeds** = `links.ts` already detects them (`isEmbed`) and skips. Lightweight
  asset nodes (path+hash+mime, no bytes) ride existing columns; not blocked on P9.

## Resolved design forks

| Fork                    | Decision                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deleteNode edge cascade | **A** — close node version only (mirror deleteEdge); document caller retracts edges. Cascade is a later opt-in.                                                                                                                                          |
| Deletion safety         | **prune: true opt-in** flag + absent-set scoped per-source via the namespaced uri prefix. Never delete-by-default.                                                                                                                                       |
| uri namespace           | `ingest:<source>:` prefix (replaces `file:`); LIKE pattern **parameterized** (bound `?`), not interpolated.                                                                                                                                              |
| Identity / rename       | Configurable `idField` (default `id`) → `id:<id>` uri; fallback path-keyed `file:<path>`. Distinct `id:`/`file:` sub-namespaces. Separate path→id index for link resolution.                                                                             |
| Typed relations         | **Both** — Dataview inline `[rel:: [[t]]]` + frontmatter `edgeFields` config, feeding one per-rel desired-edge map; inline overrides. Unknown rel → skip-with-clear-reason (pre-validate vs schema).                                                     |
| Edge props/weights      | Widen ingest `LooseGraph.addEdge` + call site; reconcile gains value-equality check (else props write-once); `liveOutEdges` must also SELECT weight/props.                                                                                               |
| embedHash persistence   | **Dedicated `embed_hash` column** in `node_versions` — symmetric libSQL + PG DDL. Embed input = body only.                                                                                                                                               |
| Batched embeds          | Concurrency-limited fan-out in ingest (single-text `EmbedFn` kept, no core change); `embedConcurrency` option. Must preserve key→embedding association.                                                                                                  |
| Streaming               | Buffer only extracted links per touched file (option b), not full `ParsedFile[]`; reconcile edges after nodes built.                                                                                                                                     |
| Ambiguous wikilink      | `resolveLink` returns resolved/missing/ambiguous; folder-qualified `[[dir/Note]]` → same-folder → report-and-skip. No silent tie-break.                                                                                                                  |
| Schema-reject report    | Structured tagged entry `{key, stage, code, message, detail?}` (catch ZodError → issues) as a **parallel field**; keep flat string view (no semver break).                                                                                               |
| S3 source               | Ship `Source {list, read}` + default `fsSource` now; S3 reader as optional `ingest/s3` subpath, `@aws-sdk/client-s3` optional peer + 2nd bunup entry (mirrors core/pg). Keep `dir:` as sugar.                                                            |
| CLI                     | New `packages/cli`, `bin: graphx`, Bun `util.parseArgs`, dynamically-imported `graphx.config.ts` (default-export `{schema, embed, db}`) + `--config` override. db→getDb so backend selection rides along.                                                |
| Watch                   | `fs.watch({recursive})` + 150-300ms debounce, single-flight + one trailing run; `watchDir()` primitive in ingest, `--watch` flag in cli. Polling fallback documented.                                                                                    |
| Image-asset             | Lightweight metadata node (uri/path + content_hash + content_type, empty body) + `embeds` edge, riding existing reconcile.                                                                                                                               |
| P9 blob layer           | **In scope (full).** put(bytes,contentType)->{uri,hash}, SHA256 content addressing `blobs/{prefix}/{hash}`, S3 IfNoneMatch dedup/412, presign(ttl=900), get, inline-<32KB-else-S3 policy, GC off by default. Optional S3 SDK (same gating as s3-source). |

## Cluster sequence (each = one shippable commit set, both backends green)

1. **Foundation: `deleteNode` + parity test** (S) — core primitive + P6 bitemporal-close test.
2. **Quick wins: uri-namespace + minor tests** (S) — `ingest:<source>:` prefix (parameterized LIKE); .yml discover test + http:// link test.
3. **Ingest deletion + reconcile pass** (M) — absent-set → deleteNode, `prune` opt-in, `result.deleted`. Dep: 1,2.
4. **Edge expressiveness** (L) — typed relations (inline + frontmatter) + edge weight/props; one per-rel desired-edge map.
5. **Resolution & reporting** (M) — ambiguous-link disambiguation + structured skip report.
6. **Identity & rename stability** (L) — `idField` → stable identity; rename = update not delete+add. Dep: 3.
7. **Scale** (L) — streaming discover + batched embeds + `embed_hash` re-embed gating.
8. **Reach: Source abstraction** (M) — `Source`/`fsSource` + optional `ingest/s3` subpath. Dep: 7.
9. **Lightweight image-asset ingestion** (M) — asset nodes + embeds edge. Dep: 4.
10. **Ergonomics: CLI + watch mode** (M) — `packages/cli` + `watchDir()`. Dep: 3,4.
11. **EPIC: P9 blob byte-storage layer** (XL) — full blob.ts + S3 + presign + inline policy. Dep: 8.

## Cross-cutting constraints (must hold every cluster)

- Tests obtain connections only via `makeTestDb()`; transaction-using methods (incl. new
  `deleteNode`) need `makeTestDb({file:true})` on libSQL.
- ANN/FTS assertions = set-membership, never ordered array equality.
- libSQL-native probes guarded with `libsqlOnly = TEST_DRIVER==='postgres' ? test.skip : test`;
  the 18 PG skips stay at 18 (+ any new guarded probes), 0 fail.
- New `deleteNode` reuses `runConditionalClose` — no ad-hoc try/catch (inherits 40001/40P01/
  SQLITE_BUSY/LOCKED retry classifier).
- Any new `node_versions` column (`embed_hash`) → byte-symmetric DDL in `schema.ts` +
  `dialect-sql.ts`/`postgresSchema`, and the `bulk.ts` writer, in the same commit.
- Optional `@aws-sdk` peer never imported from a main entry (`index.ts`); gated behind a subpath.

## Risks (from survey — guard actively)

- uri-prefix change orphans existing `file:` nodes → re-added under new prefix, old become
  deletion candidates once prune lands. One-time backfill/migration decision before enabling prune.
- rename dual-keying (path→id for resolve vs identityKey→id for live map) must be consistent
  across `loadLiveMap` AND node-create or a rename silently deletes history. Highest blast radius.
- edge props reconcile becomes write-once unless value-equality check added.
- batched embeds reorder on resolve — preserve key→embedding association or nodes get wrong vectors.
- `embed_hash` DDL must stay byte-symmetric across backends.
- schema-reject report must not mutate the existing `skipped` shape (add parallel field).
