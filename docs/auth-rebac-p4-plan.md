# graphx/auth — P4 (`expand`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `expand(object, relation)` → the **userset tree** for an object#relation (Zanzibar's Expand API) — the structural "who has this relation" answer, used for debugging/UI.

**Architecture:** A new `expand.ts` recurses over the same `RewriteExpr` tree as `check`, but instead of resolving a boolean for one subject it builds a `UsersetTree`: `self` → a leaf of direct subjects + userset references; `computed`/`ttu` → the expanded subtrees (rewrite-rule recursion, cycle-guarded); set-ops → the matching tree node. Leaf **usersets are NOT recursively resolved** (standard Expand semantics — `group:eng#member` is returned as a reference, bounded). To share the tuple-read query, P4 extracts `edgesInto` from `check.ts` into an exported helper.

**Tech Stack:** TypeScript, bun (`bun test`), zod, @libsql/client, `core` workspace. Builds on `packages/auth` (P1–P3).

---

## Conventions (same as prior phases)

- `bun test`; `{ expect, test } from 'bun:test'`. Import core via `../../core/src/index.ts`; `.ts` extensions.
- **isolatedDeclarations ON** — exported decls need explicit return types referencing exported/nameable types.
- Fresh DB: `createClient({ url: ':memory:' })` → `init(client, 4)` → `new Graph(client, model.schema)`.
- **Do NOT run `bun run format`** (dirties `packages/graphx`). Use `bun run lint`; format only the package if needed (`bunx oxfmt packages/auth`).
- After each task: `bun test packages/auth` green. **Do not commit** unless the human asks.

## Expand semantics (the P4 contract)

`expand(object, relation)` returns a `UsersetTree` mirroring the relation's rewrite:

- `self` → `{type:'leaf', subjects, usersets}` — `subjects` = direct edge `src`s (no subjectRelation); `usersets` = `{object: src, relation: subjectRelation}` for userset edges. **Leaf usersets are references, not expanded.**
- `computed(r)` → `expand(object, r)` (subtree of the other relation on the same object).
- `ttu(tupleset, computed)` → `{type:'union', children}` — one `expand(parentY, computed)` per parent `Y` (parents = `edgesInto(object, tupleset)` srcs). This recurses up a hierarchy.
- `union`/`intersection`/`exclusion` → the matching tree node with expanded children/base/subtract.

Cycle guard: a `(object#relation)` already on the expansion path expands to an **empty leaf** (`{type:'leaf', subjects:[], usersets:[]}`) to break the cycle. Determinism: `subjects`, `usersets`, and ttu parents are sorted so trees are stable for assertions. One `asOf` snapshot throughout.

## Files changed

```
packages/graphx/src/auth/
  check.ts    — MODIFY: extract + export `edgesInto(raw, asOf, object, relation)` (was a ctx-bound private)
  expand.ts   — CREATE: UsersetTree type + runExpand (recursive expansion + cycle guard)
  auth.ts     — MODIFY: add `Auth.expand(object, relation, opts?)`
  index.ts    — MODIFY: export `UsersetTree`
  test/
    p4-expand.test.ts   — CREATE
```

---

## Task 1: Extract + export `edgesInto` (`check.ts`)

`edgesInto` is currently a private taking the whole `CheckCtx`. `expand` needs the same query but has a different context, so lift it to a standalone exported helper taking `(raw, asOf, object, relation)`. Pure refactor — no behavior change.

**Files:**

- Modify: `packages/graphx/src/auth/check.ts`
- Test: existing P1–P3 suite is the regression test (no new test).

- [ ] **Step 1: Edit `packages/graphx/src/auth/check.ts`**

Replace the private `edgesInto` with an exported standalone helper (note the new signature — `raw`/`asOf` instead of `ctx`):

```typescript
/** Edges pointing INTO (object, relation): `subjectRelation` is null for direct grants. */
export async function edgesInto(
	raw: Client,
	asOf: number | undefined,
	object: string,
	relation: string,
): Promise<Array<{ src: string; subjectRelation: string | null }>> {
	const sql =
		asOf === undefined
			? `SELECT src, json_extract(props, '$.subjectRelation') AS sr FROM edges WHERE dst = ? AND rel = ?`
			: `SELECT src, json_extract(props, '$.subjectRelation') AS sr FROM edge_versions
				WHERE dst = ? AND rel = ? AND valid_from <= ? AND valid_to > ?`;
	const args = asOf === undefined ? [object, relation] : [object, relation, asOf, asOf];
	const r = await raw.execute({ sql, args });
	return r.rows.map((row) => ({
		src: String(row.src),
		subjectRelation: row.sr === null ? null : String(row.sr),
	}));
}
```

