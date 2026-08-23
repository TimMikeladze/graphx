# graphx/auth — P3 (Hierarchy + Set-Ops) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend P2 with **tuple-to-userset** (`tupleToUserset('parent','viewer')` — recursive folder/hierarchy inheritance) and **set-ops** (`.and` intersection, `.minus` exclusion), completing Zanzibar's rewrite expressiveness.

**Architecture:** Pure model + evaluator additions — **no store changes** (ttu tuples like `doc#parent@folder:1` are ordinary direct tuples; set-ops are evaluated, not stored). `RewriteExpr` gains `ttu`, `intersection`, `exclusion`. The builder gains `.and`/`.minus` and `.or` now accepts a `tupleToUserset(...)`. The recursive evaluator (`check.ts`) gains three cases; ttu recursion (climbing the parent chain) reuses the existing memo + cycle guard.

**Tech Stack:** TypeScript, bun (`bun test`), zod, @libsql/client, `core` workspace. Builds on `packages/auth` (P1+P2).

---

## Conventions (same as P1/P2)

- `bun test`; `{ expect, test } from 'bun:test'`. Import core via `../../core/src/index.ts`; `.ts` extensions.
- **isolatedDeclarations ON** — exported decls need explicit return types referencing exported/nameable types.
- Fresh DB: `createClient({ url: ':memory:' })` → `init(client, 4)` → `new Graph(client, model.schema)`.
- **Do NOT run `bun run format`** (whole-repo oxfmt dirties `packages/graphx`). Use `bun run lint`; format only the package if needed: `bunx oxfmt packages/auth`.
- After each task: `bun test packages/auth` green. **Do not commit** unless the human asks.

## Tuple→edge recap (the ttu direction — get this right)

Tuple `doc:42#parent@folder:1` (object=`doc:42`, relation=`parent`, subject=`folder:1`) → edge `{src:'folder:1', rel:'parent', dst:'doc:42'}`. So the **parents of an object** = the `src` of edges INTO `(object, 'parent')`. The existing `edgesInto(object, relation)` (P2, `WHERE dst=? AND rel=?`) returns exactly those `src` values. ttu evaluates `computed` on each parent.

## Files changed

```
packages/graphx/src/auth/
  model.ts    — MODIFY: RewriteExpr += ttu/intersection/exclusion; builder .and/.minus + .or(ttu); tupleToUserset(); validation
  check.ts    — MODIFY: evalExpr handles ttu / intersection / exclusion
  index.ts    — MODIFY: export tupleToUserset + Operand type
  auth.ts     — UNCHANGED (ttu/set-op relations are written as ordinary tuples; check delegates as before)
  store.ts    — UNCHANGED
  test/
    p3-model.test.ts   — CREATE
    p3-check.test.ts   — CREATE
```

---

## Task 1: Extend the model — ttu + set-ops (`model.ts`)

`RewriteExpr` gains three node kinds. The builder accumulates positive terms (`self` + `.or`), intersections (`.and`), and subtractions (`.minus`) with fixed precedence: **`(self ∪ or-terms) ∩ and-terms − minus-terms`**. `tupleToUserset(tupleset, computed)` returns a ttu node usable as an operand to `.or`/`.and`/`.minus`. Validation: a `computed` operand must name a same-type relation; a ttu's `tupleset` must name a same-type relation (its `computed` is evaluated on the parent's type at runtime, so it is not checked here).

**Files:**

- Modify: `packages/graphx/src/auth/model.ts`
- Test: `packages/graphx/test/auth/p3-model.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/graphx/test/auth/p3-model.test.ts`

