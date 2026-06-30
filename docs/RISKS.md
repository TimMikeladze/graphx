# graphx — Risk Blindspots (built code)

> Latent risks in code that **is built and green-tested**, as of audit on 2026-06-19 (`main` @ `1c38d09`).
> Scope: `packages/ingest`, `packages/cli`, and the `packages/core` read/write/schema paths they drive.
>
> Companion to [`GAPS.md`](./GAPS.md). GAPS.md catalogs **unbuilt features** (P10 tiering, missing HTTP routes, `@graphx/react`, admin write UI, READMEs). `.dual-db-findings.json` catalogs SQLite→Postgres porting hazards. This doc is the third axis: **correctness/safety risks in shipped code** — silent data loss, races, scaling cliffs, and trust-boundary holes that the test suite is green against because no test exercises them.

Each finding was produced by an adversarial finder reading the actual source, then independently re-verified against that source (claims that didn't survive re-read are in [§7](#7-investigated-and-dismissed)). `file:line` references are from the audited tip.

---

## How to read severity

- 🔴 **High** — silent data loss, security boundary crossing, or "broken looks like success" in a default/common path.
- 🟡 **Medium** — real correctness/operability failure, but gated behind a non-default flag, a multi-writer setup, scale, or an untrusted vault.
- 🟢 **Low** — pollution, papercut, or a hole that only bites a future/optional feature.

Retractions noted as *recoverable* are bitemporal soft-closes (`UPDATE … SET valid_to = now`) — the row survives in history and is reachable via as-of queries; it disappears from live reads only.

---

## 1. Ingest assumes it is the sole writer and sole authority

The reconcile model treats the graph as if `ingestDir` is the only thing that ever writes to it. This breaks the moment anything else participates — the admin UI, an enrichment job, a second ingest process, or a teammate.

### 🔴 Edge ownership: reconcile silently deletes edges authored by users/other systems
> ✅ **Fixed** on `fix/ingest-top3-risks` — added a nullable `edge_versions.source` provenance column; ingest stamps `ingest:<source>:` on its edges and `liveOutEdges` filters to them, so foreign edges (different/`null` source) are never reconciled. (Existing DBs need `ALTER TABLE edge_versions ADD COLUMN source TEXT`.)

`ingest.ts:536-542`. `liveOutEdges` (`ingest.ts:95-110`) selects **every** live out-edge of a managed node; the reconcile closes any `(rel,dst)` not in *this run's* `desired` set, which is computed purely from the file's own links/frontmatter. `edge_versions` (`schema.ts:70-80`) has no provenance/owner column. `Graph.addEdge` is public and exposed via `POST /edges` (`serve.ts:131`).
- **Trigger:** a user/LLM/enrichment process adds an edge from an ingested node; later that node's body or frontmatter changes (so it enters `touched`).
- **Impact:** the foreign edge is closed on the next reconcile. Recoverable via history, but gone from the live graph and all current reads, with no warning.
- **Fix:** stamp provenance (e.g. `props.source = 'ingest:<src>'`) on ingest-authored edges; restrict `liveOutEdges` + the reconcile-close to only edges matching this source's provenance.

### 🔴 Two vaults sharing the default `source` reconcile/prune each other into oblivion
`ingest.ts:261`. `keyPrefix = keyPrefixFor(opts.source ?? 'default')`. `loadLiveMap` selects all `ingest:default:%` nodes and treats every one not discovered in *this* run's directory as a reconcile/prune candidate. The only guard is a doc comment (`types.ts:32-37`).
- **Trigger:** two vaults ingested into one graph, either forgetting a distinct `source`. CLI leaves `source` undefined by default (`cli.ts:29,44`).
- **Impact:** with `prune:true` the second run retracts the entire first vault. Without prune, a same relative-path or `id:` collision overwrites/thrashes across vaults.
- **Fix:** detect and warn when `loadLiveMap`'s discovered set is disjoint from the live map; or require an explicit non-default `source`.

### 🟡 No cross-process / cross-machine ingest lock
`watch.ts:24-25`. The only concurrency guard is an in-process `running`/`pending` boolean inside one `watchDir` closure. `ingestDir` takes no DB advisory lock, no per-source lock row. It reads a point-in-time snapshot (`loadLiveMap`, `liveOutEdges`) then issues non-transactional close/insert writes, asserting it owns all out-edges.
- **Trigger:** local `--watch` + a CI/cron `graphx ingest` on the same Turso DB; or two teammates `--watch`-ing a shared DB.
- **Impact:** each run computes `desired` from its own file snapshot and deletes the other's edges — edge flicker and version churn. Self-heals on the next clean single-writer run; no permanent corruption.
- **Fix:** per-source advisory lock (`pg_advisory_lock` / a lock row) around `ingestDir`; document single-writer-per-source.

### 🟡 Ingested nodes carry no owner/tenant/ACL — authz is project-DB-level only
`schema.ts:48-61`, `authz.ts:48-83`. node_versions has no owner/tenant/acl column and `AddNodeInput` exposes no field to set one. `authorize()` returns only a `dbNamespace`; there is no per-node read filter. `neighbors()`/`listNodes()`/`graphSlice()` apply no access predicate.
- **Trigger:** sources of differing sensitivity (public docs + internal HR, or per-customer folders) ingested into one project graph under the belief that `source`/folder isolates them.
- **Impact:** any reader of the project sees every node/edge from every source. `source` scopes reconcile/prune, **not reads** — it is not a security boundary.
- **Fix:** one project DB (`dbNamespace`) per sensitivity tier; or add a row-level owner column + filtered read path.

---

## 2. Watch + reconcile is destructive on transient or incomplete filesystem states

The reconcile is destructive (it closes edges and, with prune, nodes) and runs against whatever the directory happens to look like at the instant an FS event fires — including mid-save, mid-sync, and mid-checkout. This undermines the bitemporal-truth promise precisely in the live-editing scenario it is meant to serve.

### 🔴 `--prune` flows into watch mode and prunes on every FS event
`cli.ts:141-151`. `prune: args.prune` is spread into both the initial `ingestDir` and `watchDir`, so `--prune --watch` runs the prune block (`ingest.ts:548-561`) on every debounced event. `discoveredIdentity` is built from a single `list()` snapshot with no empty/shrink guard.
- **Trigger:** an editor atomic save (unlink + rename), a Dropbox/iCloud sync, or a git checkout that momentarily hides a file while an event fires.
- **Impact:** the node and **all** its incident edges (including inbound from unchanged files) are retracted; the next event re-creates it as a new node with a new id, severing id continuity. Versions are recoverable via history; live reads lose the node and inbound edges.
- **Fix:** gate watch-prune behind a settle/existence re-check; skip prune when the discovered count drops sharply vs the live map.

### 🟡 Watcher reconcile races a live editor → phantom bitemporal edge churn
`ingest.ts:277,308,506-542`. Files are read one at a time, not as an atomic snapshot. The edge reconcile makes no distinction between "user removed the link" and "link failed to resolve this run."
- **Trigger:** the linking file is in an edit burst (so it is `touched`) while its link target is caught mid-save (partial body → no-kind, or target briefly renamed) in the same run.
- **Impact:** the real edge is closed, then re-added ~200ms later by the trailing run — writing an edge-closed/edge-reopened interval into history that never reflected user intent. As-of queries over that window show a graph that was never true.
- **Fix:** treat a resolution *failure* (missing/ambiguous target, or resolved-but-no-node) differently from an intentional unlink — skip the destructive close, or require a confirming run before closing.

### 🟡 Deleted files leak nodes and stale edges forever when prune is off (the default)
`ingest.ts:548`. All deletion is gated behind `if (opts.prune)`, default false. The watcher receives unlink events (`watch.ts:60`) but has no delete handling of its own; a removed file is never in `touched`, so its outbound edges are never closed and inbound edges are only revisited if the linking file itself changes.
- **Impact:** orphan node + edges persist indefinitely, polluting retrieval/traversal. `IngestResult` has no field signaling observed-but-ignored deletes, so the operator gets no drift signal.
- **Fix:** surface a drift warning/count when discovered identities < live entries; or document that `--watch` needs `--prune` to track deletions.

### 🟡 No whole-run transaction — a crash mid-run leaves a half-reconciled graph
`ingest.ts:365-404,505-561`. Each `addNode`/`updateNode`/`addEdge`/`deleteEdge` is its own transaction; `ingestDir` wraps nothing. The drift path does `deleteEdge` then a separate `addEdge` (`ingest.ts:522-531`).
- **Trigger:** process killed (deploy restart, OOM, SIGTERM) between an edge delete and its re-add.
- **Impact:** old edge gone, new edge absent. **Does not self-heal** — on re-run the hash-unchanged node never re-enters `touched`, so the missing edge stays missing until the file body changes.
- **Fix:** order each edge swap add-then-delete, or expose a batch/transaction seam so a file's reconcile commits atomically.

### 🟡 CLI watch handles only SIGINT, not SIGTERM
`cli.ts:154-159`. Only `process.once('SIGINT', …)` is registered. SIGTERM (systemd/Docker/k8s/`kill`) terminates abruptly. (Note: the deeper issue is run-level atomicity above — `watcher.close()` on a dying process is cosmetic, and the partial-reconcile bug fires on SIGINT and crash too.)
- **Fix:** run-level atomicity or idempotent edge self-heal (re-reconcile edges for hash-unchanged nodes / a checkpoint), not just a SIGTERM handler.

### 🟢 TOCTOU: a file deleted/renamed between `list()` and `read()` aborts the whole run
`ingest.ts:275,307-308`. `list()` snapshots once; the per-key `read()` has no try/catch (unlike node/edge writes). An ENOENT rejects the whole `ingestDir` promise. Because all reads are in Step 1 (a pure parse pass, zero DB writes), the abort happens *before* any write — the graph stays consistent-but-stale, not half-written. In watch mode it self-heals on the next FS event; in CLI a re-run is idempotent via hashes.
- **Fix:** wrap `read()` in try/catch and push a skip entry, mirroring `nodeErrorSkip`/`edgeErrorSkip`.

### 🟢 Partial read of a file mid-write is hashed and stored as a complete version
`parse.ts:12-24`. `parseFile` hashes whatever bytes `readFile` returned, with no completeness check. A non-atomic in-place write read mid-flight yields truncated content that still parses, gets a node version + a wrong embedding. The trailing watch run usually re-reads the complete file and corrects the **live** version; what persists is a spurious corrupt version in temporal history (and a transient wrong embedding) — except when the partial read is the last event with no follow-on.
- **Fix:** re-read on mtime/size change, or require temp+rename in the read layer.

---

## 3. Silent failure everywhere — "broken" is indistinguishable from "success"

The library captures rich structured skip data, but the failure surfaces (CLI exit code, watch callbacks) collapse it to a count or swallow it entirely. Several total-failure modes exit 0.

### 🔴 One embed() failure aborts the whole run and writes zero nodes
`ingest.ts:359-363,580-590`. The `mapWithConcurrency` worker does `results[i] = await fn(...)` with no try/catch; one rejected `embed()` rejects the `Promise.all`, so `ingestDir` throws **before** the node-write loop. This is asymmetric with node/edge writes, which record a `SkipEntry` and continue.
- **Trigger:** a transient 429 / timeout / one oversized body in a 500-file batch.
- **Impact:** all 500 files' writes are discarded for that run. Under `watchDir` the throw goes to `onError` (default `console.error`); no partial result, no retry until an unrelated FS event fires.
- **Fix:** wrap each embed in try/catch inside the map fn, returning `undefined` + an `embedErrorSkip`, so one bad file degrades to a no-embedding node.

### 🔴 CLI default `dim=4` + a real embedder → entire vault silently rejected, exit 0
> ✅ **Fixed** on `fix/ingest-top3-risks` — the CLI now throws if `dim` is unset (no silent default), prints a `code=count` skip breakdown, and sets `exitCode=1` when nothing was written but files were skipped.

`cli.ts:132`. `init(client, cfg.dim ?? 4)` defaults to 4 while the ingest README uses 768. The libSQL ANN index `nv_emb_idx` enforces dimension at insert; a real (e.g. 768/1536-dim) vector throws `dimensions are different`, which is caught into `result.skipped` (a `node-error`). `printSummary` prints `added=0 … skipped=N` and `run()` exits 0.
- **Impact:** 100% of nodes rejected, looks like a successful no-op; the graph stays empty with no signal that `dim` is the cause.
- **Fix:** drop the bogus default (require `dim`, or derive it from one `embed()` call); validate the first vector length against the column dim; exit nonzero + print skip codes when `added=0 && skipped>0`.

### 🟡 `result.skipped` hides systemic rejection of an entire vault behind exit 0
> ✅ **Fixed** on `fix/ingest-top3-risks` — `printSummary` now prints a per-code skip breakdown and `run()` exits nonzero on systemic failure (see the dim finding above).

`cli.ts:68-74`. `printSummary` prints only `skipped=${skipped.length}`; the structured `{key,stage,code,reason,detail}` (Zod issues, ambiguous-link candidates) is discarded. `run()` never inspects `result.skipped`; the only nonzero exits are unknown-command (2) and a thrown top-level error (1).
- **Impact:** a schema typo / wrong kind / dim mismatch that rejects every file is indistinguishable from success in CI and scripts.
- **Fix:** exit nonzero when `result.skipped` is non-empty (or add `--strict` / a threshold) and print codes/reasons.

### 🟡 Re-init with a corrected dim is a silent no-op — DB stuck at the first dim forever
`schema.ts:43-126`. The dim is baked into `F32_BLOB(<dim>)` once; every `CREATE` is `IF NOT EXISTS` and `init()` re-runs as a pure no-op. There is no `PRAGMA user_version`, no schema/dim versioning, no migration. `getDb` reuses `file:<namespace>.db`.
- **Trigger:** user hits the `dim=4` footgun, sets `dim:768`, re-runs.
- **Impact:** the fix does nothing; the column + ANN index stay at 4, inserts keep failing. Only recovery is deleting the `.db` file, undocumented.
- **Fix:** a dim/schema version check at init that throws a clear "DB built at dim=X, config says Y" error.

### 🟡 Duplicate frontmatter `id` across two files silently drops the second
`ingest.ts:319-328`. Two files with the same `id` collapse to one `id:<value>` identity; the lexicographically-later path becomes a `duplicate-identity` skip and is never written. The winner is pure sort order, not recency.
- **Trigger:** a copy-pasted template that kept its `id`, or a `… (conflicted copy).md` from a sync tool.
- **Impact:** a whole note silently excluded; only a count surfaced at the CLI.
- **Fix:** surface duplicate-identity skips by name (both colliding keys); or make collision policy explicit.

---

## 4. Embedding lifecycle has no identity

### 🔴 Embedding model/dim swap silently keeps stale vectors (no re-embed)
> ✅ **Fixed** on `fix/ingest-top3-risks` — added an opt-in `embedId` ingest option folded into the stored `embed_hash` (`sha256(embedId\0sha256(body))`); both the unchanged short-circuit and the re-embed gate key on it, so changing `embedId` re-embeds every node even on byte-identical bodies. Unset = unchanged legacy behavior.

`parse.ts:21`. `embed_hash = sha256(body)` only — no model id, version, or dim is mixed in. The re-embed gate is purely `prior.embedHash !== file.embedHash`, and an unchanged file short-circuits to `unchanged` before even reaching it (`ingest.ts:331`). The node schema carries no model identity; there is no re-embed/backfill path anywhere.
- **Trigger:** swap the `embed` function (better/cheaper model) and re-run. Output reports `unchanged=N`.
- **Impact:** queries embedded by model B are compared against document vectors from model A — silently meaningless cosine distances; retrieval quality collapses with zero error. A same-dimension swap is 100% silent; a different-dim swap at least fails loudly on new/edited nodes. The `embed_hash` optimization actively hides this.
- **Fix:** mix an embedder fingerprint (model id + dim) into `embed_hash`, or persist a corpus-level embedding identity and warn/backfill on mismatch. The temporal layer was designed (§19.9) to support re-embedding as a derived-data write — only the detection trigger is missing.

---

## 5. Full-corpus-per-run cost model — fine at 1k files, cliff at 50k+

Every run re-reads, re-hashes, and full-scans, regardless of how few files changed. Costs that are invisible on a personal vault dominate at scale, and some grow with history forever.

### 🟡 `loadLiveMap` does an unindexed scan of all node versions every run
`ingest.ts:122-141`. `SELECT … FROM nodes WHERE uri LIKE 'ingest:<source>:%'` resolves to `node_versions WHERE valid_to = FOREVER AND uri LIKE ?`. There is **no index on `uri`** and none on `valid_to` alone (indexes are `nv_asof(id,valid_from,valid_to)`, `nv_kind`, FTS, partial vector). History is never deleted, so the scan widens with total edit history, and it runs unconditionally even on a one-file change.
- **Fix:** one `CREATE INDEX` on `node_versions(uri)` (or partial `WHERE valid_to = FOREVER`). (Note: the same run also full-reads every file — see below — so this is not the sole per-run cost, but it is the one that grows with unbounded history.)

### 🟡 Every file is re-read and re-hashed on every run
`ingest.ts:307-308`. Change detection compares `sha256(raw)`, so bytes must be read to detect a change; there is no mtime/size pre-filter. The watch callback discards `_filename` and runs the full `ingestDir`, so editing one note re-reads and re-hashes the entire vault.
- **Impact:** per-edit cost in watch mode is O(corpus bytes), not O(changed bytes). At tens of thousands of files each save triggers seconds-to-tens-of-seconds of full re-read.
- **Fix:** a stat-based mtime/size pre-filter to skip unchanged files before reading.

### 🟡 Whole changed-file working set held in memory — no streaming ceiling
`ingest.ts:284-356`. `workItems`/`touched` retain the full `ParsedFile` (both `raw` **and** `body`) for every new/changed file; `embedInputs`/`embeddings` are full-length index-aligned arrays. A first ingest = every file is new, so the entire corpus body set + all vectors are resident at once.
- **Impact:** peak heap is O(changed-corpus bytes); a multi-GB vault OOMs on the "point it at my knowledge base" first import. `file.raw` is dead weight — never read after the hash at `parse.ts:20`.
- **Fix:** drop `raw` from `ParsedFile` after hashing (cheap ~1× win); chunk the parse→embed→write→edge pipeline so bodies/vectors can GC.

### 🟡 Per-file edge reconcile issues one serial round-trip per edge, no batching
`ingest.ts:432-543`. One `liveOutEdges` SELECT per file, then a separate awaited `addEdge`/`deleteEdge` round-trip per added/drifted/closed edge, strictly sequential. A drifted edge is delete+insert (two ops). The `hasDrifted` raw-vs-schema-parsed-props false-positive is acknowledged in-code (`ingest.ts:239-243`) and re-churns edges every run.
- **Impact:** write throughput is one-edge-per-round-trip; on a remote DB a corpus that embeds in minutes can take hours to persist edges, and steady-state runs may re-churn unchanged edges indefinitely.
- **Fix:** batch adds/deletes into multi-row statements and/or bounded write concurrency; fix the drift comparison so steady-state runs stop re-churning.

---

## 6. Untrusted-vault trust boundary is unguarded

Safe for a personal vault. A hole for any vault that is shared, synced, contributor-writable, or multi-tenant.

### 🔴 Symlink in the vault escapes root — arbitrary host file read into node body + sent to embed provider
`discover.ts:10-15`, `source.ts:20-23`. `readdir(dir,{recursive:true})` follows symlinks (no `lstat`/`isSymbolicLink` filter) and `readFile(join(dir,key))` dereferences the target. No realpath containment check. Reproduced: `hosts.md -> /etc/hosts` and `link.md -> ../secret.md` are both discovered and read verbatim.
- **Trigger:** any not-fully-trusted vault — a synced shared drive, a contributor PR, an export, or an attacker who can write one symlink.
- **Impact:** arbitrary local file contents become a node body, stored in the DB **and shipped to the external `embed()` provider**. Silent exfiltration across the trust boundary.
- **Fix:** `realpath` the joined path in `fsSource.read` and reject if not under `realpath(dir)`.

### 🟡 `__proto__` / `constructor` frontmatter keys: silent prop loss + prototype manipulation
`ingest.ts:181-192`. js-yaml exposes `__proto__` as an own enumerable key; `toProps` does `out[k]=v`, so `k === '__proto__'` reassigns `out`'s prototype. Reproduced end-to-end with the project's own `.passthrough()` schema: `__proto__:{isAdmin:true}` makes zod promote an inherited `isAdmin` into stored props; `constructor:` round-trips as a stored own property. Global `Object.prototype` is not polluted (confined to the `out` object).
- **Fix:** build with `Object.create(null)` and skip `__proto__`/`constructor`/`prototype` in `toProps`.

### 🟡 embed() is handed the raw body with no size cap
`ingest.ts:349-363`. `embedInputs` maps `file.body` straight into `opts.embed(input.body)` with no length limit or truncation; the only bound is concurrency (default 8), which caps parallelism, not payload.
- **Impact:** unbounded body size to a paid external API — token-cost blowup and provider rejects (which, per §3, abort the whole run). Combined with the symlink finding, host file contents are shipped to the provider.
- **Fix:** a max-body-bytes guard (truncate or skip-with-SkipEntry) before `opts.embed`.

### 🟢 Asset path traversal: `../` in an embed escapes the vault namespace
`ingest.ts:491-495`. `join(dirname(file.key), emb.target)` with no normalization/containment when `opts.assets` is enabled. Reproduced: `![](../../../etc/passwd)` yields an asset URI/`props.path` with the escaping path. Today the minted URI still begins with `keyPrefix`, so reconcile/prune reasoning stays defined and the only effect is graph pollution — but it becomes a file-read primitive if the blob layer later resolves `props.path` from disk.
- **Fix:** normalize and contain `assetPath` (reject `..`/absolute) before `ensureAsset`.

---

## Cross-cutting data-model footguns

These don't fit a single theme but are real and verified.

### 🟡 A wikilink to a no-kind / duplicate-identity / schema-rejected file silently drops the edge
`ingest.ts:447-448` (and `475-476`). `buildPathIndex` indexes every discovered file, including ones later skipped; `resolveLink` returns `resolved` but `keyToId.get(r.key)` is undefined, so the edge is dropped with **no skip entry**. Contrast: a link to a genuinely missing file *does* emit `unresolved-link`. The present-but-skipped target is the untested asymmetric gap.
- **Fix:** when `dst` is undefined for a resolved target, push a `link`-stage skip so the incomplete graph is diagnosable.

### 🟡 gray-matter/YAML coerces dates and ambiguous scalars before they reach props
`ingest.ts:181-192`. `toProps` copies frontmatter verbatim with no normalization. js-yaml coerces `due: 2024-01-15` → a JS `Date`, `version: 1.10` → `1.1`, `id_code: 007` → `7`. For a permissive/`passthrough`/`z.record` kind (the repo's canonical schema is `.passthrough()`) these are stored as-is; the hash is over raw bytes, so the queryable value silently diverges from the source text. (Strict per-kind schemas with `z.string`/`z.coerce` neutralize it. `zip: 02139` stays the string `"02139"` — octal coercion needs all-octal digits like `0755`→493.)
- **Fix:** normalize frontmatter in `toProps`, or require strict per-kind schemas for identifier/date fields.

### 🟡 Path-identity (`file:<path>`) rename is a delete+re-add that orphans history and inbound edges
`ingest.ts:77-80`. With no `idField`, a rename gives a new identity key; the old node is abandoned (prune off — the default) and stays live as a duplicate, while inbound edges from unchanged files keep pointing at the orphan. The `id:` path is rename-stable; the default `file:` path is not.
- **Fix:** derive a stable id (content-hash or birth-inode) for the default identity; or detect a vanished `file:` identity whose content hash matches a new one and treat it as a rename.

### 🟡 NaN frontmatter edge weight causes unbounded edge-version churn (Postgres only)
`ingest.ts:215`. `normalizeFmValue` accepts any `typeof obj.weight === 'number'`, and YAML `.nan` parses to JS `NaN`. `hasDrifted` then computes `NaN !== live.weight`, always true → delete+re-add every run. **libSQL rejects NaN at bind time**, so the edge is simply skipped (no churn); on Postgres the float column accepts `NaN`, `NaN >= 0` passes the CHECK, and churn is real.
- **Fix:** `Number.isFinite(obj.weight)` at the boundary — closes it on both backends.

### 🟢 `deleteNode` leaves dangling inbound edge rows
`graph.ts:778-808`. `deleteNode` deliberately does not cascade-close incident edges; only ingest's prune path pre-closes them. A direct SDK `graph.deleteNode(id)` leaves orphan still-live edge rows. **Not** a phantom-read bug — every read path (`neighbors`, `graphSlice`, `retrieve`, `hybrid`) inner-joins edges to live nodes, so dangling edges are dropped from results; FKs reference `node_identity`, which is untouched.
- **Fix:** cascade-close incident edges in `deleteNode`, or surface the requirement in the API/types.

### 🟢 Config import + libSQL DB path are CWD/location-sensitive
`db.ts:82-87`, `cli.ts:121-124`. `getDb` builds `url: file:${namespace}.db` relative to `process.cwd()`; there is no absolute-path flag for libSQL. Running the CLI from a different directory creates/opens a fresh empty DB. The config is imported as a real module (top-level side effects run every invocation) with no validation that `default` has `schema`/`embed`. Existing data is never destroyed — it's "not found," not lost.
- **Fix:** add an absolute libSQL file-path field (or `--db` flag) resolved against the config dir, not CWD; add a runtime guard on the config's default export.

---

## 7. Investigated and dismissed

Three claims did not survive re-verification — recorded so they aren't re-raised:

- **`liveIncidentEdges` "`src=? OR dst=?` defeats indexes"** — **false.** `EXPLAIN QUERY PLAN` shows `MULTI-INDEX OR` using both `ev_src_asof` and `ev_dst_asof` through the view (SQLite has had this optimization since ~3.7). Per-node cost is bounded by node degree; no full scan.
- **Same-folder wikilink disambiguation case-sensitivity** — **false (inert).** The dir tiebreak compares two members of the same `readdir`-derived `keys` array (always consistent casing); link-target casing never feeds it. The trigger requires two folders differing only in case, impossible on the case-insensitive FS it targets.
- **"1 file = 1 node" hard ceiling** — **already documented.** `README.md:3` leads with it; the design spec names it a consciously resolved fork. Not a hidden assumption.

---

## Priority shortlist

The highest-leverage trio — each is a default/common-path silent failure with a small, localized fix:

1. **Edge provenance** (`§1`) — stamp + scope ingest-authored edges so reconcile stops deleting foreign edges. Unblocks safely mixing ingest with the admin UI / enrichment.
2. **`embed_hash` fingerprint** (`§4`) — mix model id + dim into the hash so a model swap isn't a silent retrieval-quality collapse.
3. **`dim` default + skip surfacing** (`§3`) — default `dim` to 768 (or require it), validate the first vector, and exit nonzero + print skip codes when `added=0 && skipped>0`, so a misconfig stops reading as a green run.

Then, by blast radius: watch-prune settle guard (`§2`), `node_versions(uri)` index (`§5`), and symlink containment (`§6`).
