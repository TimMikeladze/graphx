# Graph Event Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship declarative triggers — code-declared rules that match `GraphEvent`s off the durable outbox and run an action — with a restart-safe runner, retries, dead letters, and a `graphx triggers` command.

**Architecture:** A new `packages/core/src/triggers.ts` owns a pure matcher, a `TriggerRunner` that polls `outboxTail` from a persisted per-subscription cursor, and a `webhookAction` factory. Provenance rides on a new `source` column on `graph_outbox`; a trigger's own writes go through `graph.withEventSource('trigger:<name>')` and are excluded by the matcher's default, which is what stops cascades. The runner is constructed from a `Graph`, holds no module-global state, and is embedded by apps or hosted by the CLI.

**Tech Stack:** TypeScript, Bun (test runner and runtime), libSQL and Postgres behind the existing dialect seam, `zod` for schemas in tests, `ulidx` for dead-letter ids. WebCrypto and `fetch` are runtime built-ins.

**Spec:** `docs/superpowers/specs/2026-07-27-graph-event-triggers-design.md`

## Global Constraints

- **No new dependencies.** WebCrypto (`crypto.subtle`), `fetch`, and `AbortSignal.timeout` are runtime built-ins. `ulidx` is already a `@graphx/core` dependency.
- **Every schema change is mirrored in both dialects:** `packages/core/src/schema.ts` (libSQL) and `packages/core/src/dialect-sql.ts` (Postgres). A change to one without the other is a bug.
- **Tests obtain databases only from `packages/core/test/harness.ts`** via `makeTestDb`. Never call `createClient` directly.
- **Build before testing.** `packages/cli` imports `@graphx/core` through its `exports` map, i.e. from `dist/`, which is git-ignored. Run `bun run build` after changing anything under `packages/core/src` and before `bun test`, or the CLI tests fail with `Cannot find module '@graphx/core'`.
- **Always run the suite as `bun run test`, never bare `bun test`.** The script is `bun test --timeout 30000`; Bun's bare default is 5s, under which a large part of the suite times out and looks like flakiness. CI runs `bun run test` too. A focused file is `bun run test <path>`.
- **Both drivers must pass.** Default run: `bun run test`. Postgres run:

  ```bash
  GRAPHX_TEST_DRIVER=postgres \
  GRAPHX_TEST_PG_URL=postgresql://postgres:postgres@localhost:5433/graphx_test \
  bun run test
  ```

  A `pgvector/pgvector:pg16` container named `graphx-pg-triggers` is already running on port 5433 with the `vector` extension created. The env var is `GRAPHX_TEST_PG_URL` (the harness's), not `GRAPHX_PG_URL` (the CLI runtime's). Use `test.skipIf(TEST_DRIVER === 'postgres')` only where a probe is genuinely libSQL-specific, and say why in a comment.
- **Formatting:** tabs for indentation, single quotes, semicolons. Run `bun run lint` (oxlint) and `bun run type-check` before every commit; a pre-commit hook runs both and will reject a failing commit.
- **Doc comments:** this codebase documents *why*, not *what*, and every exported symbol carries a TSDoc comment. New modules open with a header comment explaining the module's role. Match that density.
- **Commit convention:** `feat(triggers): …`, `test(triggers): …`, `docs(triggers): …`.
- **Test timeout:** the suite runs with `--timeout 30000`. Keep backoff values tiny in tests (`backoffMs: 1`) so retry tests finish fast.

## File Structure

**Created:**

- `packages/core/src/triggers.ts` — the whole feature: `TriggerMatch`/`Trigger` types, `matchesTrigger`, `TriggerRunner`, `webhookAction`, `deadLetters`, `pruneDeadLetters`. One module because these pieces share the runner's private state and the dead-letter table; splitting them would export internals for no gain.
- `packages/core/test/triggers.test.ts` — matcher, runner, dead-letter, and webhook tests.

**Modified:**

- `packages/core/src/schema.ts` — `graph_outbox.source` column, `trigger_cursors` and `trigger_dead_letters` tables, `ensureColumn` call in `init()`.
- `packages/core/src/dialect-sql.ts` — the Postgres counterparts of all three.
- `packages/core/src/events.ts` — `GraphEvent.source`, `GraphEventOptions.source`.
- `packages/core/src/graph.ts` — retain the `UpcasterRegistry`, stamp `source` on emits and outbox rows, add `withEventSource`.
- `packages/core/src/temporal.ts` — select and map the `source` column in `outboxTail`.
- `packages/core/src/index.ts` — export the trigger surface.
- `packages/core/test/outbox.test.ts` — provenance tests.
- `packages/cli/src/cli.ts` — `parseTriggersArgs`, `runTriggers`, `GraphxConfig` fields, `USAGE`.
- `packages/cli/test/cli.test.ts` — `parseTriggersArgs` tests.

---

### Task 1: Provenance on the outbox

Adds the `source` column and the `Graph` plumbing that writes it. Nothing consumes it yet; this task exists on its own because a reviewer can judge the schema change and the `Graph` API independently of the runner.

**Files:**
- Modify: `packages/core/src/schema.ts` (the `graph_outbox` DDL, and `init()`)
- Modify: `packages/core/src/dialect-sql.ts` (the Postgres `graph_outbox` DDL)
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/graph.ts`
- Modify: `packages/core/src/temporal.ts`
- Test: `packages/core/test/outbox.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GraphEvent.source?: string`; `GraphEventOptions.source?: string`; `Graph.withEventSource(source: string): Graph<S>`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/outbox.test.ts`. `makeGraph` and `teardowns` already exist at the top of that file; do not redefine them.

```ts
test('outbox rows carry provenance and default to null for user writes', async () => {
	const g = await makeGraph({ outbox: true });
	await g.addNode({ type: 'person', data: { name: 'user write' } });
	const derived = g.withEventSource('trigger:demo');
	await derived.addNode({ type: 'person', data: { name: 'derived write' } });

	const page = await outboxTail(g.raw);
	expect(page.events).toHaveLength(2);
	expect(page.events[0]?.source).toBeUndefined();
	expect(page.events[1]?.source).toBe('trigger:demo');
});

test('withEventSource shares the client and stamps the in-proc sink too', async () => {
	const sink = new InMemoryEvents();
	const g = await makeGraph({ outbox: true, sink });
	const derived = g.withEventSource('trigger:demo');

	expect(derived.raw).toBe(g.raw);
	expect(derived.schema).toBe(g.schema);

	await g.addNode({ type: 'person', data: { name: 'a' } });
	await derived.addNode({ type: 'person', data: { name: 'b' } });

	expect(sink.events).toHaveLength(2);
	expect(sink.events[0]?.source).toBeUndefined();
	expect(sink.events[1]?.source).toBe('trigger:demo');
});
```

