# @graphx/auth — P5 (`listObjects`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `listObjects(subject, relation, type)` → the objects of `type` on which `subject` has `relation` (Zanzibar's reverse query), keyset-paginated.

**Architecture:** Candidate generation by **reachability**, then **verify with `check`** (the OpenFGA approach — exact, vs hand-derived reverse rules). Every grant path is a chain of `src→dst` edges from subject to object (direct, group, computed, and ttu `folder→doc` parent edges all point "forward" from the subject), so the candidate set = nodes forward-reachable from the subject (recursive CTE, cycle-safe via `UNION`), filtered to `type`. Each candidate is confirmed with the P1–P4 `check` (handles exclusion/intersection that reachability over-approximates). Keyset pagination by object id; bounded by a scan cap.

**Tech Stack:** TypeScript, bun (`bun test`), zod, @libsql/client, `core` workspace. Builds on `packages/auth` (P1–P4).

---

## Conventions (same as prior phases)

- `bun test`; `{ expect, test } from 'bun:test'`. Import core via `../../core/src/index.ts`; `.ts` extensions.
- **isolatedDeclarations ON** — exported decls need explicit return types referencing exported/nameable types.
- Fresh DB: `createClient({ url: ':memory:' })` → `init(client, 4)` → `new Graph(client, model.schema)`.
- **Do NOT run `bun run format`** (dirties `packages/core`). Use `bun run lint`; format only the package if needed.
- After each task: `bun test packages/auth` green. **Do not commit** unless the human asks.

## Why reachability + verify is correct

Edges are `subject --relation--> object` (src=subject, dst=object). Every rewrite rule is satisfied by tuples forming a `src→dst` chain from the subject to the object:

- direct: `alice --viewer--> doc`
- computed: `alice --editor--> doc` (editor ⇒ viewer)
- group: `alice --member--> group:eng --viewer--> doc`
- ttu: `alice --viewer--> folder:1 --parent--> doc` (the `parent` tuple `doc#parent@folder:1` is the edge `folder:1 --parent--> doc`)

So forward-reachable-from-subject is a **superset** of granted objects. Exclusion/intersection only _remove_ grants, never add unreachable ones. Therefore: enumerate reachable objects of `type` (over-approximate), then `check` each (exact). The recursive CTE uses `UNION` (dedups) so cycles terminate.

> **Perf note (deferred to P6):** this is O(reachable) `check` calls, each independent (its own memo). Bounded by `SCAN_CAP` per page. A materialized reverse index (Leopard-style) and shared memo across candidates are P6 optimizations. P5 prioritizes correctness.

## Files changed

```
packages/auth/src/
  list.ts     — CREATE: ListObjectsOpts/ListObjectsPage, reachableOfType (CTE), runListObjects (verify + paginate)
  auth.ts     — MODIFY: add Auth.listObjects
  index.ts    — MODIFY: export ListObjectsOpts, ListObjectsPage
  test/
    p5-list.test.ts   — CREATE
```

---

## Task 1: Candidate reachability + verify (`list.ts`, no pagination yet)

Implement the reachability CTE + verify loop. The public shape (`ListObjectsPage` with `objects` + `nextCursor`) is final from the start; this task ignores `limit`/`cursor` (returns all verified, `nextCursor: null`). Pagination is Task 2.

**Files:**

- Create: `packages/auth/src/list.ts`
- Modify: `packages/auth/src/auth.ts`, `packages/auth/src/index.ts`
- Test: `packages/auth/test/p5-list.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/auth/test/p5-list.test.ts`