```typescript
import { expect, test } from 'bun:test';
import { defineAuthModel, rel, tupleToUserset } from '../src/model.ts';

test('P3: tupleToUserset compiles to a ttu node inside the union', () => {
	const m = defineAuthModel({
		user: {},
		folder: { parent: rel(), editor: rel(), viewer: rel().or(tupleToUserset('parent', 'viewer')) },
	});
	expect(m.rewrite('folder', 'viewer')).toEqual({
		kind: 'union',
		children: [{ kind: 'self' }, { kind: 'ttu', tupleset: 'parent', computed: 'viewer' }],
	});
});

test('P3: full chain — (self ∪ editor ∪ ttu) − banned', () => {
	const m = defineAuthModel({
		user: {},
		folder: { parent: rel(), editor: rel(), viewer: rel().or('editor') },
		doc: {
			parent: rel(),
			editor: rel(),
			banned: rel(),
			viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')).minus('banned'),
		},
	});
	expect(m.rewrite('doc', 'viewer')).toEqual({
		kind: 'exclusion',
		base: {
			kind: 'union',
			children: [
				{ kind: 'self' },
				{ kind: 'computed', relation: 'editor' },
				{ kind: 'ttu', tupleset: 'parent', computed: 'viewer' },
			],
		},
		subtract: { kind: 'computed', relation: 'banned' },
	});
});

test('P3: .and compiles to intersection', () => {
	const m = defineAuthModel({ user: {}, doc: { reviewer: rel(), gated: rel().and('reviewer') } });
	expect(m.rewrite('doc', 'gated')).toEqual({
		kind: 'intersection',
		children: [{ kind: 'self' }, { kind: 'computed', relation: 'reviewer' }],
	});
});

test('P3: validation — ttu with an unknown tupleset relation throws', () => {
	expect(() =>
		defineAuthModel({ user: {}, doc: { viewer: rel().or(tupleToUserset('parent', 'viewer')) } }),
	).toThrow(/unknown tupleset relation/);
});

test('P3: validation — computed operand to an unknown relation still throws', () => {
	expect(() => defineAuthModel({ user: {}, doc: { gated: rel().and('reviewer') } })).toThrow(
		/references unknown relation/,
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p3-model.test.ts`
Expected: FAIL — `tupleToUserset`/`.and`/`.minus` not exported / shapes mismatch.

- [ ] **Step 3: Replace `packages/graphx/src/auth/model.ts`**