Add `InMemoryEvents` to the existing `../src/events.ts` import at the top of the file (it currently imports only the `GraphEventOptions` type).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/outbox.test.ts -t provenance`
Expected: FAIL — `g.withEventSource is not a function`.

- [ ] **Step 3: Add the column to both dialects**

In `packages/core/src/schema.ts`, add `source` as the last column of `graph_outbox` and extend the comment above it:

```sql
-- Eventing (Layer 2): durable, totally-ordered, delete-inclusive event log co-written into
-- each mutation's own transaction and tailed by outboxTail. AUTOINCREMENT is load-bearing —
-- a bare rowid is REUSED after a prune drain, which would strand client cursors on stale seqs.
-- `source` is provenance: NULL for a user write, 'trigger:<name>' for one made by a trigger
-- action. The trigger matcher excludes non-NULL sources by default, which is what stops a
-- trigger from consuming its own output and cascading without bound.
CREATE TABLE IF NOT EXISTS graph_outbox (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  op     TEXT NOT NULL,
  entity TEXT NOT NULL,
  id     TEXT NOT NULL,
  label  TEXT,
  src    TEXT,
  dst    TEXT,
  shape  TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  source TEXT
);
```

In `packages/core/src/dialect-sql.ts`, add `source text` as the last column of the Postgres `graph_outbox`, and immediately after that `CREATE TABLE` statement add the idempotent upgrade for databases created before this change:

```sql
ALTER TABLE graph_outbox ADD COLUMN IF NOT EXISTS source text;
```

libSQL has no `ADD COLUMN IF NOT EXISTS`, so use the existing guard. In `init()` in `schema.ts`, after `await client.executeMultiple(schema(dim));`:

```ts
	// Pre-existing namespaces predate `graph_outbox.source`; `CREATE TABLE IF NOT EXISTS` will not
	// add it, and without it every outbox INSERT fails on the unknown column.
	await ensureColumn(
		client,
		'graph_outbox',
		'source',
		'ALTER TABLE graph_outbox ADD COLUMN source TEXT',
	);
```

- [ ] **Step 4: Thread `source` through events, Graph, and the tail**

In `packages/core/src/events.ts`, add to `GraphEvent` (after `dst`):

```ts
	/** Provenance: absent on a user write, `trigger:<name>` on a write made by a trigger action. */
	source?: string;
```

and to `GraphEventOptions`:

```ts
	/**
	 * Stamp every event from this `Graph` with a provenance tag (e.g. `trigger:reembed`). Set via
	 * {@link import('./graph.ts').Graph.withEventSource}; the trigger matcher excludes tagged
	 * events by default so a trigger never consumes its own writes.
	 */
	source?: string;
```

In `packages/core/src/graph.ts`, add two fields beside the existing `outbox` field:

```ts
	/** Retained so {@link withEventSource} can build a sibling without losing read-time upcasting. */
	private readonly upcasters: UpcasterRegistry;
	/** Provenance stamped on every emitted event and outbox row; `undefined` ⇒ a user write. */
	private readonly eventSource: string | undefined;
	/** Retained verbatim so {@link withEventSource} inherits the sink and outbox setting. */
	private readonly eventOpts: GraphEventOptions | undefined;
```

Rewrite the constructor body:

```ts
	constructor(
		public raw: DbClient,
		public schema: S,
		upcasters?: UpcasterRegistry,
		events?: GraphEventOptions,
	) {
		this.upcasters = upcasters ?? {};
		this.upcaster = new Upcaster(schema, this.upcasters);
		this.events = events?.sink ?? NOOP_EVENTS;
		this.outbox = events?.outbox ?? false;
		this.eventSource = events?.source;
		this.eventOpts = events;
	}

	/**
	 * A sibling `Graph` over the same client, schema and upcasters whose events carry `source`.
	 * The trigger runner hands one of these to every action, so a trigger's derived writes are
	 * attributable and the matcher's default predicate can exclude them.
	 */
	withEventSource(source: string): Graph<S> {
		return new Graph(this.raw, this.schema, this.upcasters, { ...this.eventOpts, source });
	}
```

Stamp the in-proc emit:

```ts
	private emit(event: GraphEvent): void {
		try {
			this.events.emit(this.eventSource === undefined ? event : { ...event, source: this.eventSource });
		} catch {
			/* a sink must never break a committed mutation */
		}
	}
```

Bind it in `outboxStmt`:

```ts
		return {
			sql: `INSERT INTO graph_outbox (op, entity, id, label, src, dst, shape, ts, source)
				VALUES (?,?,?,?,?,?,?,?,?)`,
			args: [
				event.op,
				event.entity,
				event.id,
				event.label,
				event.src ?? null,
				event.dst ?? null,
				event.shape,
				event.ts,
				this.eventSource ?? null,
			],
		};
```

In `packages/core/src/temporal.ts`, add `source` to `rowToEvent`:

```ts
		source: row.source == null ? undefined : String(row.source),
```

and to the `outboxTail` SELECT list:

```ts
	const sql = `SELECT seq, op, entity, id, label, src, dst, shape, ts, source FROM graph_outbox${where} ORDER BY seq LIMIT ?`;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/core/test/outbox.test.ts`
Expected: PASS, including the pre-existing tests.

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/outbox.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite for regressions**

Run: `bun test && bun run lint && bun run type-check`
Expected: PASS. `graph.ts` is touched by nearly every test, so a green full suite is the gate here.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schema.ts packages/core/src/dialect-sql.ts packages/core/src/events.ts \
        packages/core/src/graph.ts packages/core/src/temporal.ts packages/core/test/outbox.test.ts
git commit -m "feat(events): provenance column on the outbox, Graph.withEventSource"
```

---

### Task 2: Trigger tables and dead-letter inspection

Creates the two new tables and the read side of the dead-letter API. Independently reviewable: the tables and their query shape are judged before any runner writes to them.

**Files:**
- Modify: `packages/core/src/schema.ts`
- Modify: `packages/core/src/dialect-sql.ts`
- Create: `packages/core/src/triggers.ts`
- Test: `packages/core/test/triggers.test.ts`

**Interfaces:**
- Consumes: `GraphEvent` from Task 1.
- Produces: `DeadLetter`, `DeadLetterOpts`, `deadLetters(raw, opts?)`, `pruneDeadLetters(raw, beforeMs)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/triggers.test.ts`:

```ts
import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { GraphEvent } from '../src/events.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { deadLetters, pruneDeadLetters } from '../src/triggers.ts';
import { makeTestDb } from './harness.ts';

// Eventing Layer 3 — declarative triggers over the durable graph_outbox. Every test drives the
// runner through `runOnce()` rather than `start()`, so nothing here depends on wall-clock timing.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

const teardowns: Array<() => Promise<void>> = [];

async function makeGraph(): Promise<Graph<typeof SCHEMA>> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, 4);
	return new Graph(client, SCHEMA, undefined, { outbox: true });
}

const SAMPLE: GraphEvent = {
	seq: 7,
	op: 'node.create',
	entity: 'node',
	id: '01J000000000000000000000AA',
	label: 'person',
	shape: 'insert',
	ts: 1_700_000_000_000,
};

afterAll(async () => {
	for (const t of teardowns) await t();
});

test('dead letters are readable newest-first and filterable by subscription', async () => {
	const g = await makeGraph();
	const insert = async (subscription: string, createdAt: number) => {
		await g.raw.execute({
			sql: `INSERT INTO trigger_dead_letters
			        (id, subscription, trigger_name, seq, event, error, attempts, created_at)
			      VALUES (?,?,?,?,?,?,?,?)`,
			args: [
				`dl-${subscription}-${createdAt}`,
				subscription,
				'reembed',
				SAMPLE.seq as number,
				JSON.stringify(SAMPLE),
				'boom',
				3,
				createdAt,
			],
		});
	};
	await insert('a', 1000);
	await insert('a', 2000);
	await insert('b', 3000);

	const all = await deadLetters(g.raw);
	expect(all).toHaveLength(3);
	expect(all.map((d) => d.createdAt)).toEqual([3000, 2000, 1000]);
	expect(all[0]?.event).toEqual(SAMPLE); // round-trips through JSON
	expect(all[0]?.triggerName).toBe('reembed');
	expect(all[0]?.attempts).toBe(3);
	expect(all[0]?.error).toBe('boom');

	const onlyA = await deadLetters(g.raw, { subscription: 'a' });
	expect(onlyA.map((d) => d.createdAt)).toEqual([2000, 1000]);

	const recent = await deadLetters(g.raw, { since: 2000 });
	expect(recent.map((d) => d.createdAt)).toEqual([3000, 2000]);

	expect(await deadLetters(g.raw, { limit: 1 })).toHaveLength(1);
});

test('pruneDeadLetters drops rows older than the watermark', async () => {
	const g = await makeGraph();
	for (const createdAt of [100, 200, 300]) {
		await g.raw.execute({
			sql: `INSERT INTO trigger_dead_letters
			        (id, subscription, trigger_name, seq, event, error, attempts, created_at)
			      VALUES (?,?,?,?,?,?,?,?)`,
			args: [`dl-${createdAt}`, 's', 't', 1, JSON.stringify(SAMPLE), 'boom', 1, createdAt],
		});
	}
	expect(await pruneDeadLetters(g.raw, 300)).toBe(2);
	expect(await deadLetters(g.raw)).toHaveLength(1);
	expect(() => pruneDeadLetters(g.raw, 1.5)).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/triggers.test.ts`