```typescript
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import { defineAuthModel, rel, tupleToUserset } from '../src/model.ts';

const MODEL = defineAuthModel({
	user: {},
	group: { member: rel() },
	folder: {
		parent: rel(),
		editor: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')),
	},
	doc: {
		parent: rel(),
		editor: rel(),
		banned: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')).minus('banned'),
	},
});

async function freshAuth(): Promise<{ db: Client; auth: Auth }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P5: lists direct + computed + group + ttu grants, sorted; excludes banned & wrong type', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' }, // direct
		{ object: 'doc:2', relation: 'editor', subject: 'user:alice' }, // computed editor⇒viewer
		{ object: 'group:eng', relation: 'member', subject: 'user:alice' },
		{ object: 'doc:3', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' }, // group
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:4', relation: 'parent', subject: 'folder:1' }, // ttu inheritance
		{ object: 'doc:5', relation: 'editor', subject: 'user:alice' }, // editor ⇒ viewer ...
		{ object: 'doc:5', relation: 'banned', subject: 'user:alice' }, // ... but banned
	]);
	const page = await auth.listObjects('user:alice', 'viewer', 'doc');
	expect(page.objects).toEqual(['doc:1', 'doc:2', 'doc:3', 'doc:4']); // sorted; doc:5 excluded (banned)
	expect(page.nextCursor).toBeNull();
	db.close();
});

test('P5: type filter — listing folders returns only folders', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
	]);
	expect((await auth.listObjects('user:alice', 'viewer', 'folder')).objects).toEqual(['folder:1']);
	db.close();
});

test('P5: empty when the subject has no grants of that relation', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:1', relation: 'editor', subject: 'user:bob' }]);
	expect((await auth.listObjects('user:alice', 'viewer', 'doc')).objects).toEqual([]);
	db.close();
});

test('P5: respects asOf — a revoked grant is gone live but present in the past', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' }]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' }]);
	expect((await auth.listObjects('user:alice', 'viewer', 'doc', { asOf: t1 })).objects).toEqual([
		'doc:1',
	]);
	expect((await auth.listObjects('user:alice', 'viewer', 'doc')).objects).toEqual([]);
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/auth/test/p5-list.test.ts`
Expected: FAIL — `auth.listObjects` / `list.ts` not present.

- [ ] **Step 3: Create `packages/auth/src/list.ts`**

```typescript
import type { Client } from '@libsql/client';
import { runCheck } from './check.ts';
import type { AuthModel } from './model.ts';

/** Max candidate objects scanned per page call (governance bound; full §19.2 wiring is P6). */
const SCAN_CAP = 10000;
/** Default page size when `opts.limit` is omitted. */
const DEFAULT_LIMIT = 100;

/** Options for {@link Auth.listObjects}. */
export interface ListObjectsOpts {
	/** Evaluate as-of this epoch-ms instant. Omit ⇒ live (now). */
	asOf?: number;
	/** Page size (max objects returned). Default 100. */
	limit?: number;
	/** Opaque cursor from a prior page's `nextCursor` (the last object id). Omit for page 1. */
	cursor?: string;
}

/** One page of {@link Auth.listObjects}. */
export interface ListObjectsPage {
	objects: string[];
	/** `null` when this is the last page. */
	nextCursor: string | null;
}

/**
 * Forward-reachable nodes of `kind = type` from `subject` (recursive CTE over `src→dst`
 * edges; `UNION` dedups so cycles terminate). Returns ids `> after`, sorted ascending,
 * capped at `SCAN_CAP`. `asOf` undefined ⇒ live views; else the temporal `_versions`
 * tables with the half-open interval.
 */
async function reachableOfType(
	raw: Client,
	asOf: number | undefined,
	subject: string,
	type: string,
	after: string,
): Promise<string[]> {
	const sql =
		asOf === undefined
			? `WITH RECURSIVE reach(id) AS (
					SELECT ?
					UNION
					SELECT e.dst FROM edges e JOIN reach r ON e.src = r.id
				)
				SELECT n.id AS id FROM reach r JOIN nodes n ON n.id = r.id
				WHERE n.kind = ? AND n.id <> ? AND n.id > ?
				ORDER BY n.id LIMIT ?`
			: `WITH RECURSIVE reach(id) AS (
					SELECT ?
					UNION
					SELECT e.dst FROM edge_versions e JOIN reach r ON e.src = r.id
						WHERE e.valid_from <= ? AND e.valid_to > ?
				)
				SELECT n.id AS id FROM reach r JOIN node_versions n ON n.id = r.id
				WHERE n.kind = ? AND n.valid_from <= ? AND n.valid_to > ? AND n.id <> ? AND n.id > ?
				ORDER BY n.id LIMIT ?`;
	const args =
		asOf === undefined
			? [subject, type, subject, after, SCAN_CAP]
			: [subject, asOf, asOf, type, asOf, asOf, subject, after, SCAN_CAP];
	const r = await raw.execute({ sql, args });
	return r.rows.map((row) => String(row.id));
}

/**
 * List the objects of `type` on which `subject` has `relation`. Candidates = objects
 * forward-reachable from the subject (an over-approximation); each is confirmed with
 * `check` (exact — applies exclusion/intersection). Keyset-paginated by object id.
 *
 * NOTE: Task 1 ignores `limit`/`cursor` (returns all verified, `nextCursor: null`).
 * Task 2 implements pagination.
 */
export async function runListObjects(
	raw: Client,
	model: AuthModel,
	subject: string,
	relation: string,
	type: string,
	opts: ListObjectsOpts = {},
): Promise<ListObjectsPage> {
	const candidates = await reachableOfType(raw, opts.asOf, subject, type, '');
	const objects: string[] = [];
	for (const id of candidates) {
		if (await runCheck(raw, model, id, relation, subject, opts.asOf)) objects.push(id);
	}
	return { objects, nextCursor: null };
}
```