```typescript
import { z } from 'zod';
import {
	defineGraphSchema,
	type EdgeDef,
	type GraphSchema,
	type ZObj,
} from '../../core/src/index.ts';

/**
 * A userset rewrite expression.
 * - `self`         — direct tuples on (object, relation)
 * - `computed`     — same object, another relation
 * - `ttu`          — follow `tupleset` edges to parent objects, then `computed` on each
 * - `union` / `intersection` / `exclusion` — set operators
 */
export type RewriteExpr =
	| { kind: 'self' }
	| { kind: 'computed'; relation: string }
	| { kind: 'ttu'; tupleset: string; computed: string }
	| { kind: 'union'; children: RewriteExpr[] }
	| { kind: 'intersection'; children: RewriteExpr[] }
	| { kind: 'exclusion'; base: RewriteExpr; subtract: RewriteExpr };

/** An operand to a set operator: a relation name (computed userset) or a {@link tupleToUserset}. */
export type Operand = string | RewriteExpr;

/**
 * One relation's definition and builder. A bare `rel()` is direct tuples (`self`).
 * Operators combine with fixed precedence: `(self ∪ or) ∩ and − minus`.
 */
export interface Relation {
	rewrite: RewriteExpr;
	/** Mark direct tuples included (default). */
	self(): Relation;
	/** Union: also holders of `term` on the same object (string) or via a ttu. */
	or(term: Operand): Relation;
	/** Intersection: must ALSO satisfy `term`. */
	and(term: Operand): Relation;
	/** Exclusion: must NOT satisfy `term`. */
	minus(term: Operand): Relation;
}

/** Model spec: object type → its relations. A type with no relations (e.g. `user`) is `{}`. */
export type ModelSpec = Record<string, Record<string, Relation>>;

/** A compiled authorization model: lookups + the graphx schema its tuples are stored under. */
export interface AuthModel {
	spec: ModelSpec;
	types: string[];
	relationsOf(type: string): string[];
	rewrite(type: string, relation: string): RewriteExpr;
	schema: GraphSchema;
}

/** Follow `tupleset` edges from the object to parent objects, then evaluate `computed` on each. */
export function tupleToUserset(tupleset: string, computed: string): RewriteExpr {
	return { kind: 'ttu', tupleset, computed };
}

function toExpr(term: Operand): RewriteExpr {
	return typeof term === 'string' ? { kind: 'computed', relation: term } : term;
}

class RelationBuilder implements Relation {
	private readonly orTerms: RewriteExpr[] = [];
	private readonly andTerms: RewriteExpr[] = [];
	private readonly minusTerms: RewriteExpr[] = [];
	self(): Relation {
		return this;
	}
	or(term: Operand): Relation {
		this.orTerms.push(toExpr(term));
		return this;
	}
	and(term: Operand): Relation {
		this.andTerms.push(toExpr(term));
		return this;
	}
	minus(term: Operand): Relation {
		this.minusTerms.push(toExpr(term));
		return this;
	}
	get rewrite(): RewriteExpr {
		const positives: RewriteExpr[] = [{ kind: 'self' }, ...this.orTerms];
		let expr: RewriteExpr =
			positives.length === 1 ? { kind: 'self' } : { kind: 'union', children: positives };
		if (this.andTerms.length > 0) {
			expr = { kind: 'intersection', children: [expr, ...this.andTerms] };
		}
		for (const m of this.minusTerms) {
			expr = { kind: 'exclusion', base: expr, subtract: m };
		}
		return expr;
	}
}

/** Declare a relation. Chain `.or`/`.and`/`.minus` (with `tupleToUserset` operands) for set rewrites. */
export function rel(): Relation {
	return new RelationBuilder();
}

/** Validate every same-type reference in a rewrite tree; throws on an unknown relation/tupleset. */
function validateRefs(
	expr: RewriteExpr,
	type: string,
	byType: Record<string, Relation>,
	relation: string,
): void {
	switch (expr.kind) {
		case 'self':
			return;
		case 'computed':
			if (!byType[expr.relation]) {
				throw new Error(
					`auth: relation '${relation}' on type '${type}' references unknown relation '${expr.relation}'`,
				);
			}
			return;
		case 'ttu':
			if (!byType[expr.tupleset]) {
				throw new Error(
					`auth: relation '${relation}' on type '${type}' references unknown tupleset relation '${expr.tupleset}'`,
				);
			}
			// `computed` is evaluated on the parent object's type at runtime — not checked here.
			return;
		case 'union':
		case 'intersection':
			for (const c of expr.children) validateRefs(c, type, byType, relation);
			return;
		case 'exclusion':
			validateRefs(expr.base, type, byType, relation);
			validateRefs(expr.subtract, type, byType, relation);
			return;
	}
}

/** Build an {@link AuthModel}, validate references, and compile its graphx schema. */
export function defineAuthModel(spec: ModelSpec): AuthModel {
	const types = Object.keys(spec);

	const nodes: Record<string, ZObj> = {};
	const edges: Record<string, EdgeDef<string>> = {};
	for (const type of types) {
		nodes[type] = z.object({});
		const byType = spec[type] ?? {};
		for (const relation of Object.keys(byType)) {
			edges[relation] = {};
			validateRefs(byType[relation]!.rewrite, type, byType, relation);
		}
	}
	const schema = defineGraphSchema({ nodes, edges }) as GraphSchema;

	return {
		spec,
		types,
		relationsOf: (type: string): string[] => Object.keys(spec[type] ?? {}),
		rewrite: (type: string, relation: string): RewriteExpr => {
			const byType = spec[type];
			if (!byType) throw new Error(`auth: unknown type '${type}'`);
			const r = byType[relation];
			if (!r) throw new Error(`auth: unknown relation '${relation}' on type '${type}'`);
			return r.rewrite;
		},
		schema,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p3-model.test.ts` then `bun test packages/graphx/test/auth/p1-model.test.ts packages/graphx/test/auth/p2-model.test.ts`
Expected: PASS all (P1/P2 model behavior preserved — bare `rel()`→`{kind:'self'}`, `.or('x')`→union(self,computed)).

- [ ] **Step 5: Commit** (skip if holding commits)

```bash
git add packages/graphx/src/auth/model.ts packages/graphx/test/auth/p3-model.test.ts
git commit -m "feat(auth): tuple-to-userset + set-ops in model DSL (P3)"
```

---

## Task 2: Evaluate ttu / intersection / exclusion (`check.ts`)