Expected: FAIL — cannot resolve `../src/triggers.ts`.

- [ ] **Step 3: Add the tables to both dialects**

In `packages/core/src/schema.ts`, after the `graph_outbox` block:

```sql
-- Eventing (Layer 3): trigger runner state. One cursor row per subscription name — the runner
-- resumes from it after a restart, which is the whole reason triggers ride the durable outbox
-- rather than the best-effort in-proc bus.
CREATE TABLE IF NOT EXISTS trigger_cursors (
  name       TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Events whose action exhausted its retries. Written so a poison event can be inspected instead
-- of wedging its subscription forever. `trigger_name` rather than `trigger` — the latter is a
-- reserved word in Postgres.
CREATE TABLE IF NOT EXISTS trigger_dead_letters (
  id           TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  event        TEXT NOT NULL,
  error        TEXT NOT NULL,
  attempts     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON trigger_dead_letters(subscription, created_at DESC);
```

The Postgres counterpart in `packages/core/src/dialect-sql.ts`, same comments:

```sql
CREATE TABLE IF NOT EXISTS trigger_cursors (
  name       text PRIMARY KEY,
  seq        bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS trigger_dead_letters (
  id           text PRIMARY KEY,
  subscription text NOT NULL,
  trigger_name text NOT NULL,
  seq          bigint NOT NULL,
  event        text NOT NULL,
  error        text NOT NULL,
  attempts     bigint NOT NULL,
  created_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letters_sub
  ON trigger_dead_letters(subscription, created_at DESC);
```

- [ ] **Step 4: Write the module and the dead-letter API**

Create `packages/core/src/triggers.ts`:

```ts
/**
 * Declarative triggers (eventing Layer 3) — "when this happens to the graph, run this".
 *
 * Triggers ride the DURABLE outbox ({@link import('./temporal.ts').outboxTail}), never the in-proc
 * {@link import('./events.ts').GraphEventBus}. `events.ts` spells out why: the in-proc emit is
 * post-commit and best-effort, and is skipped when a commit lands durably but the driver's ack is
 * lost. The outbox row is written inside the mutation's own transaction and cannot be lost that
 * way. The consequence is at-least-once delivery — `seq` is the dedupe key and actions must be
 * idempotent.
 *
 * Cascade safety comes from provenance: the runner hands each action a `Graph` tagged
 * `trigger:<name>` (see {@link import('./graph.ts').Graph.withEventSource}), and a
 * {@link TriggerMatch} that omits `source` matches only untagged user writes. A trigger therefore
 * cannot consume its own output unless it opts in with `source: 'any'`.
 *
 * State is per-`Graph` and per-subscription — no module globals — so one tenant's stalled trigger
 * spins its own loop and its own cursor and cannot stall another's.
 */

import type { DbClient, SqlValue } from './dialect.ts';
import type { GraphEvent } from './events.ts';

/** One event whose action exhausted its retries, as stored in `trigger_dead_letters`. */
export interface DeadLetter {
	id: string;
	/** The runner name that failed to deliver it. */
	subscription: string;
	/** The trigger whose action threw. */
	triggerName: string;
	/** Outbox `seq` of the undelivered event. */
	seq: number;
	event: GraphEvent;
	/** The last attempt's stack (or message). */
	error: string;
	/** How many attempts were made before giving up. */
	attempts: number;
	createdAt: number;
}

/** Filters for {@link deadLetters}. */
export interface DeadLetterOpts {
	subscription?: string;
	/** Page size, newest first. Default 100. */
	limit?: number;
	/** Only rows with `created_at >= since` (epoch ms). */
	since?: number;
}

/** Read dead letters newest-first — the operator's window into what failed and why. */
export async function deadLetters(
	raw: DbClient,
	opts: DeadLetterOpts = {},
): Promise<DeadLetter[]> {
	const conds: string[] = [];
	const args: SqlValue[] = [];
	if (opts.subscription !== undefined) {
		conds.push('subscription = ?');
		args.push(opts.subscription);
	}
	if (opts.since !== undefined) {
		conds.push('created_at >= ?');
		args.push(opts.since);
	}
	const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
	args.push(opts.limit ?? 100);
	const r = await raw.execute({
		sql: `SELECT id, subscription, trigger_name, seq, event, error, attempts, created_at
			FROM trigger_dead_letters${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
		args,
	});
	return r.rows.map((row) => ({
		id: String(row.id),
		subscription: String(row.subscription),
		triggerName: String(row.trigger_name),
		seq: Number(row.seq),
		event: JSON.parse(String(row.event)) as GraphEvent,
		error: String(row.error),
		attempts: Number(row.attempts),
		createdAt: Number(row.created_at),
	}));
}

/**
 * Drop dead letters older than `beforeMs`. Retention is the caller's policy — this is just the
 * mechanism, matching {@link import('./temporal.ts').pruneOutbox}. Returns rows deleted.
 */