- [ ] **Step 4: Add `Auth.listObjects` to `packages/auth/src/auth.ts`**

Add the import (merge with existing imports):

```typescript
import { type ListObjectsOpts, type ListObjectsPage, runListObjects } from './list.ts';
```

Add the method to the `Auth` class (after `expand`):

```typescript
	/**
	 * List the objects of `type` on which `subject` has `relation`. Candidates are found by
	 * reachability and confirmed with `check` (exact). Keyset-paginated via `opts.limit`/`cursor`.
	 */
	listObjects(
		subject: string,
		relation: string,
		type: string,
		opts: ListObjectsOpts = {},
	): Promise<ListObjectsPage> {
		return runListObjects(this.raw, this.model, subject, relation, type, opts);
	}
```

- [ ] **Step 5: Export the new types from `packages/auth/src/index.ts`**

Add to the existing export block:

```typescript
export { type ListObjectsOpts, type ListObjectsPage } from './list.ts';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/auth/test/p5-list.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit** (skip if holding commits)

```bash
git add packages/auth/src/list.ts packages/auth/src/auth.ts packages/auth/src/index.ts packages/auth/test/p5-list.test.ts
git commit -m "feat(auth): listObjects — reachability candidates + verify (P5, unpaginated)"
```

---

## Task 2: Keyset pagination (`list.ts`)

Wire `limit` + `cursor` into `runListObjects`. Iterate candidates (already `> cursor`, sorted, capped); collect verified objects until `limit`; set `nextCursor` to the last returned id when the page fills, or to the last scanned id when the scan window is full (more may exist), else `null`.

**Files:**

- Modify: `packages/auth/src/list.ts`
- Test: `packages/auth/test/p5-list.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `packages/auth/test/p5-list.test.ts`

```typescript
test('P5: paginates by object id — limit then cursor walks the rest', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:2', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:3', relation: 'viewer', subject: 'user:alice' },
	]);
	const p1 = await auth.listObjects('user:alice', 'viewer', 'doc', { limit: 2 });
	expect(p1.objects).toEqual(['doc:1', 'doc:2']);
	expect(p1.nextCursor).toBe('doc:2');

	const p2 = await auth.listObjects('user:alice', 'viewer', 'doc', {
		limit: 2,
		cursor: p1.nextCursor!,
	});
	expect(p2.objects).toEqual(['doc:3']);
	expect(p2.nextCursor).toBeNull();
	db.close();
});

test('P5: limit ≥ result count returns everything with a null cursor', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:2', relation: 'viewer', subject: 'user:alice' },
	]);
	const page = await auth.listObjects('user:alice', 'viewer', 'doc', { limit: 10 });
	expect(page.objects).toEqual(['doc:1', 'doc:2']);
	expect(page.nextCursor).toBeNull();
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/auth/test/p5-list.test.ts`
Expected: FAIL — Task 1 ignores `limit`/`cursor`, so `p1.objects` has 3 items and `nextCursor` is null.