Update the two internal call sites to pass `ctx.raw, ctx.asOf`:

- In `evalSelf`: `for (const { src, subjectRelation } of await edgesInto(ctx.raw, ctx.asOf, object, relation)) {`
- In the `ttu` case of `evalExpr`: `for (const { src } of await edgesInto(ctx.raw, ctx.asOf, object, expr.tupleset)) {`

(Confirm `import type { Client } from '@libsql/client';` is present at the top of `check.ts` — it is, from P2.)

- [ ] **Step 2: Run the full auth suite to confirm no regression**

Run: `bun test packages/auth` then `cd packages/auth && tsc --noEmit`
Expected: PASS (47 tests, unchanged) and clean type-check. (This is a pure refactor — behavior must be identical.)

- [ ] **Step 3: Commit** (skip if holding commits)

```bash
git add packages/graphx/src/auth/check.ts
git commit -m "refactor(auth): export edgesInto as a standalone reader (P4 prep)"
```

---

## Task 2: `expand.ts` + `Auth.expand` + tests

**Files:**

- Create: `packages/graphx/src/auth/expand.ts`
- Modify: `packages/graphx/src/auth/auth.ts`, `packages/graphx/src/auth/index.ts`
- Test: `packages/graphx/test/auth/p4-expand.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/graphx/test/auth/p4-expand.test.ts`

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

test('P4: expand self → leaf of sorted direct subjects', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'editor', subject: 'user:bob' },
		{ object: 'doc:42', relation: 'editor', subject: 'user:alice' },
	]);
	expect(await auth.expand('doc:42', 'editor')).toEqual({
		type: 'leaf',
		subjects: ['user:alice', 'user:bob'],
		usersets: [],
	});
	db.close();
});

test('P4: expand self → userset subjects are leaf references (not resolved)', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'editor', subject: 'group:eng', subjectRelation: 'member' },
	]);
	expect(await auth.expand('doc:42', 'editor')).toEqual({
		type: 'leaf',
		subjects: [],
		usersets: [{ object: 'group:eng', relation: 'member' }],
	});
	db.close();
});

test('P4: expand a union(self, computed, ttu) relation — folder.viewer with no parent', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:carol' }, // self
		{ object: 'folder:1', relation: 'editor', subject: 'user:dan' }, // computed(editor)
	]);
	// folder.viewer = union(self, computed(editor), ttu(parent, viewer)); folder:1 has no parent
	expect(await auth.expand('folder:1', 'viewer')).toEqual({
		type: 'union',
		children: [
			{ type: 'leaf', subjects: ['user:carol'], usersets: [] }, // self
			{ type: 'leaf', subjects: ['user:dan'], usersets: [] }, // computed(editor)
			{ type: 'union', children: [] }, // ttu — no parents
		],
	});
	db.close();
});

test('P4: expand doc.viewer — exclusion over union, ttu pulls in the parent subtree', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'viewer', subject: 'user:bob' }, // self
		{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }, // computed(editor)
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' }, // ttu(parent, viewer)
		{ object: 'folder:1', relation: 'viewer', subject: 'user:carol' },
		{ object: 'doc:42', relation: 'banned', subject: 'user:eve' }, // subtract
	]);
	const tree = await auth.expand('doc:42', 'viewer');
	// top = exclusion(base=union[self, editor, ttu], subtract=banned-leaf)
	expect(tree.type).toBe('exclusion');
	if (tree.type !== 'exclusion') throw new Error('unreachable');
	expect(tree.subtract).toEqual({ type: 'leaf', subjects: ['user:eve'], usersets: [] });
	expect(tree.base.type).toBe('union');
	if (tree.base.type !== 'union') throw new Error('unreachable');
	expect(tree.base.children[0]).toEqual({ type: 'leaf', subjects: ['user:bob'], usersets: [] }); // self
	expect(tree.base.children[1]).toEqual({ type: 'leaf', subjects: ['user:alice'], usersets: [] }); // editor
	// ttu child: union of parent expansions → folder:1's viewer subtree
	expect(tree.base.children[2]).toEqual({
		type: 'union',
		children: [
			{
				type: 'union', // folder:1 viewer = union(self, computed editor, ttu)
				children: [
					{ type: 'leaf', subjects: ['user:carol'], usersets: [] },
					{ type: 'leaf', subjects: [], usersets: [] }, // folder:1 editor (none)
					{ type: 'union', children: [] }, // folder:1 has no parent
				],
			},
		],
	});
	db.close();
});