export async function pruneDeadLetters(raw: DbClient, beforeMs: number): Promise<number> {
	if (!Number.isInteger(beforeMs)) {
		throw new Error(`pruneDeadLetters: beforeMs must be an integer, got ${beforeMs}`);
	}
	const r = await raw.execute({
		sql: 'DELETE FROM trigger_dead_letters WHERE created_at < ?',
		args: [beforeMs],
	});
	return r.rowsAffected;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/core/test/triggers.test.ts`
Expected: PASS (2 tests).

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/triggers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema.ts packages/core/src/dialect-sql.ts \
        packages/core/src/triggers.ts packages/core/test/triggers.test.ts
git commit -m "feat(triggers): cursor and dead-letter tables, dead-letter inspection"
```

---

### Task 3: The match predicate

A pure function over `GraphEvent`. Separately reviewable because the default-`source` behaviour is the loop guard and deserves its own gate.

**Files:**
- Modify: `packages/core/src/triggers.ts`
- Test: `packages/core/test/triggers.test.ts`

**Interfaces:**
- Consumes: `GraphEvent`.
- Produces: `TriggerMatch`, `matchesTrigger(event: GraphEvent, match: TriggerMatch): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/triggers.test.ts`, and add `matchesTrigger` to the existing `../src/triggers.ts` import (the `TriggerMatch` type is inferred at each call site — importing it unused would trip oxlint):

```ts
const EDGE_CLOSE: GraphEvent = {
	seq: 8,
	op: 'edge.delete',
	entity: 'edge',
	id: '01J000000000000000000000BB',
	label: 'knows',
	shape: 'close',
	ts: 1_700_000_000_001,
	src: 'a',
	dst: 'b',
};

test('an empty match accepts any user write and rejects a trigger write', () => {
	expect(matchesTrigger(SAMPLE, {})).toBe(true);
	expect(matchesTrigger({ ...SAMPLE, source: 'trigger:x' }, {})).toBe(false);
});

test('op, entity, label and shape narrow the match', () => {
	expect(matchesTrigger(SAMPLE, { op: 'node.create' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { op: 'node.delete' })).toBe(false);
	expect(matchesTrigger(SAMPLE, { op: ['node.delete', 'node.create'] })).toBe(true);

	expect(matchesTrigger(SAMPLE, { entity: 'node' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { entity: 'edge' })).toBe(false);

	expect(matchesTrigger(SAMPLE, { label: 'person' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { label: ['device', 'person'] })).toBe(true);
	expect(matchesTrigger(SAMPLE, { label: 'device' })).toBe(false);

	expect(matchesTrigger(SAMPLE, { shape: 'insert' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { shape: 'close' })).toBe(false);
	expect(matchesTrigger(EDGE_CLOSE, { entity: 'edge', shape: 'close', label: 'knows' })).toBe(true);
});

test('source selects between user writes, a specific tag, and everything', () => {
	const tagged = { ...SAMPLE, source: 'trigger:reembed' };
	expect(matchesTrigger(tagged, { source: 'any' })).toBe(true);
	expect(matchesTrigger(SAMPLE, { source: 'any' })).toBe(true);

	expect(matchesTrigger(tagged, { source: 'trigger:reembed' })).toBe(true);
	expect(matchesTrigger(tagged, { source: 'trigger:other' })).toBe(false);
	expect(matchesTrigger(SAMPLE, { source: 'trigger:reembed' })).toBe(false);

	expect(matchesTrigger(SAMPLE, { source: 'user' })).toBe(true);
	expect(matchesTrigger(tagged, { source: 'user' })).toBe(false);
});

test('every clause must hold, not just one', () => {
	expect(matchesTrigger(SAMPLE, { op: 'node.create', label: 'device' })).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/triggers.test.ts -t match`
Expected: FAIL — `matchesTrigger` is not exported by `../src/triggers.ts`.

- [ ] **Step 3: Implement the matcher**

Add to `packages/core/src/triggers.ts`, importing `GraphEventOp` alongside `GraphEvent`:

```ts
/**
 * A predicate over {@link GraphEvent}. Plain serializable data on purpose: triggers are declared in
 * code today, and keeping the predicate free of functions is what lets schema- or database-declared
 * triggers land later as a pure addition. An absent field matches anything — except `source`, whose
 * default is the cascade guard.
 */
export interface TriggerMatch {
	op?: GraphEventOp | GraphEventOp[];
	entity?: 'node' | 'edge';
	/** Node type or edge rel. */
	label?: string | string[];
	/** `'close'` selects the pure closes the CDC feed is blind to (deletes and supersedes). */
	shape?: 'insert' | 'close';
	/**
	 * `'user'` (the default) matches only untagged writes; `'any'` matches everything and opts into
	 * cascades; any other string matches that provenance tag exactly.
	 */
	source?: 'user' | 'any' | (string & {});
}

/** Does `event` satisfy every clause of `match`? */
export function matchesTrigger(event: GraphEvent, match: TriggerMatch): boolean {
	if (match.op !== undefined) {
		const ops = Array.isArray(match.op) ? match.op : [match.op];
		if (!ops.includes(event.op)) return false;
	}
	if (match.entity !== undefined && match.entity !== event.entity) return false;
	if (match.label !== undefined) {
		const labels = Array.isArray(match.label) ? match.label : [match.label];
		if (!labels.includes(event.label)) return false;
	}
	if (match.shape !== undefined && match.shape !== event.shape) return false;
	const source = match.source ?? 'user';
	if (source === 'any') return true;
	if (source === 'user') return event.source === undefined;
	return event.source === source;
}
```

`(string & {})` keeps the `'user'`/`'any'` literals in editor completions while still accepting an arbitrary tag. If oxlint objects to it, drop the intersection and use `string`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/test/triggers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/triggers.ts packages/core/test/triggers.test.ts
git commit -m "feat(triggers): match predicate with a default cascade guard"
```

---

### Task 4: The runner — one serial cycle

`runOnce()` with cursor seeding, per-event checkpointing, retries, and dead-lettering. Serial only; concurrency lands in Task 5.

**Files:**
- Modify: `packages/core/src/triggers.ts`
- Modify: `docs/superpowers/specs/2026-07-27-graph-event-triggers-design.md`
- Test: `packages/core/test/triggers.test.ts`

**Interfaces:**
- Consumes: `matchesTrigger`, `TriggerMatch`, `deadLetters`, `Graph.withEventSource`, `outboxTail`, `outboxHead`.
- Produces: `TriggerAction<S>`, `Trigger<S>`, `TriggerRunnerOptions<S>`, `TriggerBatchResult`, `class TriggerRunner<S>` with `runOnce()`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/triggers.test.ts`. Extend the imports with `TriggerRunner` from `../src/triggers.ts` and `TEST_DRIVER` plus the `DbClient` type as noted.

```ts
test('a matching in-proc action fires and receives a source-tagged graph', async () => {
	const g = await makeGraph();
	const seen: GraphEvent[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-basic',
		start: 'beginning',
		triggers: [
			{
				name: 'record',
				match: { op: 'node.create', label: 'person' },
				action: async (event, graph) => {
					seen.push(event);
					await graph.addNode({ type: 'person', data: { name: 'derived' } });
				},
			},
		],
	});

	await g.addNode({ type: 'person', data: { name: 'seed' } });
	const first = await runner.runOnce();

	expect(first.delivered).toBe(1);
	expect(first.deadLettered).toBe(0);
	expect(seen).toHaveLength(1);
	expect(seen[0]?.label).toBe('person');

	// The action's own write is tagged, so the same trigger does not match it.
	const second = await runner.runOnce();
	expect(second.delivered).toBe(0);
	expect(seen).toHaveLength(1);
	expect(second.drained).toBe(true);
});

test('pure closes fire triggers — the reason this rides the outbox', async () => {
	const g = await makeGraph();
	const closes: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-closes',
		start: 'beginning',
		triggers: [
			{
				name: 'on-close',
				match: { shape: 'close' },
				action: (event) => {
					closes.push(event.op);
				},
			},
		],
	});

	const a = await g.addNode({ type: 'person', data: { name: 'a' } });
	const b = await g.addNode({ type: 'person', data: { name: 'b' } });
	const e = await g.addEdge({ rel: 'knows', src: a.id, dst: b.id });
	await g.deleteEdge(e.id);
	await g.deleteNode(a.id);

	await runner.runOnce();
	expect(closes).toEqual(['edge.delete', 'node.delete']);
});

test('start defaults to now, skipping events that predate the subscription', async () => {
	const g = await makeGraph();
	await g.addNode({ type: 'person', data: { name: 'before' } });

	const seen: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-now',
		triggers: [
			{ name: 'record', match: {}, action: (e) => void seen.push(e.id) },
		],
	});

	const after = await g.addNode({ type: 'person', data: { name: 'after' } });
	await runner.runOnce();
	expect(seen).toEqual([after.id]);
});

test('a failing action retries, dead-letters, and cannot break its sibling', async () => {
	const g = await makeGraph();
	let attempts = 0;
	const sibling: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-fail',
		start: 'beginning',
		retries: 3,
		backoffMs: 1,
		triggers: [
			{
				name: 'boom',
				match: {},
				action: () => {
					attempts++;
					throw new Error('always fails');
				},
			},
			{ name: 'ok', match: {}, action: (e) => void sibling.push(e.id) },
		],
	});

	const node = await g.addNode({ type: 'person', data: { name: 'seed' } });
	const result = await runner.runOnce();

	expect(attempts).toBe(3);
	expect(result.deadLettered).toBe(1);
	expect(result.delivered).toBe(1); // the sibling still ran
	expect(sibling).toEqual([node.id]);

	const dl = await deadLetters(g.raw, { subscription: 'sub-fail' });
	expect(dl).toHaveLength(1);
	expect(dl[0]?.triggerName).toBe('boom');
	expect(dl[0]?.attempts).toBe(3);
	expect(dl[0]?.error).toContain('always fails');
	expect(dl[0]?.event.id).toBe(node.id);

	// The mutation that produced the event is untouched by the failure.
	expect(await g.getNode(node.id)).not.toBeNull();

	// A poison event does not wedge the subscription.
	expect((await runner.runOnce()).delivered).toBe(0);
});

test('a second runner resumes at exactly the undelivered remainder', async () => {
	const g = await makeGraph();
	const ids: string[] = [];
	for (let i = 0; i < 4; i++) {
		ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
	}

	const seenA: string[] = [];
	const a = new TriggerRunner(g, {
		name: 'sub-resume',
		start: 'beginning',
		batchSize: 2,
		triggers: [{ name: 'record', match: {}, action: (e) => void seenA.push(e.id) }],
	});
	await a.runOnce();
	expect(seenA).toEqual([ids[0], ids[1]]);

	// A fresh runner over the same subscription name — the restart case.
	const seenB: string[] = [];
	const b = new TriggerRunner(g, {
		name: 'sub-resume',
		start: 'beginning',
		triggers: [{ name: 'record', match: {}, action: (e) => void seenB.push(e.id) }],
	});
	await b.runOnce();
	expect(seenB).toEqual([ids[2], ids[3]]); // no replay, no skip
});
```

Add the libSQL-only hard-crash variant. It closes the client from inside an action so the checkpoint write fails the way a killed process would, then resumes on a sibling connection to the same file — `makeTestDb` only exposes `sibling` on a libSQL file database, hence the skip.

```ts
test.skipIf(TEST_DRIVER === 'postgres')(
	'a process killed mid-batch redelivers only what it had not checkpointed',
	async () => {
		const { client, sibling, teardown } = makeTestDb({ file: true });
		teardowns.push(teardown);
		await init(client, 4);
		const g = new Graph(client, SCHEMA, undefined, { outbox: true });

		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
		}

		const seenA: string[] = [];
		const a = new TriggerRunner(g, {
			name: 'sub-crash',
			start: 'beginning',
			retries: 1,
			backoffMs: 1,
			triggers: [
				{
					name: 'record',
					match: {},
					action: (e) => {
						if (e.id === ids[2]) {
							client.close(); // the process dies before this event is delivered
							throw new Error('process died');
						}
						seenA.push(e.id);
					},
				},
			],
		});
		await expect(a.runOnce()).rejects.toThrow();
		expect(seenA).toEqual([ids[0], ids[1]]);

		const revived = new Graph((sibling as () => DbClient)(), SCHEMA, undefined, { outbox: true });
		const seenB: string[] = [];
		const b = new TriggerRunner(revived, {
			name: 'sub-crash',
			start: 'beginning',
			triggers: [{ name: 'record', match: {}, action: (e) => void seenB.push(e.id) }],
		});
		await b.runOnce();
		expect(seenB).toEqual([ids[2], ids[3]]);
	},
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/triggers.test.ts -t runner`
Expected: FAIL — `TriggerRunner` is not exported by `../src/triggers.ts`.

- [ ] **Step 3: Implement the runner**

Add to `packages/core/src/triggers.ts`. Extend the imports:

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { ulid } from 'ulidx';
import type { Graph, GraphSchema } from './graph.ts';
import { outboxHead, outboxTail } from './temporal.ts';
```

```ts
/**
 * What a trigger does. Receives the event and a `Graph` whose writes are tagged
 * `trigger:<name>`, so derived writes are attributable and excluded from the trigger's own match.
 * Throwing signals failure: the runner retries, then dead-letters.
 */
export type TriggerAction<S extends GraphSchema> = (
	event: GraphEvent,
	graph: Graph<S>,
) => Promise<void> | void;

/** A rule: match some subset of events, run an action. */
export interface Trigger<S extends GraphSchema> {
	/** Stable — it keys the dead-letter rows and the provenance tag on derived writes. */
	name: string;
	match: TriggerMatch;
	action: TriggerAction<S>;
	/** Attempts before dead-lettering. Overrides the runner default. */
	retries?: number;
}

/** Construction options for a {@link TriggerRunner}. */
export interface TriggerRunnerOptions<S extends GraphSchema> {
	/** Subscription name — the `trigger_cursors` key. Two runners over one DB need distinct names. */
	name: string;
	triggers: Trigger<S>[];
	/** Events dispatched at once within a page. `1` (the default) means strict `seq` order. */
	concurrency?: number;
	/** `outboxTail` page size. Default 100. */
	batchSize?: number;
	/** Sleep between polls once drained. Default 1000. */
	pollIntervalMs?: number;
	/** Attempts per (event, trigger) before dead-lettering. Default 3. */
	retries?: number;
	/** Full-jitter exponential backoff base. Default 100. */
	backoffMs?: number;
	/** Cursor seed when none is persisted: `'now'` (the default) skips history. */
	start?: 'beginning' | 'now';
}

/** The outcome of one {@link TriggerRunner.runOnce} cycle. */
export interface TriggerBatchResult {
	/** (event, trigger) pairs whose action succeeded. */
	delivered: number;
	/** (event, trigger) pairs that exhausted their retries. */
	deadLettered: number;
	/** The persisted cursor after the cycle. */
	cursor: number;
	/** True when the outbox had nothing more to read. */
	drained: boolean;
}

/**
 * Polls the durable outbox and runs matching triggers, resuming from a persisted cursor after a
 * restart. Delivery is at-least-once; `event.seq` is the dedupe key.
 *
 * Drive it with {@link start}/{@link stop} in a worker, or call {@link runOnce} directly for one
 * deterministic cycle (which is what the tests do — no timers involved).
 */
export class TriggerRunner<S extends GraphSchema> {
	private readonly triggers: Trigger<S>[];
	private readonly name: string;
	private readonly concurrency: number;
	private readonly batchSize: number;
	private readonly pollIntervalMs: number;
	private readonly retries: number;
	private readonly backoffMs: number;
	private readonly startAt: 'beginning' | 'now';
	/** Source-tagged sibling graphs, one per trigger, built lazily and reused. */
	private readonly graphs = new Map<string, Graph<S>>();
	/** `null` until the first cycle reads (or seeds) the persisted cursor. */
	private cursor: number | null = null;

	constructor(
		private readonly graph: Graph<S>,
		opts: TriggerRunnerOptions<S>,
	) {
		if (opts.concurrency !== undefined && (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)) {
			throw new Error(`TriggerRunner: concurrency must be a positive integer, got ${opts.concurrency}`);
		}
		this.name = opts.name;
		this.triggers = opts.triggers;
		this.concurrency = opts.concurrency ?? 1;
		this.batchSize = opts.batchSize ?? 100;
		this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
		this.retries = opts.retries ?? 3;
		this.backoffMs = opts.backoffMs ?? 100;
		this.startAt = opts.start ?? 'now';
	}

	/**
	 * One poll and dispatch. The cursor advances after each delivered event, so an interrupted
	 * cycle resumes at exactly the first event it had not finished.
	 */
	async runOnce(): Promise<TriggerBatchResult> {
		if (this.cursor === null) this.cursor = await this.seedCursor();
		const page = await outboxTail(
			this.graph.raw,
			{ seq: this.cursor },
			{ limit: this.batchSize },
		);
		let delivered = 0;
		let deadLettered = 0;
		for (const event of page.events) {
			const outcome = await this.dispatch(event);
			delivered += outcome.delivered;
			deadLettered += outcome.deadLettered;
			this.cursor = event.seq as number;
			await this.saveCursor(this.cursor);
		}
		return {
			delivered,
			deadLettered,
			cursor: this.cursor,
			drained: page.nextCursor === null,
		};
	}

	/**
	 * The persisted cursor, seeded and written on first use. Seeding through
	 * {@link import('./temporal.ts').outboxHead} rather than `MAX(seq)` keeps the Postgres
	 * visibility gate — a bare max can start past a lower-seq row that has not committed yet, which
	 * would skip it forever. Persisting immediately means a restart before the first delivery does
	 * not re-seek to a different head.
	 */
	private async seedCursor(): Promise<number> {
		const r = await this.graph.raw.execute({
			sql: 'SELECT seq FROM trigger_cursors WHERE name = ?',
			args: [this.name],
		});
		const row = r.rows[0];
		if (row !== undefined) return Number(row.seq);
		const seq = this.startAt === 'beginning' ? 0 : await outboxHead(this.graph.raw);
		await this.saveCursor(seq);
		return seq;
	}

	private async saveCursor(seq: number): Promise<void> {
		await this.graph.raw.execute({
			sql: `INSERT INTO trigger_cursors (name, seq, updated_at) VALUES (?,?,?)
				ON CONFLICT(name) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`,
			args: [this.name, seq, Date.now()],
		});
	}

	/** Run every trigger that matches `event`. One trigger's failure never reaches another's. */
	private async dispatch(event: GraphEvent): Promise<{ delivered: number; deadLettered: number }> {
		let delivered = 0;
		let deadLettered = 0;
		for (const trigger of this.triggers) {
			if (!matchesTrigger(event, trigger.match)) continue;
			if (await this.deliver(trigger, event)) delivered++;
			else deadLettered++;
		}
		return { delivered, deadLettered };
	}

	/** Attempt one trigger with backoff. `false` ⇒ attempts exhausted and a dead letter written. */
	private async deliver(trigger: Trigger<S>, event: GraphEvent): Promise<boolean> {
		const attempts = trigger.retries ?? this.retries;
		let lastError = '';
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				await trigger.action(event, this.graphFor(trigger.name));
				return true;
			} catch (e) {
				lastError = e instanceof Error ? (e.stack ?? e.message) : String(e);
				if (attempt < attempts - 1) await this.backoff(attempt);
			}
		}
		await this.recordDeadLetter(trigger, event, lastError, attempts);
		return false;
	}

	private graphFor(name: string): Graph<S> {
		let g = this.graphs.get(name);
		if (g === undefined) {
			g = this.graph.withEventSource(`trigger:${name}`);
			this.graphs.set(name, g);
		}
		return g;
	}

	/** Full-jitter exponential backoff, capped at 64× the base — mirrors graph.ts's write retry. */
	private backoff(attempt: number): Promise<void> {
		const base = this.backoffMs * Math.min(2 ** attempt, 64);
		return sleep(base + Math.random() * base);
	}

	private async recordDeadLetter(
		trigger: Trigger<S>,
		event: GraphEvent,
		error: string,
		attempts: number,
	): Promise<void> {
		await this.graph.raw.execute({
			sql: `INSERT INTO trigger_dead_letters
					(id, subscription, trigger_name, seq, event, error, attempts, created_at)
				VALUES (?,?,?,?,?,?,?,?)`,
			args: [
				ulid(),
				this.name,
				trigger.name,
				event.seq ?? 0,
				JSON.stringify(event),
				error,
				attempts,
				Date.now(),
			],
		});
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/test/triggers.test.ts`
Expected: PASS (12 tests).

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/triggers.test.ts`
Expected: PASS, with the mid-batch-kill test skipped.

- [ ] **Step 5: Correct the spec's `runOnce` signature**

The spec wrote `runOnce(): Promise<{ delivered, deadLettered, cursor: number | null }>`. The implementation returns the persisted cursor plus a `drained` flag, which is what the poll loop in Task 6 needs. Update that line in `docs/superpowers/specs/2026-07-27-graph-event-triggers-design.md` to:

```ts
  runOnce(): Promise<{ delivered: number; deadLettered: number; cursor: number; drained: boolean }>;
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/triggers.ts packages/core/test/triggers.test.ts \
        docs/superpowers/specs/2026-07-27-graph-event-triggers-design.md
git commit -m "feat(triggers): durable runner with retries, dead letters and cursor resume"
```

---

### Task 5: Bounded concurrency

Trades strict ordering for throughput above `concurrency: 1`, with batch-end checkpointing.

**Files:**
- Modify: `packages/core/src/triggers.ts`
- Test: `packages/core/test/triggers.test.ts`

**Interfaces:**
- Consumes: the Task 4 runner internals.
- Produces: no new exports — `TriggerRunnerOptions.concurrency` becomes functional.

- [ ] **Step 1: Write the failing tests**

```ts
test('concurrency dispatches in parallel up to the bound and still drains the page', async () => {
	const g = await makeGraph();
	const ids: string[] = [];
	for (let i = 0; i < 6; i++) {
		ids.push((await g.addNode({ type: 'person', data: { name: `p${i}` } })).id);
	}

	let inFlight = 0;
	let peak = 0;
	const seen: string[] = [];
	const runner = new TriggerRunner(g, {
		name: 'sub-conc',
		start: 'beginning',
		concurrency: 3,
		triggers: [
			{
				name: 'record',
				match: {},
				action: async (e) => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await new Promise((r) => setTimeout(r, 5));
					seen.push(e.id);
					inFlight--;
				},
			},
		],
	});

	const result = await runner.runOnce();
	expect(result.delivered).toBe(6);
	expect(seen.sort()).toEqual([...ids].sort());
	expect(peak).toBeGreaterThan(1);
	expect(peak).toBeLessThanOrEqual(3);
});

test('concurrent batches still checkpoint, so a restart delivers nothing twice', async () => {
	const g = await makeGraph();
	for (let i = 0; i < 4; i++) await g.addNode({ type: 'person', data: { name: `p${i}` } });

	const first: string[] = [];
	await new TriggerRunner(g, {
		name: 'sub-conc-cursor',
		start: 'beginning',
		concurrency: 2,
		triggers: [{ name: 'record', match: {}, action: (e) => void first.push(e.id) }],
	}).runOnce();
	expect(first).toHaveLength(4);

	const second: string[] = [];
	await new TriggerRunner(g, {
		name: 'sub-conc-cursor',
		start: 'beginning',
		concurrency: 2,
		triggers: [{ name: 'record', match: {}, action: (e) => void second.push(e.id) }],
	}).runOnce();
	expect(second).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/triggers.test.ts -t concurrency`
Expected: FAIL — `peak` is 1, because dispatch is still serial.

- [ ] **Step 3: Implement the bounded pool and the two checkpoint policies**

Add the helper near the bottom of `packages/core/src/triggers.ts`:

```ts
/**
 * Run `tasks` with at most `limit` in flight. Results keep input order; completion order does not,
 * which is exactly the ordering guarantee `concurrency > 1` gives up.
 */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	const out: T[] = new Array(tasks.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
		for (let i = next++; i < tasks.length; i = next++) {
			out[i] = await (tasks[i] as () => Promise<T>)();
		}
	});
	await Promise.all(workers);
	return out;
}
```

Replace the loop in `runOnce` with a branch on the bound:

```ts
		let delivered = 0;
		let deadLettered = 0;
		if (this.concurrency === 1) {
			// Serial: completions are already in `seq` order, so checkpointing per event is free
			// correctness — an interrupted cycle resumes at the first event it had not finished.
			for (const event of page.events) {
				const outcome = await this.dispatch(event);
				delivered += outcome.delivered;
				deadLettered += outcome.deadLettered;
				this.cursor = event.seq as number;
				await this.saveCursor(this.cursor);
			}
		} else if (page.events.length > 0) {
			// Parallel: completions are unordered, so the cursor can only move once the whole page
			// has resolved. An interrupted cycle redelivers the page — at-least-once, `seq` dedupes.
			const outcomes = await pool(
				page.events.map((event) => () => this.dispatch(event)),
				this.concurrency,
			);
			for (const outcome of outcomes) {
				delivered += outcome.delivered;
				deadLettered += outcome.deadLettered;
			}
			this.cursor = page.events[page.events.length - 1]?.seq as number;
			await this.saveCursor(this.cursor);
		}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/test/triggers.test.ts`
Expected: PASS (14 tests).

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/triggers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/triggers.ts packages/core/test/triggers.test.ts
git commit -m "feat(triggers): bounded-concurrency dispatch with batch-end checkpointing"
```

---

### Task 6: The poll loop

`start()`/`stop()` around `runOnce()`.

**Files:**
- Modify: `packages/core/src/triggers.ts`
- Test: `packages/core/test/triggers.test.ts`

**Interfaces:**
- Consumes: `runOnce()`.
- Produces: `TriggerRunner.start(): void`, `TriggerRunner.stop(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
test('start polls until stopped, and stop actually stops', async () => {
	const g = await makeGraph();
	const seen: string[] = [];
	let resolveSeen: (id: string) => void = () => {};
	const firstSeen = new Promise<string>((r) => {
		resolveSeen = r;
	});
	const runner = new TriggerRunner(g, {
		name: 'sub-loop',
		start: 'beginning',
		pollIntervalMs: 5,
		triggers: [
			{
				name: 'record',
				match: {},
				action: (e) => {
					seen.push(e.id);
					resolveSeen(e.id);
				},
			},
		],
	});

	runner.start();
	runner.start(); // idempotent — a second call must not spawn a second loop
	const node = await g.addNode({ type: 'person', data: { name: 'live' } });
	expect(await firstSeen).toBe(node.id);
	await runner.stop();

	// One delivery, not two: the second start() did not spawn a competing loop.
	expect(seen).toEqual([node.id]);

	// Stopped means stopped — a later write is never picked up.
	await g.addNode({ type: 'person', data: { name: 'ignored' } });
	await new Promise((r) => setTimeout(r, 50));
	expect(seen).toEqual([node.id]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/test/triggers.test.ts -t 'start polls'`
Expected: FAIL — `runner.start is not a function`.

- [ ] **Step 3: Implement the loop**

Add two fields and two methods to `TriggerRunner`:

```ts
	/** Set by {@link start}, cleared by {@link stop}. */
	private running = false;
	/** The in-flight poll loop, awaited by {@link stop}. */
	private loop: Promise<void> | undefined;
```

```ts
	/** Begin polling in the background. Idempotent — a second call is a no-op. */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.loop = this.pump();
	}

	/** Stop polling and wait for the current cycle to finish. */
	async stop(): Promise<void> {
		this.running = false;
		await this.loop;
		this.loop = undefined;
	}

	/**
	 * The poll loop. A thrown cycle (a DB blip, a closed client) backs off and retries rather than
	 * killing the loop — the cursor is durable, so nothing is lost by trying again.
	 */
	private async pump(): Promise<void> {
		while (this.running) {
			try {
				const result = await this.runOnce();
				if (result.drained) await sleep(this.pollIntervalMs);
			} catch {
				await sleep(this.pollIntervalMs);
			}
		}
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/test/triggers.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/triggers.ts packages/core/test/triggers.test.ts
git commit -m "feat(triggers): background poll loop with start/stop"
```

---

### Task 7: The webhook action

**Files:**
- Modify: `packages/core/src/triggers.ts`
- Test: `packages/core/test/triggers.test.ts`

**Interfaces:**
- Consumes: `TriggerAction<S>`.
- Produces: `WebhookOptions`, `webhookAction<S>(opts): TriggerAction<S>`.

- [ ] **Step 1: Write the failing tests**

Add `webhookAction` to the `../src/triggers.ts` import.

```ts
interface Captured {
	body: string;
	headers: Record<string, string>;
}

/** A throwaway HTTP server that records requests and replies with `status` (or 200). */
function captureServer(status: () => number): {
	url: string;
	requests: Captured[];
	close: () => void;
} {
	const requests: Captured[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			requests.push({
				body: await req.text(),
				headers: Object.fromEntries(req.headers.entries()),
			});
			return new Response('', { status: status() });
		},
	});
	return {
		url: `http://localhost:${server.port}/hook`,
		requests,
		close: () => server.stop(true),
	};
}

test('webhook delivers a signed payload on a 2xx', async () => {
	const g = await makeGraph();
	const hook = captureServer(() => 200);
	try {
		const runner = new TriggerRunner(g, {
			name: 'sub-hook',
			start: 'beginning',
			triggers: [
				{
					name: 'notify',
					match: { op: 'node.create' },
					action: webhookAction({
						url: hook.url,
						secret: 'shh',
						headers: { 'x-custom': 'yes' },
					}),
				},
			],
		});
		const node = await g.addNode({ type: 'person', data: { name: 'seed' } });
		expect((await runner.runOnce()).delivered).toBe(1);

		expect(hook.requests).toHaveLength(1);
		const req = hook.requests[0] as Captured;
		expect(JSON.parse(req.body).id).toBe(node.id);
		expect(req.headers['x-graphx-event']).toBe('node.create');
		expect(req.headers['x-custom']).toBe('yes');
		expect(Number(req.headers['x-graphx-seq'])).toBeGreaterThan(0);

		// The signature is an HMAC-SHA256 over the exact body.
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode('shh'),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(req.body));
		const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
		expect(req.headers['x-graphx-signature']).toBe(`sha256=${hex}`);
	} finally {
		hook.close();
	}
});

test('webhook retries a non-2xx and dead-letters when the attempts run out', async () => {
	const g = await makeGraph();
	const hook = captureServer(() => 500);
	try {
		const runner = new TriggerRunner(g, {
			name: 'sub-hook-fail',
			start: 'beginning',
			retries: 2,
			backoffMs: 1,
			triggers: [
				{ name: 'notify', match: { op: 'node.create' }, action: webhookAction({ url: hook.url }) },
			],
		});
		await g.addNode({ type: 'person', data: { name: 'seed' } });
		const result = await runner.runOnce();

		expect(result.deadLettered).toBe(1);
		expect(hook.requests).toHaveLength(2); // retried once
		const dl = await deadLetters(g.raw, { subscription: 'sub-hook-fail' });
		expect(dl[0]?.error).toContain('500');
	} finally {
		hook.close();
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/triggers.test.ts -t webhook`
Expected: FAIL — `webhookAction` is not exported by `../src/triggers.ts`.

- [ ] **Step 3: Implement the action factory**

Add to `packages/core/src/triggers.ts`:

```ts
/** Configuration for {@link webhookAction}. */
export interface WebhookOptions {
	url: string;
	/** Extra request headers. Cannot override `x-graphx-signature`. */
	headers?: Record<string, string>;
	/** HMAC-SHA256 key. Omit to send an unsigned payload. */
	secret?: string;
	/** Request timeout. Default 10s — a hung endpoint must not hold the subscription open. */
	timeoutMs?: number;
}

/** Lowercase-hex HMAC-SHA256 of `body` under `secret`, via WebCrypto (no dependency). */
async function sign(secret: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST the event as JSON to `url`. A non-2xx or a timeout throws, which hands retry, backoff and
 * dead-lettering to the runner. Receivers verify `x-graphx-signature` against the RAW body and
 * dedupe on `x-graphx-seq` — delivery is at-least-once.
 */
export function webhookAction<S extends GraphSchema>(opts: WebhookOptions): TriggerAction<S> {
	return async (event) => {
		const body = JSON.stringify(event);
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'x-graphx-event': event.op,
			'x-graphx-seq': String(event.seq ?? ''),
			...opts.headers,
		};
		if (opts.secret !== undefined) {
			headers['x-graphx-signature'] = `sha256=${await sign(opts.secret, body)}`;
		}
		const res = await fetch(opts.url, {
			method: 'POST',
			headers,
			body,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
		});
		if (!res.ok) {
			throw new Error(`webhookAction: ${opts.url} responded ${res.status}`);
		}
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/test/triggers.test.ts`
Expected: PASS (17 tests).

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/triggers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/triggers.ts packages/core/test/triggers.test.ts
git commit -m "feat(triggers): signed webhook action"
```

---

### Task 8: Public exports and the `graphx triggers` command

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: the `@graphx/core` public trigger surface; `parseTriggersArgs(argv): ParsedTriggersArgs`; the `triggers` subcommand.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/cli.test.ts`, matching the file's existing import and test style:

```ts
test('parseTriggersArgs defaults the config path and honours -c', () => {
	expect(parseTriggersArgs(['triggers'])).toEqual({ config: './graphx.config.ts' });
	expect(parseTriggersArgs(['triggers', '-c', './other.config.ts'])).toEqual({
		config: './other.config.ts',
	});
	expect(parseTriggersArgs(['triggers', '--config', './x.ts'])).toEqual({ config: './x.ts' });
});
```

Add `parseTriggersArgs` to the existing `@graphx/cli` / `../src/cli.ts` import in that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/test/cli.test.ts -t parseTriggersArgs`
Expected: FAIL — `parseTriggersArgs` is not exported.

- [ ] **Step 3: Export the trigger surface from core**

In `packages/core/src/index.ts`, after the existing eventing export block:

```ts
// Eventing Layer 3 — declarative triggers over the durable outbox (triggers.ts)
export {
	type DeadLetter,
	deadLetters,
	type DeadLetterOpts,
	matchesTrigger,
	pruneDeadLetters,
	type Trigger,
	type TriggerAction,
	type TriggerBatchResult,
	type TriggerMatch,
	TriggerRunner,
	type TriggerRunnerOptions,
	webhookAction,
	type WebhookOptions,
} from './triggers.ts';
```

- [ ] **Step 4: Add the CLI command**

In `packages/cli/src/cli.ts`, extend the `@graphx/core` imports with `TriggerRunner`, `type Trigger`, and `type TriggerRunnerOptions`.

Add the arg parser beside `parseServeArgs`:

```ts
export interface ParsedTriggersArgs {
	config: string;
}

export function parseTriggersArgs(argv: string[]): ParsedTriggersArgs {
	const { values } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c', default: './graphx.config.ts' },
		},
	});
	return { config: (values.config as string | undefined) ?? './graphx.config.ts' };
}
```

Extend `GraphxConfig`:

```ts
interface GraphxConfig {
	schema: GraphSchema;
	embed: EmbedFn;
	db?: DbConfig;
	dim?: number;
	namespace?: string;
	/** Rules run by `graphx triggers`. Functions, so they live in the config module, not the DB. */
	triggers?: Trigger<GraphSchema>[];
	/** Runner tuning. `name` defaults to 'graphx' — the `trigger_cursors` key. */
	triggerRunner?: Partial<Omit<TriggerRunnerOptions<GraphSchema>, 'triggers'>>;
}
```

Add the command, beside `runServe`:

```ts
/**
 * `graphx triggers` — host the durable trigger runner. Triggers are functions, so they come from
 * the config module rather than the database; the runner keeps its cursor in `trigger_cursors`, so
 * restarting this process resumes where it left off instead of replaying or skipping.
 */
async function runTriggers(argv: string[]): Promise<void> {
	const args = parseTriggersArgs(argv);
	const cfg = await loadConfig(args.config);
	if (!cfg.triggers || cfg.triggers.length === 0) {
		throw new Error(`triggers: ${args.config} exports no \`triggers\` — nothing to run`);
	}
	const client = getDb(cfg.namespace ?? 'graphx', cfg.db ?? {});
	await init(client, cfg.dim);
	// The outbox is the substrate triggers read; without it there is nothing to tail.
	const graph = new Graph(client, cfg.schema, undefined, { outbox: true });
	const name = cfg.triggerRunner?.name ?? 'graphx';
	const runner = new TriggerRunner(graph, { ...cfg.triggerRunner, name, triggers: cfg.triggers });

	runner.start();
	console.log(
		`graphx triggers running — subscription '${name}', ${cfg.triggers.length} trigger(s)\n` +
			`  ${cfg.triggers.map((t) => t.name).join(', ')}`,
	);
	await new Promise<void>((resolve) => process.once('SIGINT', resolve));
	await runner.stop();
}
```

Register it in `run`'s switch, after `case 'serve'`:

```ts
		case 'triggers':
			return runTriggers(argv);
```

Extend `USAGE` — one line in the command list and a new options block after the serve one:

```
  graphx triggers [options]       Run declarative triggers over the event outbox
```

```
triggers options:
  --config, -c <path>     Path to config file (default: ./graphx.config.ts)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/cli/test/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and both type checks**

Run: `bun test && bun run lint && bun run type-check`
Expected: PASS.

Run: `GRAPHX_TEST_DRIVER=postgres bun test`
Expected: PASS (with the documented libSQL-only skips).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/cli/src/cli.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): graphx triggers command, export the trigger surface"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: data model → Tasks 1 and 2; `graph.ts` changes → Task 1; API surface → Tasks 2 (dead letters), 3 (matcher), 4 (runner), 6 (loop), 7 (webhook); runner semantics → Tasks 4 and 5; delivery guarantees → documented in the `triggers.ts` module header (Task 2) and the `runOnce`/pool comments (Tasks 4 and 5); multi-tenancy → the module header, and structurally guaranteed by the per-`Graph` constructor; CLI → Task 8; every listed test → Tasks 1 and 3–7. The spec's non-goals are absent from the plan, as intended.

**Signature consistency.** `matchesTrigger`, `withEventSource`, `TriggerRunner.runOnce/start/stop`, `deadLetters`, `pruneDeadLetters`, and `webhookAction` are named identically wherever they appear. The one intentional divergence from the spec is `runOnce`'s return shape, corrected in the spec at Task 4 Step 5.

**Ordering.** Task 4's tests use `deadLetters` from Task 2 and `matchesTrigger` from Task 3; Task 7's use `TriggerRunner` from Task 4. Tasks must run in order.