Three new `evalExpr` cases. `ttu` collects parents (`edgesInto(object, tupleset)` → each `src`) and checks `computed` on each (climbing the hierarchy via the existing `check` recursion + memo + cycle guard). `intersection` requires all children; `exclusion` is base-true AND subtract-false. All three reuse the one `asOf` snapshot.

**Files:**

- Modify: `packages/graphx/src/auth/check.ts`
- Test: covered by Task 3's `p3-check.test.ts` (exercised through `Auth.check`).

- [ ] **Step 1: Update `evalExpr` in `packages/graphx/src/auth/check.ts`**

Replace the `evalExpr` function with (adds `ttu`/`intersection`/`exclusion`; keeps `self`/`computed`/`union`):

```typescript
/** Evaluate one rewrite node under (object, relation, subject). */
async function evalExpr(
	ctx: CheckCtx,
	object: string,
	relation: string,
	subject: string,
	expr: RewriteExpr,
): Promise<boolean> {
	switch (expr.kind) {
		case 'self':
			return evalSelf(ctx, object, relation, subject);
		case 'computed':
			return check(ctx, object, expr.relation, subject);
		case 'ttu': {
			// Parents = objects this object's `tupleset` edges point to; check `computed` on each.
			for (const { src } of await edgesInto(ctx, object, expr.tupleset)) {
				if (await check(ctx, src, expr.computed, subject)) return true;
			}
			return false;
		}
		case 'union': {
			for (const child of expr.children) {
				if (await evalExpr(ctx, object, relation, subject, child)) return true;
			}
			return false;
		}
		case 'intersection': {
			for (const child of expr.children) {
				if (!(await evalExpr(ctx, object, relation, subject, child))) return false;
			}
			return true;
		}
		case 'exclusion':
			return (
				(await evalExpr(ctx, object, relation, subject, expr.base)) &&
				!(await evalExpr(ctx, object, relation, subject, expr.subtract))
			);
		default:
			throw new Error(`auth: unhandled rewrite '${(expr as { kind: string }).kind}'`);
	}
}
```

> No other change to `check.ts`. `edgesInto`, `evalSelf`, `check`, and `runCheck` are unchanged. The `default:` throw is now an unreachable exhaustiveness guard (all current kinds are handled).

- [ ] **Step 2: Type-check**

Run: `cd packages/auth && tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit** (skip if holding commits)

```bash
git add packages/graphx/src/auth/check.ts
git commit -m "feat(auth): evaluate ttu / intersection / exclusion (P3)"
```

---

## Task 3: Behavior tests + exports + green gate

Exercise hierarchy inheritance (single + recursive), exclusion (deny + non-over-deny), intersection, and ttu+asOf through `Auth`. Export the new public symbols.

**Files:**

- Modify: `packages/graphx/src/auth/index.ts`
- Test: `packages/graphx/test/auth/p3-check.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/graphx/test/auth/p3-check.test.ts`

```typescript
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import { defineAuthModel, rel, tupleToUserset } from '../src/model.ts';

const MODEL = defineAuthModel({
	user: {},
	folder: {
		parent: rel(),
		editor: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')),
	},
	doc: {
		parent: rel(),
		editor: rel(),
		banned: rel(),
		reviewer: rel(),
		viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')).minus('banned'),
		gated: rel().and('reviewer'), // self ∩ reviewer
	},
});

async function freshAuth(): Promise<{ db: Client; auth: Auth }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P3: ttu — doc inherits viewer from its parent folder', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:bob')).toBe(false);
	db.close();
});

test('P3: ttu — inheritance climbs the parent chain recursively', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:root', relation: 'viewer', subject: 'user:alice' },
		{ object: 'folder:1', relation: 'parent', subject: 'folder:root' },
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true); // doc → folder:1 → folder:root
	db.close();
});

test('P3: exclusion — banned overrides an otherwise-granted viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }, // editor ⇒ viewer
		{ object: 'doc:42', relation: 'banned', subject: 'user:alice' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // − banned
	db.close();
});

test('P3: exclusion does not over-deny — editor, not banned, is a viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	db.close();
});