test('P4: expand terminates on a ttu parent cycle (empty leaf at the break)', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'parent', subject: 'folder:2' },
		{ object: 'folder:2', relation: 'parent', subject: 'folder:1' }, // cycle
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
	]);
	const tree = await auth.expand('folder:1', 'viewer'); // must not hang
	expect(tree.type).toBe('union');
	db.close();
});

test('P4: expand respects asOf', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	expect(await auth.expand('doc:42', 'editor', { asOf: t1 })).toEqual({
		type: 'leaf',
		subjects: ['user:alice'],
		usersets: [],
	});
	expect(await auth.expand('doc:42', 'editor')).toEqual({
		type: 'leaf',
		subjects: [],
		usersets: [],
	});
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p4-expand.test.ts`
Expected: FAIL — `auth.expand` / `expand.ts` not present.

- [ ] **Step 3: Create `packages/graphx/src/auth/expand.ts`**

```typescript
import type { Client } from '@libsql/client';
import { edgesInto } from './check.ts';
import type { AuthModel, RewriteExpr } from './model.ts';
import { typeOf } from './types.ts';

/** A userset tree (Zanzibar Expand). Leaf usersets are references — not recursively resolved. */
export type UsersetTree =
	| { type: 'leaf'; subjects: string[]; usersets: Array<{ object: string; relation: string }> }
	| { type: 'union'; children: UsersetTree[] }
	| { type: 'intersection'; children: UsersetTree[] }
	| { type: 'exclusion'; base: UsersetTree; subtract: UsersetTree };

interface ExpandCtx {
	raw: Client;
	model: AuthModel;
	asOf?: number;
	visited: Set<string>;
}

/** `self`: a leaf of direct subjects + userset references read from the tuples on (object, relation). */
async function expandSelf(ctx: ExpandCtx, object: string, relation: string): Promise<UsersetTree> {
	const subjects: string[] = [];
	const usersets: Array<{ object: string; relation: string }> = [];
	for (const { src, subjectRelation } of await edgesInto(ctx.raw, ctx.asOf, object, relation)) {
		if (subjectRelation === null) subjects.push(src);
		else usersets.push({ object: src, relation: subjectRelation });
	}
	subjects.sort();
	usersets.sort((a, b) => `${a.object}#${a.relation}`.localeCompare(`${b.object}#${b.relation}`));
	return { type: 'leaf', subjects, usersets };
}

/** Expand one rewrite node under (object, relation). */
async function expandExpr(
	ctx: ExpandCtx,
	object: string,
	relation: string,
	expr: RewriteExpr,
): Promise<UsersetTree> {
	switch (expr.kind) {
		case 'self':
			return expandSelf(ctx, object, relation);
		case 'computed':
			return expand(ctx, object, expr.relation);
		case 'ttu': {
			const parents = (await edgesInto(ctx.raw, ctx.asOf, object, expr.tupleset))
				.map((e) => e.src)
				.sort();
			const children: UsersetTree[] = [];
			for (const parent of parents) children.push(await expand(ctx, parent, expr.computed));
			return { type: 'union', children };
		}
		case 'union': {
			const children: UsersetTree[] = [];
			for (const c of expr.children) children.push(await expandExpr(ctx, object, relation, c));
			return { type: 'union', children };
		}
		case 'intersection': {
			const children: UsersetTree[] = [];
			for (const c of expr.children) children.push(await expandExpr(ctx, object, relation, c));
			return { type: 'intersection', children };
		}
		case 'exclusion':
			return {
				type: 'exclusion',
				base: await expandExpr(ctx, object, relation, expr.base),
				subtract: await expandExpr(ctx, object, relation, expr.subtract),
			};
		default:
			throw new Error(`auth: unhandled rewrite '${(expr as { kind: string }).kind}'`);
	}
}

/** Expand (object, relation) with a cycle guard (a revisited node yields an empty leaf). */
async function expand(ctx: ExpandCtx, object: string, relation: string): Promise<UsersetTree> {
	const key = `${object}#${relation}`;
	if (ctx.visited.has(key)) return { type: 'leaf', subjects: [], usersets: [] };
	ctx.visited.add(key);
	const expr = ctx.model.rewrite(typeOf(object), relation); // throws on unknown type/relation
	const tree = await expandExpr(ctx, object, relation, expr);
	ctx.visited.delete(key);
	return tree;
}

/** Entry point: expand (object, relation) into a userset tree at one `asOf` snapshot. */
export function runExpand(
	raw: Client,
	model: AuthModel,
	object: string,
	relation: string,
	asOf?: number,
): Promise<UsersetTree> {
	return expand({ raw, model, asOf, visited: new Set() }, object, relation);
}
```

- [ ] **Step 4: Add `Auth.expand` to `packages/graphx/src/auth/auth.ts`**

Add the import (with the existing `./check.ts` import — merge the named imports):

```typescript
import { runCheck } from './check.ts';
import { runExpand, type UsersetTree } from './expand.ts';
```

Add the method to the `Auth` class (after `check`):

```typescript
	/**
	 * Expand (object, relation) into its userset tree (Zanzibar Expand). Mirrors the rewrite
	 * structure; leaf usersets (`group:eng#member`) are references, not recursively resolved.
	 */
	expand(object: string, relation: string, opts: CheckOpts = {}): Promise<UsersetTree> {
		return runExpand(this.raw, this.model, object, relation, opts.asOf);
	}
```

(Reuses `CheckOpts` — it carries `asOf`, which is the only expand option.)

- [ ] **Step 5: Export `UsersetTree` from `packages/graphx/src/auth/index.ts`**

Add to the existing export block:

```typescript
export { type UsersetTree } from './expand.ts';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p4-expand.test.ts`
Expected: PASS (7 tests). If the big `doc.viewer` tree assertion fails, compare the actual tree to the expected structure in the test — the union child order follows the rewrite (`self`, then `.or` terms in declaration order), and ttu parents/leaf arrays are sorted.

- [ ] **Step 7: Full suite + type-check + lint + core untouched**

Run: `bun test packages/auth` → all P1–P4 green.
Run: `cd packages/auth && tsc --noEmit` → clean.
Run: `bun run lint` → clean (NOT `bun run format`).
Run: `git diff --name-only -- packages/graphx packages/graphx/src/auth/store.ts` → empty (P4 doesn't touch core or store).

- [ ] **Step 8: Commit** (skip if holding commits)

```bash
git add packages/graphx/src/auth/expand.ts packages/graphx/src/auth/auth.ts packages/graphx/src/auth/index.ts packages/graphx/test/auth/p4-expand.test.ts
git commit -m "feat(auth): expand(object, relation) → userset tree (P4)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (P4 row):** `expand(object, relation)` → userset tree → Task 2; reuse of the tuple reader → Task 1. ✅
- **Expand semantics:** rewrite-rule recursion (computed/ttu) expands; leaf usersets are references (bounded, standard Zanzibar). Cycle guard yields an empty leaf. Determinism via sorting. asOf honored.
- **No store change:** `expand` only reads via `edgesInto`; `store.ts` untouched. `auth.ts` gains one method; `check.ts` refactor is behavior-preserving (Task 1 re-runs the full suite).
- **Placeholders:** none.
- **Type consistency:** `UsersetTree` produced by `expandExpr`/`expandSelf`, returned by `runExpand`, surfaced by `Auth.expand`; `edgesInto(raw, asOf, object, relation)` new signature used by both `check.ts` (updated calls) and `expand.ts`.
- **Zero-core-change** preserved; formatter trap flagged.
- **Deferred:** `listObjects` (P5); consistency tokens, subproblem cache, governance fan-out caps, `mountAuth` HTTP routes, packaging (P6).

## Out of scope for P4 (next plans)

| Next plan | Scope                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------- |
| P5        | `listObjects(subject, relation, type)` — reverse-expand + verify, keyset-paginated                |
| P6        | consistency tokens, subproblem cache, governance fan-out caps, `mountAuth` HTTP routes, packaging |