- [ ] **Step 3: Replace `runListObjects` in `packages/auth/src/list.ts`**

```typescript
export async function runListObjects(
	raw: Client,
	model: AuthModel,
	subject: string,
	relation: string,
	type: string,
	opts: ListObjectsOpts = {},
): Promise<ListObjectsPage> {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const after = opts.cursor ?? '';
	const candidates = await reachableOfType(raw, opts.asOf, subject, type, after);

	const objects: string[] = [];
	let nextCursor: string | null = null;
	for (const id of candidates) {
		if (await runCheck(raw, model, id, relation, subject, opts.asOf)) {
			objects.push(id);
			if (objects.length === limit) {
				nextCursor = id; // page full; resume after this id
				break;
			}
		}
	}
	// Scanned the whole window without filling the page, but the window was capped —
	// more candidates may exist beyond it, so hand back a cursor to continue.
	if (nextCursor === null && candidates.length === SCAN_CAP) {
		nextCursor = candidates[candidates.length - 1] ?? null;
	}
	return { objects, nextCursor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/auth/test/p5-list.test.ts`
Expected: PASS (6 tests — the 4 from Task 1 still green; `nextCursor` is null in those since results < default limit).

- [ ] **Step 5: Full suite + type-check + lint + scope check**

Run: `bun test packages/auth` → all P1–P5 green.
Run: `cd packages/auth && tsc --noEmit` → clean.
Run: `bun run lint` → clean (NOT `bun run format`).
Run: `git diff --name-only -- packages/core packages/auth/src/store.ts packages/auth/src/check.ts` → empty (P5 doesn't touch core, store, or check).

- [ ] **Step 6: Commit** (skip if holding commits)

```bash
git add packages/auth/src/list.ts packages/auth/test/p5-list.test.ts
git commit -m "feat(auth): keyset pagination for listObjects (P5 complete)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (P5 row):** `listObjects` via reverse-expand + verify → Task 1; keyset pagination → Task 2. ✅
- **Correctness argument:** reachability is a superset of grants (every rule is a `src→dst` chain from subject); `check` filters exactly (exclusion/intersection). `UNION` CTE is cycle-safe. Documented above + verified by the banned-exclusion and ttu tests.
- **No core/store/check change:** `list.ts` reads via its own CTE and reuses `runCheck`; `store.ts`/`check.ts` untouched; `auth.ts` gains one method. Scope check in Task 2 Step 5.
- **Placeholders:** none.
- **Type consistency:** `ListObjectsPage`/`ListObjectsOpts` defined in `list.ts`, returned by `runListObjects`, surfaced by `Auth.listObjects`, exported from `index.ts`. `reachableOfType(raw, asOf, subject, type, after)` signature stable across both tasks.
- **Pagination edge cases:** page-fills (nextCursor = last id), scan-cap-hit (nextCursor = last scanned), exhausted (null). The default-limit Task 1 tests stay valid (results < 100 ⇒ null cursor).
- **Zero-core-change** preserved; formatter trap flagged.
- **Deferred (P6):** consistency tokens, shared-memo across candidates + materialized reverse index (perf), governance fan-out caps wiring, `mountAuth` HTTP routes, packaging.

## Out of scope for P5 (final phase)

| Next plan | Scope                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6        | consistency tokens; subproblem cache + materialized reverse index (perf); governance fan-out caps; `mountAuth` HTTP routes on the serve.ts spine; packaging (publishable `@graphx/auth`, replace the relative `../../core/src` import) |