test('P3: intersection — gated requires self AND reviewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'doc:42', relation: 'gated', subject: 'user:alice' }, // direct (self side)
		{ object: 'doc:42', relation: 'reviewer', subject: 'user:alice' },
	]);
	expect(await auth.check('doc:42', 'gated', 'user:alice')).toBe(true);

	await auth.write([{ object: 'doc:42', relation: 'gated', subject: 'user:bob' }]); // missing reviewer
	expect(await auth.check('doc:42', 'gated', 'user:bob')).toBe(false);
	db.close();
});

test('P3: ttu + asOf — inheritance visible before the parent link is revoked', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'folder:1', relation: 'viewer', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'parent', subject: 'folder:1' },
	]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'doc:42', relation: 'parent', subject: 'folder:1' }]); // unlink parent
	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: t1 })).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // live: no parent link
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p3-check.test.ts`
Expected: FAIL — `tupleToUserset` not exported from where the test imports it (it's imported from `../src/model.ts`, so this should resolve; the real first failure will be that `evalExpr` already handles the kinds — if Task 2 is done, these should PASS). If Task 2 is complete, run this step to CONFIRM green; if any test fails, it's a real evaluator bug — investigate, do not weaken the test.

- [ ] **Step 3: Update `packages/graphx/src/auth/index.ts`**

Add the new public symbols to the existing export block:

```typescript
export {
	type AuthModel,
	defineAuthModel,
	type ModelSpec,
	type Operand,
	rel,
	type Relation,
	type RewriteExpr,
	tupleToUserset,
} from './model.ts';
```

(Keep the other existing exports — `Auth`, `CheckOpts`, `Tuple`, `VERSION` — unchanged.)

- [ ] **Step 4: Full suite + type-check + lint**

Run: `bun test packages/auth`
Expected: PASS — P1+P2+P3 suites green.

Run: `cd packages/auth && tsc --noEmit`
Expected: no errors.

Run: `bun run lint` (NOT `bun run format`)
Expected: clean.

- [ ] **Step 5: Confirm core untouched**

Run: `git diff --name-only -- packages/graphx`
Expected: empty.

- [ ] **Step 6: Commit** (skip if holding commits)

```bash
git add packages/graphx/src/auth/index.ts packages/graphx/test/auth/p3-check.test.ts
git commit -m "feat(auth): P3 complete — hierarchy inheritance + set-ops green"
```

---

## Self-Review (completed during planning)

- **Spec coverage (P3 row):** tuple-to-userset (recursive hierarchy) → Tasks 1–2 + tests; set-ops ∪/∩/− → Task 1 builder + Task 2 evaluator + tests. ✅
- **No store changes:** ttu tuples are ordinary direct tuples; set-ops are evaluated. `store.ts` and `auth.ts` are untouched — confirmed against the existing write/check paths.
- **ttu direction:** `edgesInto(object, tupleset)` → `src` = parents (matches the tuple→edge mapping `subject→src`, so a `parent` tuple's subject is the parent). Verified against §1 of the spec.
- **Placeholders:** none — full code in every step.
- **Type consistency:** `RewriteExpr` union (6 kinds) produced by the builder + `tupleToUserset`, consumed by `evalExpr`'s switch (all 6 handled); `Operand = string | RewriteExpr` flows through `.or/.and/.minus` and `toExpr`. `validateRefs` covers all kinds.
- **Regression safety:** P1/P2 model + check behavior preserved (bare `rel()`→self; `.or('x')`→union; recursion/memo/cycle unchanged). Re-run of P1/P2 suites is in Task 1 Step 4 and Task 3 Step 4.
- **Zero-core-change** preserved; formatter trap flagged.
- **Deferred:** `expand` (P4); `listObjects` (P5); consistency tokens, subproblem cache, governance fan-out caps, `.rel()` single-query fast-path, `mountAuth` HTTP routes, packaging (P6).

## Out of scope for P3 (next plans)

| Next plan | Scope                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------- |
| P4        | `expand(object, relation)` → the full userset tree                                                |
| P5        | `listObjects(subject, relation, type)` (reverse-expand + verify)                                  |
| P6        | consistency tokens, subproblem cache, governance fan-out caps, `mountAuth` HTTP routes, packaging |
