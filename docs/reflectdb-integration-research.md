# reflectdb → graphx: research and integration design

> Research date 2026-08-21. Sources read: `../reflectdb` @ v0.1.3 (all of `src/`, ~14.6k LOC, plus
> the 82KB README), and graphx `main` @ `217233f`. Both repos are MIT and share an author, so code
> lift is a licensing non-issue — the question is purely architectural fit.

---

## 1. What reflectdb is

A **real-time sync engine for mutable SQL rows**. A server owns the database; browser clients hold a
local mirror and write optimistically. Every client write becomes an **op** (`insert`/`update`/`delete`
on one row), stamped with a **hybrid logical clock**, queued in a client-side op log, and shipped to
the server. The server validates it (auth, shape, readonly columns, rate limit, clock drift, replay),
resolves it against the current row under a declared **conflict policy**, persists through a
user-supplied `mutate` callback, and fans the result out to every other subscriber as a delta.

The design center is: _your database stays authoritative; reflectdb is the transport plus the
conflict-resolution and delivery discipline around it_. It has no opinion on your ORM, your row
types, or your HTTP server.

### Architecture in one pass

```
   BROWSER                          SERVER                        YOUR DB
┌───────────────┐            ┌──────────────────────┐          ┌──────────┐
│ ClientStore   │  ops (HLC) │ handler.ts           │  mutate  │          │
│  rows +       │───────────▶│  ├ message-validator │─────────▶│  rows    │
│  pendingOps   │            │  ├ enforcement       │          │          │
│  (IndexedDB)  │◀───────────│  ├ replay-detector   │◀─────────│          │
│               │   deltas   │  ├ conflict          │  query   └──────────┘
│ optimistic    │            │  ├ op-processor      │
│  overlay      │            │  ├ op log (sqlite/pg)│          ┌──────────┐
└───────────────┘            │  ├ result-cache      │          │ ephemeral│
       ▲                     │  └ broadcast-engine  │◀────────▶│ (redis)  │
       │ WS / SSE / poll     └──────────────────────┘          └──────────┘
       └──────────────────── transports (framework-agnostic) ────────────┘
```

Key mechanisms, each of which is a self-contained idea worth stealing:

| Mechanism             | File                                             | What it does                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **HLC**               | `core/hlc.ts` (78 LOC)                           | `{ms, counter, nodeId}` packed to a lexicographically sortable `0000…ms.0000counter.node` string. Counter overflow rolls `ms` forward so padded string order never breaks under batch inserts. Receive-side clamps remote `ms` to `now + MAX_CLOCK_DRIFT_MS`.                              |
| **Conflict policies** | `server/conflict.ts` (266 LOC)                   | `lww` (row-level HLC compare), `merge` (per-**column** HLC compare — two clients editing different fields both land), `server` (first write wins, reject the rest), `custom` (a resolver fn). Distinguishes `merge_stale` (all columns lost; a no-op, don't retry) from `server_conflict`. |
| **Shapes**            | `server/types.ts` `QueryOptions`                 | A named query = the per-user filtered subset a client may see and write. Plus `serverSet` (server always overwrites these columns), `readonly` (settable on insert, frozen on update), `room` (a params pattern like `org/:orgId` a subscription must resolve).                            |
| **Result-cache diff** | `server/result-cache.ts` + `broadcast-engine.ts` | On a write, re-execute each subscriber's query and diff against the last result set sent to that client → `{inserted, updated, deleted}`. Subscribers collapse into **groups** by a `groupBy` key so one write costs one execution per group, not per client.                              |
| **Op log + resume**   | `server/storage/{sqlite,postgres}.ts`            | Durable, totally-ordered op log. A reconnecting client sends `resume { since }` and gets everything after its watermark; if the watermark predates compaction it gets `resume_rejected` → full snapshot.                                                                                   |
| **Ephemeral channel** | `server/ephemeral/*`                             | Presence, cursors, typing. Never touches the op log. Room snapshot on join, TTL expiry, pluggable adapter (Redis included) so presence spans a fleet. Separately rate-metered from writes, because each message fans out to every room subscriber.                                         |
| **Eager broadcast**   | `server/eager-buffer.ts`                         | Opt out of conflict resolution for latency: `eager-durable` (persist atomically, then broadcast) and `eager` (broadcast now, batch-persist later, at-most-once across a crash). Documented honestly as a footgun.                                                                          |
| **Transports**        | `transport/{ws,sse,polling}.ts`                  | Framework-agnostic. SSE returns a bare `ReadableStream` + `handleMessage`, so it wires to Hono in a few lines. Per-client replay buffer for `Last-Event-ID`.                                                                                                                               |
| **Typed schema**      | `core/schema.ts`                                 | `defineSyncQueries` + `t<Row>()` phantom types. Derives `InferWritableRow` = row minus `readonly` minus `serverSet` minus the pk, so `insert(id, {...})` is typed to exactly what a client may set. `view()` and `presence()` entries collapse to `never` at the write site.               |

Two details worth calling out because they are the kind of thing you only learn by shipping:

- `TransportSendError` exists because _a transport that swallows send failures corrupts the server's
  model of the client_. The broadcast engine commits the per-client result cache only after `send`
  resolves; a silently-dropped frame makes the server believe a client holds rows it never got.
- The broadcast engine takes a **per-(client, query) lock**. Two concurrent writers would otherwise
  both diff against the same stale cache, both send, both commit — and any row only the loser knew
  about never gets its delete emitted. A phantom row until reconnect.

---

## 2. Capability inventory: reflectdb vs graphx today

| Capability                                  | reflectdb                                                  | graphx today                                                                                   | Gap                                                             |
| ------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Durable, totally-ordered change log         | op log (sqlite/pg)                                         | **`graph_outbox` + `outboxTail`, `seq`-ordered, co-written in the mutation's own transaction** | ✅ already have, arguably better (transactional with the write) |
| Server → client push                        | WS / SSE / long-poll                                       | **SSE `/events`, resume by `seq`, backoff reconnect**                                          | partial: one transport, no WS/poll                              |
| Client cache invalidation                   | row deltas                                                 | React Query key invalidation (`useGraphEvents`)                                                | different model — graphx invalidates, then refetches            |
| Optimistic local writes                     | ✅ full op log + rollback via `preState`                   | ❌ none                                                                                        | **missing**                                                     |
| Offline / durable local mirror              | ✅ IndexedDB adapter                                       | ❌ none                                                                                        | **missing**                                                     |
| Causal ordering across clients              | ✅ HLC                                                     | process-local monotonic `now()` (`graph.ts:484`) — Lamport-ish, single-writer                  | **missing** the distributed half                                |
| Conflict resolution                         | ✅ 4 policies, per-column clocks                           | implicit LWW: `updateNode` shallow-merges against the _live_ version                           | **missing** stale-write detection                               |
| Per-user data shape                         | query + `filter`/`room`                                    | `graphSlice` / `neighbors` + `graphx/auth` ReBAC `check`                                       | ✅ have the primitives, ❌ not wired to a subscription          |
| `serverSet` / `readonly` field policy       | ✅ typed + enforced                                        | ❌                                                                                             | **missing**                                                     |
| Write rate limiting                         | ✅ global + per-table, fail-open                           | ❌                                                                                             | **missing**                                                     |
| Replay / idempotency on writes              | ✅ `replay-detector`, `reserveOpId`                        | ❌ no idempotency key on REST writes                                                           | **missing**                                                     |
| Presence / ephemeral                        | ✅ typed, TTL, Redis fanout                                | ❌                                                                                             | **missing**                                                     |
| Batch writes with a batch id                | ✅ `batchId`/`batchSize`/`batchSeq`, all-or-nothing reject | `bulkLoad` (server-side, not an op batch)                                                      | partial                                                         |
| Windowed subscription + `loadMore`          | ✅                                                         | `neighborsPage`, `listNodes` cursors — but not live                                            | partial                                                         |
| Auto REST from schema                       | ✅ `server.rest()`                                         | ✅ `serve.ts` + OpenAPI + `/docs`                                                              | ✅ graphx is ahead                                              |
| Time travel / history                       | ❌ (op log is retention-bounded, not queryable history)    | ✅ **bitemporal `valid_from`/`valid_to`, `asOf`, `history`, `diff`**                           | ✅ graphx is far ahead                                          |
| Vector / FTS / hybrid retrieval, algorithms | ❌                                                         | ✅                                                                                             | ✅ graphx only                                                  |

**Summary:** graphx already owns the durable half of what reflectdb's server does — and owns it more
strongly, because the outbox commits in the same transaction as the version rows. What graphx has
none of is **the client half**: optimistic writes, a local mirror, an offline queue, and per-client
delta delivery. That is where the real value is.

---

## 3. The three structural mismatches

Do not port reflectdb wholesale. Three places where its model does not survive contact with graphx.

### 3.1 Mutable rows vs append-only bitemporal versions

reflectdb resolves a conflict by **overwriting a row**. The losing write is gone; only the winner
exists. graphx never overwrites — `updateNode` closes the live version (`valid_to = T`) and opens a
new one.

This is not a problem. It is the single best thing about the fit:

> Applying reflectdb's conflict resolution on top of graphx's store gives you **conflict resolution
> with a full audit trail of what lost**. Every rejected-and-superseded branch is still a version row
> with its own `[valid_from, valid_to)`. No sync engine in this space can answer "what did the other
> client try to write, and when did it lose?" — graphx can, for free.

There is a real gap to close though. graphx's `updateNode` shallow-merges against the **live**
version at write time, not against the version the client read. So:

- Two clients editing **different** fields: both survive today, as long as writes serialize at the
  server. graphx's shallow merge is already ~reflectdb's `merge` policy.
- Two clients editing the **same** field: the later arrival blindly wins, even if it was authored
  against a version from ten minutes ago. graphx cannot detect this — there are no per-field clocks.

The fix is small and lands naturally: add a `col_clocks` JSON column to `node_versions` holding
`{field → packed HLC}`, and port `resolveMerge` verbatim. Because versions are append-only, the
clocks are versioned for free — no migration of history, no separate mirror table. Note that this is
strictly better than reflectdb's own arrangement, where conflicts resolve against _reflectdb's mirror_
rather than your database, and the two silently diverge if anything writes out of band (a caveat its
own `QueryOptions.conflict` docblock spells out at length). graphx has no mirror. The store _is_ the
truth.

### 3.2 Tables vs graphs — what is a "shape"?

reflectdb's unit of subscription is a **named query over one table**, and its shape is a filter
predicate plus a room key. graphx has no tables in that sense; it has a typed graph, and the
interesting subscriptions are traversals: _the subgraph within 2 hops of node X_, _everything I have
`viewer` on_, _the results of this pattern match_.

So a graphx subscription shape is a **rooted, bounded subgraph**, not a `WHERE` clause. Concretely
the declaration wants to be something like:

```ts
defineSyncShapes({
	workspace: {
		root: (p: { workspaceId: string }) => p.workspaceId,
		rels: ['contains', 'assignedTo'],
		depth: 2,
		// the ReBAC relation the subject must hold on the root; graphx/auth answers it
		require: 'viewer',
		conflict: 'merge',
		serverSet: ['updatedAt', 'updatedBy'],
		readonly: ['createdAt', 'ownerId'],
	},
});
```

This is where graphx pulls decisively ahead of reflectdb rather than merely catching up.
reflectdb's `room` is a string pattern match on params; graphx's equivalent is a **reachability check
in the same store as the data**, bitemporal, so `check(..., { asOf })` answers "was this client
entitled to that row at the time it received it?" — which matters when you are replaying an op log
after a permission change. `graphx/auth` already implements exactly this.

### 3.3 Per-client query re-execution does not survive graph queries

reflectdb's broadcast engine, on every write, **re-executes each subscriber group's query and diffs
the result set**. That is fine for `SELECT * FROM todos WHERE org_id = ?`. It is catastrophic for
`retrieve`, `pagerank`, `community`, or a 3-hop `graphSlice`. A single node write would trigger a
PageRank per subscriber group.

graphx must invert the flow. It already has the ingredient reflectdb lacks: **the outbox event
carries the mutated `id`, `label`, `src`, `dst`, and `shape`**. So instead of re-execute-and-diff:

1. Read the event.
2. Decide, cheaply, **which subscriptions could possibly be affected** — is the touched id inside a
   subscriber's materialized slice, or adjacent to it via a subscribed rel?
3. For the affected ones only, send a targeted delta (the changed node/edge), and re-run the traversal
   **only when the event could change slice membership** (an edge insert/delete on a boundary node).

This means graphx keeps a **per-client materialized membership set** (`Set<nodeId>` + `Set<edgeId>`),
which is the graph analogue of reflectdb's `ResultCache`. The diff is set difference on membership
plus per-node data deltas — cheap. Retrieval/algorithm queries are explicitly **not** live-subscribable
in v1; they stay pull-based React Query hooks. Say so in the docs rather than letting someone find out
with a production incident.

The per-(client, query) lock from `broadcast-engine.ts` transfers verbatim and is load-bearing for the
same reason.

---

## 4. The seam: what graphx already has

Before writing anything, note how much of the server half is done:

| reflectdb piece                        | graphx equivalent                          | Status                    |
| -------------------------------------- | ------------------------------------------ | ------------------------- |
| Server op log                          | `graph_outbox`, `outboxTail`, `outboxHead` | ✅ better (transactional) |
| Total order                            | `seq`                                      | ✅                        |
| Resume watermark                       | SSE `id: <seq>` + `?cursor=`               | ✅                        |
| `notifyChange`                         | `GraphEventSink` / `GraphEventBus`         | ✅                        |
| Server-origin writes into the pipeline | `Graph.withEventSource` + triggers         | ✅                        |
| Auth callback                          | `authz.ts` (L1) + `graphx/auth` (L2)       | ✅ stronger               |
| Multi-tenant scoping                   | `scopeEvents`, `/t/:tenant/p/:project`     | ✅                        |
| Transactional write group              | `Graph.write(fn)` (DuckDB snapshot commit) | partial                   |

What is genuinely absent server-side: shapes, per-client membership + diff, `serverSet`/`readonly`
enforcement, rate limiting, replay detection, ephemeral, and the op-batch ingress endpoint.

---

## 5. Options

> **Revised 2026-08-21, after checking the extension surface.** The first pass of this doc rejected
> Option A on the grounds that a graph subscription "means fighting it on every axis". That is wrong,
> and the correction matters enough to state plainly: reflectdb's `query`/`mutate`/`room`/`groupBy`
> callbacks are arbitrary user code with a caller-supplied `db` handle. A `Graph` **is** a legal `db`.
> Every piece of the fit below type-checks conceptually against the real signatures in
> `server/typed-server.ts` and `server/rooms.ts`. Option A is now the recommended starting point.

**Option A — depend on `reflectdb` as a library. ← recommended, start here.**

Published as `reflectdb@0.1.3`. The whole integration is an adapter of a few hundred lines (§5.1).
graphx stays authoritative; reflectdb is the **pipe** — transport, client store, optimistic overlay,
offline queue, resume, presence, rate limiting. You get phases 1–3 of §8 nearly for free.

**Option B — port the ideas into `graphx` directly.** Still rejected. `core` is already 13.6k
LOC and `serve.ts`/`graph.ts` are its two largest files. Sync brings client-side storage, transports,
and a protocol surface — none of which belong on the import path of someone who just wants
`Graph` + `retrieve`. It would also breach the optional-peer discipline `followups.md` F3 protects.

**Option C — a bespoke `graphx-sync`, lifting reflectdb's mechanisms and re-rooting them on the
outbox.** Still the right _destination_, but it is not the right _starting point_. Build it when one
of the four ceilings in §5.2 is actually hit, not before — and by then Option A will have taught you
which parts of the protocol you actually use.

### 5.1 The adapter, concretely

Two reflectdb queries (`nodes`, `edges`) plus a presence channel. `db` is the `Graph`.

```ts
import { createSyncServer } from 'reflectdb/server';
import { defineSyncQueries, presence, t } from 'reflectdb/core';
import type { Graph } from 'graphx';

export const queries = defineSyncQueries({
	nodes: {
		row: t<{ id: string; type: string; data: Record<string, unknown>; body?: string }>(),
		params: t<{ workspaceId: string }>(),
		readonly: ['type'], // settable on insert, frozen on update
		serverSet: ['updatedAt'], // client can never write this
	},
	edges: {
		row: t<{ id: string; rel: string; src: string; dst: string; weight?: number }>(),
		params: t<{ workspaceId: string }>(),
	},
	cursors: presence<{ x: number; y: number; nodeId?: string }, { workspaceId: string }>({
		ttlMs: 30_000,
	}),
});

const server = createSyncServer({ queries, transport, db: graph });

// ReBAC gate. Rooms fail closed (see rooms.ts `resolveRoomKey`), so a subscription
// that half-addresses the pattern is rejected rather than silently widened.
server.room('workspace/:workspaceId', async ({ params, auth }) => ({
	ok: await rebac.check({
		subject: `user:${auth.userId}`,
		relation: 'viewer',
		object: `workspace:${params.workspaceId}`,
	}),
}));

server.implement('nodes', {
	room: 'workspace/:workspaceId',
	groupBy: ({ params }) => params.workspaceId, // one query execution per workspace, not per client
	broadcast: 'eager-durable', // graphx resolves conflicts; skip reflectdb's mirror
	query: async ({ params }, g: Graph) =>
		(await g.graphSlice({ root: params.workspaceId, rels: ['contains'], depth: 2 })).nodes,
	mutate: async (op, _ctx, g: Graph) => {
		if (op.type === 'delete') await g.deleteNode(op.rowId);
		else if (op.type === 'insert')
			await g.addNode({ id: op.rowId, type: op.payload!.type, data: op.payload!.data });
		else await g.updateNode(op.rowId, { data: op.payload!.data });
	},
	serverSet: { updatedAt: () => Date.now() },
});

// graphx's outbox drives reflectdb's change detection.
for await (const ev of tailOutbox(raw)) {
	await server.notifyChange(ev.entity === 'node' ? 'nodes' : 'edges', roomKeyFor(ev));
}
```

That is the entire seam. `graphx` needs exactly one change to make it work: **client-supplied
ids** (§6.5 item 1) — `graph.ts:499` mints a ULID unconditionally, and `insert(rowId, payload)`
requires the client to name the row it just rendered. That change is required under _every_ option.

### 5.2 What Option A actually costs

Four ceilings. None is a blocker today; each is the thing that eventually justifies Option C.

1. **No per-column merge.** `eager-durable` skips conflict resolution, so writes land LWW. That is
   the right call — the alternative (`consistent` + a custom resolver) resolves against reflectdb's
   **mirror**, which drifts from graphx the moment `mutate` transforms the payload, and graphx's
   `mutate` always does (Zod parse, `_v` stamping, close-and-insert versioning). The mirror-divergence
   caveat in reflectdb's own `QueryOptions.conflict` docblock is precisely this hazard.
   **What you actually lose** is narrower than it sounds: graphx's `updateNode` already shallow-merges
   against the live version, so two clients editing _different_ fields both land regardless. Only
   _stale same-field_ rejection is unavailable. It also forfeits, for now, the version-branch audit
   trail from §3.1 — the most differentiated feature in this whole document.

2. **Re-execute-and-diff (§3.3) is still the model.** With `groupBy` collapsing subscribers to one
   execution per workspace, a `graphSlice` per write is fine for an admin UI. It is not fine for a
   dense graph with deep slices at write volume. `queryTimeoutMs` and `maxBroadcastConcurrency` bound
   the blast radius but do not change the shape of the cost.

3. **Room key resolution per event is the sharp edge.** `notifyChange(table, roomKey)` needs to know
   which workspace an event belongs to, but an outbox event carries only `id`/`label`/`src`/`dst`.
   Passing `roomKey: null` fans out to every subscriber of the query — cross-tenant leakage, which
   reflectdb's own docs flag. Resolving the workspace per event costs a lookup per event. The
   pragmatic fix is to **denormalize a `workspaceId` onto node data at write time** so the event's
   room is derivable without a query. Decide this before writing the adapter; retrofitting it means
   backfilling every node.

4. **Two op logs.** reflectdb keeps its own durable log + mirror beside `graph_outbox`. graphx's is
   the truth, reflectdb's is delivery bookkeeping. Real storage duplication and a second compaction
   policy to tune, but not a correctness problem as long as nobody treats the mirror as authoritative.

**Verdict.** Start with Option A. It buys presence, optimistic writes, offline, and resume for an
adapter plus one `core` change, and it will tell you empirically which of the four ceilings you
actually hit. Option C stops being premature the day one of them bites.

---

## 6. The eventual design: `graphx-sync`

> This section describes **Option C** — the destination, not the starting point. Per §5 you should
> ship the reflectdb adapter first. Read this as the map of where that adapter grows into a real
> package once one of the §5.2 ceilings bites, and as the argument for which reflectdb mechanisms are
> worth owning outright when it does. §6.5 is the exception: those three `core` changes are needed
> under **every** option, and item 1 blocks even the Option A adapter.

### 6.1 Package layout

```
packages/sync/src/
  core/
    hlc.ts            ← LIFT VERBATIM from reflectdb/core/hlc.ts (78 LOC)
    protocol.ts       ← adapted from reflectdb/core/types.ts: message union, error taxonomy
    shape.ts          ← NEW: defineSyncShapes, typed root/rels/depth/require
  server/
    ingress.ts        ← op batch validation: drift, replay, batch cap, rate limit
    enforcement.ts    ← LIFT from reflectdb/server/enforcement.ts (serverSet/readonly/limits)
    conflict.ts       ← LIFT resolveLww/resolveMerge/resolveServer/resolveCustom
    membership.ts     ← NEW (graph ResultCache): per-client slice membership set
    fanout.ts         ← ADAPTED broadcast-engine: event-driven, not re-execute-and-diff
    session.ts        ← ADAPTED: sessions, subscriptions, room keys → ReBAC checks
    ephemeral/        ← LIFT wholesale (memory + redis adapters)
  client/
    store.ts          ← ADAPTED: rows→nodes+edges, optimistic overlay, preState rollback
    ops.ts            ← LIFT (op minting, batches, HLC stamping)
    sync-client.ts    ← ADAPTED: hello/bootstrap/resume/ops state machine
    storage/          ← LIFT indexeddb.ts + memory.ts, key by (node|edge, id)
  transport/          ← LIFT ws.ts / sse.ts / polling.ts, wire to Hono in serve.ts
```

### 6.2 HLC on top of the monotonic write clock

graphx's `Graph.now()` (`graph.ts:484`) is `max(Date.now(), lastTs + 1)` — monotonic within a
process, and `valid_from` is that value. It is already a partial logical clock; it just has no node
identity and no receive path.

Keep both, do not replace `valid_from`:

- `valid_from` stays a plain epoch-ms number. It is the temporal axis, it is indexed, and every
  `asOf` query and the whole DuckDB/Parquet layer depend on its shape. Do not touch it.
- Add an `hlc TEXT` column to `node_versions` / `edge_versions`, holding the packed HLC of the op
  that produced the version. This is the **causal** axis, and it is what conflict resolution reads.

The server derives `valid_from` from its own clock as it does now, and records the client's HLC
alongside. Two axes, two jobs: `valid_from` answers _when did this hold_, `hlc` answers _what did the
author know_. Conflating them is the mistake to avoid — a client with a skewed clock must not be able
to write a version into the past of the temporal index.

`MAX_CLOCK_DRIFT_MS` clamping in `receiveHlc` is what keeps a malicious client from parking an HLC
far in the future and winning every future conflict. Keep it.

### 6.3 Conflict resolution → a version branch

`server/conflict.ts` ports almost unchanged. The adaptations:

- `ExistingRow.row` → the live node version's `data`; `rowHlc` → its `hlc` column; `colClocks` → the
  new `col_clocks` JSON column.
- On `accepted`, do not `UPDATE`. Call `graph.updateNode(id, { data: resolvedData })`, which closes
  the live version and opens the resolved one. Stamp the new version's `hlc` and `col_clocks`.
- On rejected: return `reject { reason, serverRow }` exactly as reflectdb does. The client rolls back
  from `preState` and adopts `serverRow`. `merge_stale` keeps its distinct meaning: everything the
  client sent already lost per-column, no divergence, mark resolved and **do not retry**.
- `deleteNode` → `resolvedRow: null` is a version close, not a row deletion. graphx's tombstone is
  the closed version itself, so `TOMBSTONE_RETENTION_MS` has no analogue — deletes are permanently
  and cheaply representable. One fewer moving part than reflectdb.

Edges get `lww` only in v1. An edge has no meaningful per-column merge (`weight` and a small `data`
blob), and `single: true` edges have supersede semantics that already resolve at the store layer.

### 6.4 Shapes, and why ReBAC is the differentiator

A subscription is `{ shape, params }`. On `sync_declare`:

1. Resolve `root` from params.
2. If the shape declares `require`, call `graphx/auth`'s `check(subject, require, root)`. Reject the
   subscription outright if it fails — do not fall back to an unscoped slice. (reflectdb's `room`
   option carries the same warning for the same reason.)
3. Run `graphSlice` bounded by `rels` + `depth`, seed the client's membership set, send a `snapshot`.

On every outbox event, the fanout stage asks: _is `event.id` (or `event.src`/`event.dst`) in this
client's membership set, or one hop outside it along a subscribed rel?_ Only then does anything
happen. When an edge event could change membership (an insert/delete touching a boundary node), the
slice is re-run for that client and the membership diff produces `enter`/`exit` deltas.

The ReBAC check is re-run on `auth_changed`, which emits `shape_changed` — reflectdb has exactly this
message and exactly this reason code; reuse it.

**Revocation is where the bitemporal store earns its keep.** When a grant is revoked, the tuple edge
is closed at time T. A client that received rows between the revocation commit and its own
`shape_changed` can be identified precisely, because `check(..., { asOf })` answers what was true at
each delivery timestamp. No other sync engine in this class can audit that after the fact.

### 6.5 The three changes `graphx` needs

Each is small, independently defensible, and useful outside sync:

1. **`addNode`/`addEdge` accept an optional client-supplied `id`.** Today `graph.ts:499` and `:592`
   mint a ULID unconditionally, which makes optimistic insert impossible — the client cannot name the
   row it just rendered. ULIDs are client-mintable (`ulidx` works in the browser) and remain
   k-sortable. Validate the format and reject a collision; do not trust it blindly.
2. **`col_clocks` + `hlc` columns on `node_versions` / `edge_versions`,** nullable. Nothing outside
   sync reads them; a non-sync deployment writes NULL and behaves identically.
3. **An op-batch ingress route** — `POST /t/:tenant/p/:project/ops` taking `ClientOp[]` with a
   `batchId`, plus `reserveOpId`-style idempotency so a REST retry is not a double write. graphx's
   current write routes are one-op-per-request with no idempotency key, which makes any retry policy
   unsafe today. This is worth doing **even if sync is never built**.

### 6.6 Presence

Lift `server/ephemeral/*` essentially as-is — it is well-isolated, has a clean adapter interface, and
the Redis implementation solves fleet-wide fanout. The room key becomes the shape key. Presence never
touches the outbox, so there is no bitemporal interaction at all. It is the cheapest large win in the
whole plan and can ship independently of everything else.

Keep the separate `ephemeralPerSecond` rate meter. reflectdb's comment is right: each ephemeral
message fans out to every room subscriber, so an unmetered channel is an amplification vector.

---

## 7. What to lift, adapt, and leave

**Lift near-verbatim** (~2.5k LOC, MIT, same author):
`core/hlc.ts`, `server/conflict.ts`, `server/enforcement.ts`, `server/replay-detector.ts`,
`server/ephemeral/*`, `client/ops.ts`, `client/storage/indexeddb.ts`, `client/storage/memory.ts`,
`transport/{ws,sse,polling}.ts`, `broadcast-engine.ts`'s `stableStringify` + the per-(client, query)
lock, and the `ErrorReason` taxonomy.

**Adapt** (rewrite with the same shape):
`client/store.ts` (rows → nodes + edges; keep `preState` rollback exactly),
`client/sync-client.ts` (state machine survives; message payloads change),
`server/session.ts` (rooms → shapes; add the ReBAC gate),
`server/result-cache.ts` → `membership.ts` (set membership, not row diff).

**Do not take**:

- The **re-execute-and-diff broadcast model** (§3.3). This is the single most important divergence.
- The **mirror** (reflectdb's JSONB row store). graphx's versioned store is the mirror. Keeping a
  second one reintroduces the divergence its own docs warn about.
- **`eager` (non-durable) broadcast.** graphx's outbox is transactional with the write; the entire
  reason `eager` exists is that reflectdb's is not. `eager-durable` is graphx's default behavior
  already. Adding at-most-once delivery to a system whose selling point is a complete audit trail
  would be a strange trade.
- **`TOMBSTONE_RETENTION_MS` / compaction of deletes.** A closed version _is_ the tombstone.
- **Drizzle coupling** in `core/schema.ts`. graphx's schema is Zod; `defineGraphSchema` already does
  the inference job that `DrizzleTableLike` does there.

---

## 8. Phasing

Each phase is independently shippable and independently valuable — nothing here is a big-bang
rewrite, and phases 1–2 are worth doing on their own merits even if the rest is never built.

**Phase 0 — core prerequisites.** Client-supplied ids on `addNode`/`addEdge` (blocks everything
else); a denormalized `workspaceId`-style room key on node data (§5.2 item 3 — retrofitting it means
backfilling every node); `POST /ops` batch ingress with idempotency. No new package, and the
idempotency work makes the existing REST surface safe to retry regardless of what follows.

**Phase 1 — the reflectdb adapter (Option A).** `reflectdb` as a dependency, the §5.1 adapter, the
outbox→`notifyChange` bridge, and the ReBAC `room` gate. Ships presence, optimistic writes, offline
queue and resume in one go. Everything below is contingent on what this teaches you.

**Phase 2 — measure the ceilings.** Instrument `graphSlice` executions per write and the room-key
lookup cost. This phase exists to answer one question: _does re-execute-and-diff hold at your write
volume and graph density?_ If yes, stop — Option A is the whole answer and phases 3–5 never happen.

**Phase 3 — membership fanout (first bespoke piece).** Replace the re-execute-and-diff path with
per-client membership sets and event-driven deltas (§3.3), keeping reflectdb's transport, client
store and protocol. This is the surgical fix for the ceiling most likely to bite first, and it does
not require forking anything else.

**Phase 4 — own the conflict path.** `hlc` + `col_clocks` columns, `merge` with per-column clocks,
and the version-branch audit trail from §3.1 — the feature to lead the announcement with. Requires
moving off `eager-durable`, which is the point at which reflectdb's mirror stops being tenable and
`graphx-sync` becomes a real package rather than an adapter.

**Phase 5 — the rest of Option C.** ReBAC-native subgraph shapes, WS + long-poll transports, Redis
ephemeral fanout, HA.

---

## 9. Risks and open questions

1. **Membership sets are unbounded per client.** A client subscribed to a depth-3 slice of a dense
   graph could hold a large id set server-side. reflectdb's windowed sync (`loadMore`, `useTotalCount`)
   is the precedent — a shape needs a node cap and an explicit "slice truncated" signal. Decide the
   cap before the design hardens, not after.
2. **Slice re-run cost on boundary edge writes.** The cheap membership check (§3.3) handles the common
   case, but an edge insert at a slice boundary forces a traversal for every affected client. In a
   hot graph this is the scaling wall. Mitigation: `groupBy`-style collapsing (all clients on the same
   shape+params share one execution) is directly portable and should be in from day one, not retrofitted.
3. **Optimistic writes against a bitemporal store are semantically new.** A client's optimistic
   version has no `valid_from` until the server assigns one. The client's local overlay is therefore
   "a version that may never exist". `asOf` reads on the client must be defined as _excluding_ pending
   ops, or history queries will show phantom versions. Needs an explicit written rule.
4. **`Graph.now()` is per-process.** Multi-process writers against one libSQL/Postgres namespace can
   mint colliding `valid_from` values today. Sync makes this more likely, not less. Worth a look
   independent of this work.
5. **DuckDB backend interaction.** The snapshot-manifest backend is one-writer-per-namespace with CAS
   rebase on conflict (`SnapshotConflictError` → HTTP 409). A sync ingress accepting concurrent op
   batches will hit that path routinely. Either sync serializes per namespace at the ingress, or the
   DuckDB backend is out of scope for phases 3+. Decide early; this is the most likely thing to force
   a redesign late.
6. **`followups.md` F3 boundary.** `graphx-sync` must not pull `duck.ts` or `@duckdb/node-api` onto
   the import path. Same discipline, and it is a new surface to breach it from.
