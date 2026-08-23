# Declarative triggers on graph events

Design for [issue #7](https://github.com/TimMikeladze/graphx/issues/7). Date: 2026-07-27.

## Problem

The event substrate exists and the consumer does not.

`packages/graphx/src/core/events.ts` defines a typed `GraphEvent` covering
`node.create`/`node.update`/`node.delete`/`edge.create`/`edge.delete`/`edge.supersede`, with the
`shape: 'insert' | 'close'` distinction that makes pure closes visible — the case the `valid_from`
CDC feed is structurally blind to. `Graph` emits post-commit through a pluggable `GraphEventSink`.
With `outbox: true` every event is co-written into `graph_outbox` inside the mutation's own
transaction, and `outboxTail` tails it durably with `outboxHead`/`pruneOutbox` alongside.

Nothing consumes it. Outside core's own tests the only caller of `outboxTail` is the `/events` SSE
route in `serve.ts`, which holds its cursor in memory and has no retry. A user who wants "re-embed a
node when its body changes" or "POST to my webhook when an edge appears" writes their own polling
loop, cursor persistence, retry, and dead-letter handling. That is the same code every time, and
getting it wrong drops events silently.

## Decisions

Four forks, resolved:

1. **Triggers are declared in code**, not in the database. A trigger is a `{ name, match, action }`
   object handed to a runner instance — the same per-`Graph` threading `GraphEventSink` already
   uses. The action is a function, which the issue correctly identifies as the primitive everything
   else builds on. `match` is kept as plain serializable data so database-declared triggers are a
   later addition rather than a rewrite.

2. **Provenance lives in a `source` column** on `graph_outbox`. Trigger-originated writes are tagged
   `trigger:<name>`; predicates exclude them by default. This stops a trigger from consuming its own
   output, which is the failure mode that takes down a database on someone's first useful rule.

3. **Delivery is batch-pull with a concurrency bound.** Poll a page from `outboxTail`, dispatch it,
   checkpoint. Default concurrency of 1 gives strict `seq` order; raise it to trade ordering for
   throughput. An event that exhausts its retries is dead-lettered and the batch keeps moving, so a
   poison event never wedges a subscription.

4. **The runner ships from core** as `packages/graphx/src/core/triggers.ts`, plus a thin `graphx triggers`
   CLI command. Core already owns `graph_outbox`, `outboxTail`, and the dialect seam, and the runner
   adds no new dependencies. Apps embed the exported runner in their own worker; the CLI wraps it for
   operators who have not written one. Serverless deployments have nowhere to host a long-lived
   poller — documented, not solved.

## Data model

Three schema edits, mirrored in `schema.ts` (libSQL) and `dialect-sql.ts` (Postgres).

### `graph_outbox` gains provenance

```sql
source TEXT       -- NULL = user write; 'trigger:<name>' = derived
```

There is no migration framework: `init()` is `CREATE TABLE IF NOT EXISTS` throughout, so a new
column never reaches an existing database. `init()` therefore issues a guarded
`ALTER TABLE graph_outbox ADD COLUMN source TEXT`, catching and ignoring the duplicate-column error.
`constraints.ts:77` already uses this pattern.

`GraphEvent` gains `source?: string`; `rowToEvent` in `temporal.ts` reads the column. Filtering by
source happens in the runner, not in SQL — one runner hosts triggers with differing source rules, so
a SQL-level filter would be wrong for some of them.

### Cursors

```sql
CREATE TABLE IF NOT EXISTS trigger_cursors (
  name       TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

One row per runner `name`. Distinct runners over one database use distinct names and advance
independently.

### Dead letters

```sql
CREATE TABLE IF NOT EXISTS trigger_dead_letters (
  id           TEXT PRIMARY KEY,     -- ULID
  subscription TEXT NOT NULL,        -- runner name
  trigger_name TEXT NOT NULL,        -- 'trigger' is reserved in Postgres
  seq          INTEGER NOT NULL,
  event        TEXT NOT NULL,        -- GraphEvent JSON
  error        TEXT NOT NULL,
  attempts     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON trigger_dead_letters(subscription, created_at DESC);
```

Postgres uses `bigint`/`text` for the same shape.

### `graph.ts` changes

Four small ones:

- Retain the `UpcasterRegistry` in a field. It is currently consumed by the `Upcaster` constructor
  and dropped, so a sibling `Graph` cannot be built without losing read-time upcasting.
- `GraphEventOptions` gains `source?: string`.
- `outboxStmt` binds it; `emit` stamps it on in-proc events too.
- New `withEventSource(source: string): Graph<S>` returns a sibling sharing `raw`, `schema`, and
  upcasters, with the tag applied. This is how the runner hands an action a graph whose writes are
  attributable.

## API

All of it in `packages/graphx/src/core/triggers.ts`, exported from `graphx`.

```ts
interface TriggerMatch {
	op?: GraphEventOp | GraphEventOp[];
	entity?: 'node' | 'edge';
	label?: string | string[]; // node type or edge rel
	shape?: 'insert' | 'close';
	source?: 'user' | 'any' | string; // default 'user'
}

type TriggerAction<S extends GraphSchema> = (
	event: GraphEvent,
	graph: Graph<S>,
) => Promise<void> | void;

interface Trigger<S extends GraphSchema> {
	name: string; // stable — keys dead-letter rows and the source tag
	match: TriggerMatch;
	action: TriggerAction<S>;
	retries?: number; // overrides the runner default
}

interface TriggerRunnerOptions<S extends GraphSchema> {
	name: string; // subscription name, the cursor key
	triggers: Trigger<S>[];
	concurrency?: number; // default 1 (strict seq order)
	batchSize?: number; // outboxTail page size, default 100
	pollIntervalMs?: number; // sleep when drained, default 1000
	retries?: number; // attempts before dead-letter, default 3
	backoffMs?: number; // full-jitter base, default 100
	start?: 'beginning' | 'now'; // cursor seed when none is persisted, default 'now'
}

class TriggerRunner<S extends GraphSchema> {
	constructor(graph: Graph<S>, opts: TriggerRunnerOptions<S>);
	start(): void;
	stop(): Promise<void>; // resolves once the loop has exited and in-flight work drained
	runOnce(): Promise<{ delivered: number; deadLettered: number; cursor: number; drained: boolean }>;
}

function webhookAction<S extends GraphSchema>(opts: {
	url: string;
	headers?: Record<string, string>;
	secret?: string;
	timeoutMs?: number; // default 10_000
}): TriggerAction<S>;

interface DeadLetter {
	id: string;
	subscription: string;
	triggerName: string;
	seq: number;
	event: GraphEvent;
	error: string;
	attempts: number;
	createdAt: number;
}

function deadLetters(
	raw: DbClient,
	opts?: { subscription?: string; limit?: number; since?: number },
): Promise<DeadLetter[]>;

function pruneDeadLetters(raw: DbClient, beforeMs: number): Promise<number>;
```

`runOnce()` performs one poll and dispatch with no timers involved. It is the deterministic entry
point for tests, so the durability and cascade cases stay real on both drivers instead of depending
on fake clocks.

`webhookAction` POSTs the event as JSON with `x-graphx-seq`, `x-graphx-event`, and, when `secret` is
set, `x-graphx-signature: sha256=<hex>` — an HMAC-SHA256 over the exact request body, computed with
WebCrypto, no new dependency. A non-2xx response or a timeout throws; the runner owns retry and
dead-lettering.

Derived writes need no factory. The action already holds a source-tagged graph and calls it
directly.

## Runner semantics

One `runOnce()` cycle:

1. Read the cursor from `trigger_cursors`. On the first run, seed it — `start: 'now'` uses
   `outboxHead()`, `'beginning'` uses 0 — and persist it immediately, so a restart before the first
   delivery does not re-seek.
2. `outboxTail(raw, { seq: cursor }, { limit: batchSize })`.
3. For each event, select matching triggers. A `match` that omits `source` matches only events whose
   `source` is null. That default is the loop guard. `source: 'any'` opts into cascades explicitly;
   a literal string matches one tag.
4. Dispatch under the concurrency bound. Each `(event, trigger)` pair gets `retries` attempts with
   full-jitter exponential backoff, reusing the `backoff()` shape at `graph.ts:266`.
5. On exhaustion, write one `trigger_dead_letters` row and continue. A thrown action cannot reach a
   sibling trigger, and cannot reach the mutation that produced the event — that committed before
   the outbox row was ever read.
6. Checkpoint. With `concurrency === 1`, completions are already in `seq` order, so the cursor
   advances after each event. Above 1, it advances once the page is fully resolved.
7. `start()`'s loop repeats until drained (`nextCursor === null`), then sleeps `pollIntervalMs`.

### Delivery guarantees

Triggers ride the durable outbox, never the in-proc bus. `events.ts` already documents why: the
in-proc emit is post-commit and best-effort, and is skipped when a commit lands durably but the
driver's acknowledgement is lost. The outbox row is written inside the mutation's own transaction
and cannot be lost that way.

Delivery is at-least-once. `seq` is the dedupe key, and actions must be idempotent. In the default
serial configuration a crash redelivers at most the one event in flight; above `concurrency: 1` it
redelivers the interrupted page.

Ordering is strict `seq` order at `concurrency: 1` and unordered within a page above it.

### Multi-tenancy

The runner is constructed from a `Graph` and holds no module-global state, preserving the property
`GraphEventSink` and `MetricsSink` already have. Cursors are keyed by runner name. One tenant's
stalled webhook spins its own loop and its own cursor; it cannot stall another's.

## CLI

`graphx triggers -c ./graphx.config.ts`.

No new config format. `GraphxConfig` (`packages/graphx/src/cli.ts:117`) gains two optional fields:

```ts
triggers?: Trigger<S>[];
triggerRunner?: Omit<TriggerRunnerOptions<S>, 'triggers'>;
```

`runTriggers` mirrors `runIngest --watch`: `loadConfig` → `getDb` → `init` →
`new Graph(client, cfg.schema, undefined, { outbox: true })` → `runner.start()` → SIGINT →
`stop()`. The outbox must be enabled or there is nothing to tail; absent it, exit non-zero with that
message rather than idling against an empty table. `parseTriggersArgs` is exported for unit tests,
matching `parseIngestArgs` and `parseServeArgs`.

## Tests

`packages/graphx/test/core/triggers.test.ts`, obtaining its database from `harness.ts` so both
`GRAPHX_TEST_DRIVER` backends run.

- Match filtering across `op`, `entity`, `label`, `shape`, and `source`.
- An in-proc action fires and receives a graph whose writes carry the source tag.
- Pure closes fire: `deleteNode` and `edge.supersede`. This is the reason triggers ride the outbox
  rather than the CDC feed, so it is tested directly.
- Webhook against a local `Bun.serve`: signature verifies against the raw body; a 500 retries to
  exhaustion and dead-letters; a 2xx does neither.
- Cursor durability: run a batch whose action throws partway, construct a second runner over the
  same database, assert it delivers exactly the undelivered remainder.
- Cascade: a trigger on `node.create` that creates a node fires once, not forever.
- A throwing trigger leaves its sibling trigger and the committed mutation intact.
- `deadLetters()` returns the failure with its error text and attempt count.

## Non-goals

Stated so they do not leak into the implementation:

- Triggers declared in the database or the graph schema. `match` is serializable so this can be
  added later without reshaping anything.
- `graphx/auth` gating what a trigger's derived writes may touch. Trigger actions run privileged;
  the docs say so.
- Replaying a dead letter. Inspection is the acceptance criterion; replay is not.
- `serve()` auto-hosting a runner.
- A cascade depth counter. The `source` guard stops a trigger self-loop, which is the failure that
  actually bites. A cycle across two triggers that both opt into `source: 'any'` still loops, and
  earns a depth counter when someone hits it.
