# @graphx/auth — P2 (Computed + Group Usersets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend P1 from direct-tuple checks to **computed usersets** (`viewer = self ∪ editor`) and **group usersets** (`doc#viewer@group:eng#member`), including recursively-nested group membership.

**Architecture:** The model DSL gains `.or('rel')` (computed userset); `RewriteExpr` becomes a union (`self | computed | union`). Userset subjects are stored on the edge as `props.subjectRelation`. `check` becomes a recursive descent over the rewrite tree (extracted into `check.ts`) with memoization + a cycle guard, all pinned to one `asOf` snapshot. Recursion through nested groups is handled by the evaluator; the single-query `.rel()` fast-path is deferred to a later phase (correctness first).

**Tech Stack:** TypeScript, bun (`bun test`), zod, @libsql/client, `core` workspace package. Builds on `packages/auth` (P1).

---

## Conventions (same as P1)

- `bun test`; tests import `{ expect, test } from 'bun:test'`. Import core via `../../core/src/index.ts`; intra-package imports use `.ts`.
- **isolatedDeclarations ON** — exported decls need explicit return types; return types must reference *exported/nameable* types (this is why `Relation` is an interface that includes the builder methods, not a private class).
- Fresh DB: `createClient({ url: ':memory:' })` → `init(client, 4)` → `new Graph(client, model.schema)`.
- `FOREVER` = `8640000000000000`. JSON props are queried with `json_extract(props, '$.subjectRelation')` (SQLite JSON1, available in libSQL).
- After each task: `bun test packages/auth` green. **Do not commit** unless the human asks.

## Subject-relation semantics (the P2 data rule)

A tuple `⟨object, relation, subject, subjectRelation?⟩` → edge `{src: subject, rel: relation, dst: object, props}`:
- **direct** (`subjectRelation` absent): `props = {}` → `json_extract(props,'$.subjectRelation')` is `NULL`.
- **userset** (`subjectRelation = 'member'`): `props = {"subjectRelation":"member"}`.

Direct and userset tuples with the same `(subject, relation, object)` are **distinct** rows — every write/revoke/existence predicate must match on `subjectRelation` too.

## Files changed

```
packages/auth/src/
  model.ts    — MODIFY: RewriteExpr union; Relation gains .self()/.or(); validate computed refs
  store.ts    — MODIFY: writeTuple stores subjectRelation + guards on it; deleteTuple takes subjectRelation
  check.ts    — CREATE: recursive evaluator (self/computed/union) + memo + cycle guard + asOf
  auth.ts     — MODIFY: check delegates to check.ts; write validates+stores subjectRelation; delete passes it
  index.ts    — (already exports RewriteExpr/Relation; no new public symbol needed)
  test/
    p2-model.test.ts   — CREATE
    p2-store.test.ts   — CREATE
    p2-check.test.ts   — CREATE
```

---

## Task 1: Extend the model — computed usersets (`model.ts`)

`RewriteExpr` grows to a union. `rel()` returns a builder with `.self()` (readability; direct tuples are the default) and `.or('rel')` (computed userset). `defineAuthModel` validates that every computed reference names a declared relation on the same type.

**Files:**
- Modify: `packages/auth/src/model.ts`
- Test: `packages/auth/test/p2-model.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/auth/test/p2-model.test.ts`

```typescript
import { expect, test } from 'bun:test';
import { defineAuthModel, rel } from '../src/model.ts';

test('P2: bare rel() is still self', () => {
	const m = defineAuthModel({ user: {}, doc: { viewer: rel() } });
	expect(m.rewrite('doc', 'viewer')).toEqual({ kind: 'self' });
});

test('P2: .or(rel) compiles to union(self, computed)', () => {
	const m = defineAuthModel({ user: {}, doc: { editor: rel(), viewer: rel().or('editor') } });
	expect(m.rewrite('doc', 'viewer')).toEqual({
		kind: 'union',
		children: [{ kind: 'self' }, { kind: 'computed', relation: 'editor' }],
	});
});

test('P2: .self().or(rel) equals .or(rel)', () => {
	const m = defineAuthModel({ user: {}, doc: { editor: rel(), viewer: rel().self().or('editor') } });
	expect(m.rewrite('doc', 'viewer')).toEqual({
		kind: 'union',
		children: [{ kind: 'self' }, { kind: 'computed', relation: 'editor' }],
	});
});

test('P2: defineAuthModel rejects a computed ref to an undeclared relation', () => {
	expect(() => defineAuthModel({ user: {}, doc: { viewer: rel().or('editor') } })).toThrow(
		/references unknown relation/,
	);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/auth/test/p2-model.test.ts`
Expected: FAIL — `.or` is not a function / union shape mismatch.

- [ ] **Step 3: Replace `packages/auth/src/model.ts`**

```typescript
import { z } from 'zod';
import { defineGraphSchema, type EdgeDef, type GraphSchema, type ZObj } from '../../core/src/index.ts';

/**
 * A userset rewrite expression. P1: `self`. P2 adds `computed` + `union`.
 * P3 will add `ttu`, `intersection`, `exclusion`.
 */
export type RewriteExpr =
	| { kind: 'self' }
	| { kind: 'computed'; relation: string }
	| { kind: 'union'; children: RewriteExpr[] };

/**
 * One relation's definition and builder. A bare `rel()` is direct tuples (`self`).
 * `.or('editor')` adds a computed userset (same object, other relation). The builder
 * methods are part of the interface so `rel(): Relation` stays expressible under
 * isolatedDeclarations.
 */
export interface Relation {
	rewrite: RewriteExpr;
	/** Mark direct tuples included (default). Present for readability. */
	self(): Relation;
	/** Add a computed userset: holders of `relation` on the same object also hold this one. */
	or(relation: string): Relation;
}

/** Model spec: object type → its relations. A type with no relations (e.g. `user`) is `{}`. */
export type ModelSpec = Record<string, Record<string, Relation>>;

/** A compiled authorization model: lookups + the graphx schema its tuples are stored under. */
export interface AuthModel {
	spec: ModelSpec;
	types: string[];
	relationsOf(type: string): string[];
	/** The rewrite for (type, relation); throws if either is undeclared. */
	rewrite(type: string, relation: string): RewriteExpr;
	/** graphx schema: node kind per type, one unconstrained edge per distinct relation. */
	schema: GraphSchema;
}

class RelationBuilder implements Relation {
	private readonly computed: string[] = [];
	self(): Relation {
		return this;
	}
	or(relation: string): Relation {
		this.computed.push(relation);
		return this;
	}
	get rewrite(): RewriteExpr {
		if (this.computed.length === 0) return { kind: 'self' };
		const children: RewriteExpr[] = [
			{ kind: 'self' },
			...this.computed.map((relation): RewriteExpr => ({ kind: 'computed', relation })),
		];
		return { kind: 'union', children };
	}
}

/** Declare a relation. Chain `.or('rel')` for computed usersets. */
export function rel(): Relation {
	return new RelationBuilder();
}

/** The computed-relation names referenced anywhere in a rewrite tree. */
function computedRefs(expr: RewriteExpr): string[] {
	if (expr.kind === 'computed') return [expr.relation];
	if (expr.kind === 'union') return expr.children.flatMap(computedRefs);
	return [];
}

/** Build an {@link AuthModel} from a spec, validate computed refs, and compile its graphx schema. */
export function defineAuthModel(spec: ModelSpec): AuthModel {
	const types = Object.keys(spec);

	const nodes: Record<string, ZObj> = {};
	const edges: Record<string, EdgeDef<string>> = {};
	for (const type of types) {
		nodes[type] = z.object({});
		const byType = spec[type] ?? {};
		for (const relation of Object.keys(byType)) {
			edges[relation] = {}; // unconstrained; dedupes across types
			// Validate every computed reference points at a declared relation on the same type.
			for (const ref of computedRefs(byType[relation]!.rewrite)) {
				if (!byType[ref]) {
					throw new Error(
						`auth: relation '${relation}' on type '${type}' references unknown relation '${ref}'`,
					);
				}
			}
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

Run: `bun test packages/auth/test/p2-model.test.ts` then `bun test packages/auth/test/p1-model.test.ts`
Expected: PASS both (P1 model tests still green — `rel()` → `{kind:'self'}` unchanged).

- [ ] **Step 5: Commit** (skip if holding commits)

```bash
git add packages/auth/src/model.ts packages/auth/test/p2-model.test.ts
git commit -m "feat(auth): computed usersets — .or() + RewriteExpr union (P2)"
```

---

## Task 2: subjectRelation-aware store (`store.ts`)

`writeTuple` stops rejecting userset subjects: it stores `subjectRelation` in edge props and includes it in the idempotency guard. `deleteTuple` takes a `subjectRelation` argument so it revokes the exact tuple. The subject-relation predicate is built as `IS NULL` vs `= ?` (avoids relying on `IS ?` parameter binding).

**Files:**
- Modify: `packages/auth/src/store.ts`
- Test: `packages/auth/test/p2-store.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/auth/test/p2-store.test.ts`

```typescript
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { Graph, init } from '../../core/src/index.ts';
import { defineAuthModel, rel } from '../src/model.ts';
import { deleteTuple, writeTuple } from '../src/store.ts';

const MODEL = defineAuthModel({ user: {}, group: { member: rel() }, doc: { viewer: rel() } });

async function fresh(): Promise<{ db: Client; g: Graph<typeof MODEL.schema> }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	return { db, g: new Graph(db, MODEL.schema) };
}

function liveCount(db: Client, src: string, rel: string, dst: string): Promise<number> {
	return db
		.execute({
			sql: 'SELECT COUNT(*) AS n FROM edges WHERE src = ? AND rel = ? AND dst = ?',
			args: [src, rel, dst],
		})
		.then((r) => Number(r.rows[0]!.n));
}

test('P2: direct and userset tuples on the same (subject,rel,object) are distinct rows', async () => {
	const { db, g } = await fresh();
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'group:eng' }); // direct
	await writeTuple(g, {
		object: 'doc:42',
		relation: 'viewer',
		subject: 'group:eng',
		subjectRelation: 'member',
	}); // userset
	expect(await liveCount(db, 'group:eng', 'viewer', 'doc:42')).toBe(2);
	db.close();
});

test('P2: userset writes are idempotent', async () => {
	const { db, g } = await fresh();
	const t = { object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' };
	await writeTuple(g, t);
	await writeTuple(g, t);
	expect(await liveCount(db, 'group:eng', 'viewer', 'doc:42')).toBe(1);
	db.close();
});

test('P2: deleteTuple revokes only the matching subjectRelation', async () => {
	const { db, g } = await fresh();
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'group:eng' });
	await writeTuple(g, {
		object: 'doc:42',
		relation: 'viewer',
		subject: 'group:eng',
		subjectRelation: 'member',
	});
	await deleteTuple(db, 'group:eng', 'viewer', 'doc:42', 'member'); // revoke only the userset tuple
	expect(await liveCount(db, 'group:eng', 'viewer', 'doc:42')).toBe(1); // the direct one remains
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/auth/test/p2-store.test.ts`
Expected: FAIL — `writeTuple` throws on `subjectRelation` (P1 rejection) / `deleteTuple` arity.

- [ ] **Step 3: Update `packages/auth/src/store.ts`**

Replace the `writeTuple` function with:
```typescript
/**
 * Write a tuple as an edge `subject --relation--> object`. A `subjectRelation` (userset
 * subject, e.g. `group:eng#member`) is stored in `props.subjectRelation`. Ensures both
 * endpoints exist, then inserts atomically + idempotently: the NOT EXISTS guard (matched
 * on subjectRelation too) runs inside the single write batch, so a concurrent identical
 * write (which SQLite serializes) skips.
 */
export async function writeTuple(g: Graph<GraphSchema>, tuple: Tuple): Promise<void> {
	await ensureObject(g.raw, tuple.object);
	await ensureObject(g.raw, tuple.subject);

	const id = ulid();
	const propsJson = tuple.subjectRelation
		? JSON.stringify({ subjectRelation: tuple.subjectRelation })
		: '{}';
	const srPred =
		tuple.subjectRelation === undefined
			? `json_extract(props, '$.subjectRelation') IS NULL`
			: `json_extract(props, '$.subjectRelation') = ?`;
	const srArgs: string[] = tuple.subjectRelation === undefined ? [] : [tuple.subjectRelation];
	const guard = `NOT EXISTS (SELECT 1 FROM edges WHERE src = ? AND rel = ? AND dst = ? AND ${srPred})`;

	await g.raw.batch(
		[
			{
				sql: `INSERT INTO edge_identity (id) SELECT ? WHERE ${guard}`,
				args: [id, tuple.subject, tuple.relation, tuple.object, ...srArgs],
			},
			{
				sql: `INSERT INTO edge_versions (id, src, dst, rel, weight, props, valid_from)
					SELECT ?, ?, ?, ?, 1.0, ?, ? WHERE ${guard}`,
				args: [
					id,
					tuple.subject,
					tuple.object,
					tuple.relation,
					propsJson,
					Date.now(),
					tuple.subject,
					tuple.relation,
					tuple.object,
					...srArgs,
				],
			},
		],
		'write',
	);
}
```

Replace the `deleteTuple` function with:
```typescript
/**
 * Revoke a tuple: close the live edge version (`valid_to = ts`), matched on
 * `subjectRelation` so a userset tuple and a same-endpoint direct tuple are revoked
 * independently. History is retained (`asOf` past still sees the grant). `ts` is bumped
 * past `valid_from` to keep the interval non-empty (M6). No-op if nothing live matches.
 */
export async function deleteTuple(
	raw: Client,
	src: string,
	rel: string,
	dst: string,
	subjectRelation?: string,
): Promise<void> {
	const srPred =
		subjectRelation === undefined
			? `json_extract(props, '$.subjectRelation') IS NULL`
			: `json_extract(props, '$.subjectRelation') = ?`;
	const srArgs: string[] = subjectRelation === undefined ? [] : [subjectRelation];

	const live = (
		await raw.execute({
			sql: `SELECT MAX(valid_from) AS vf FROM edge_versions
				WHERE src = ? AND rel = ? AND dst = ? AND valid_to = ? AND ${srPred}`,
			args: [src, rel, dst, FOREVER, ...srArgs],
		})
	).rows[0];
	const vf = live?.vf;
	if (vf == null) return;
	const ts = Math.max(Date.now(), Number(vf) + 1);
	await raw.execute({
		sql: `UPDATE edge_versions SET valid_to = ?
			WHERE src = ? AND rel = ? AND dst = ? AND valid_to = ? AND ${srPred}`,
		args: [ts, src, rel, dst, FOREVER, ...srArgs],
	});
}
```

> Leave `ensureObject` and `liveTupleExists` unchanged. `liveTupleExists` stays a direct-edge (subjectRelation-agnostic) helper used by P1 tests; the P2 evaluator does its own subjectRelation-aware reads in `check.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/auth/test/p2-store.test.ts` then `bun test packages/auth/test/p1-store.test.ts`
Expected: PASS both (P1 store tests still green — direct tuples write `props='{}'`, guard uses `IS NULL`).

- [ ] **Step 5: Commit** (skip if holding commits)

```bash
git add packages/auth/src/store.ts packages/auth/test/p2-store.test.ts
git commit -m "feat(auth): subjectRelation-aware tuple write/revoke (P2)"
```

---

## Task 3: Recursive check evaluator (`check.ts`)

A new module: recursive descent over the rewrite tree. `self` reads every edge into `(object, relation)` — a direct edge matches when `src === subject`; a userset edge (`subjectRelation = r`) recurses into `check(src, r, subject)`. `computed` recurses on the same object with another relation. `union` short-circuits. Memoized per `(object, relation, subject)`; a cycle returns `false`; one `asOf` snapshot throughout.

**Files:**
- Create: `packages/auth/src/check.ts`
- Test: covered by Task 4's `p2-check.test.ts` (the evaluator is exercised through `Auth.check`).

- [ ] **Step 1: Create `packages/auth/src/check.ts`**

```typescript
import type { Client } from '@libsql/client';
import type { AuthModel, RewriteExpr } from './model.ts';
import { typeOf } from './types.ts';

/** Per-check context: one `asOf` snapshot, shared memo + cycle-guard across the recursion. */
interface CheckCtx {
	raw: Client;
	model: AuthModel;
	asOf?: number;
	memo: Map<string, boolean>;
	stack: Set<string>;
}

/** Edges pointing INTO (object, relation): `subjectRelation` is null for direct grants. */
async function edgesInto(
	ctx: CheckCtx,
	object: string,
	relation: string,
): Promise<Array<{ src: string; subjectRelation: string | null }>> {
	const sql =
		ctx.asOf === undefined
			? `SELECT src, json_extract(props, '$.subjectRelation') AS sr FROM edges WHERE dst = ? AND rel = ?`
			: `SELECT src, json_extract(props, '$.subjectRelation') AS sr FROM edge_versions
				WHERE dst = ? AND rel = ? AND valid_from <= ? AND valid_to > ?`;
	const args =
		ctx.asOf === undefined ? [object, relation] : [object, relation, ctx.asOf, ctx.asOf];
	const r = await ctx.raw.execute({ sql, args });
	return r.rows.map((row) => ({
		src: String(row.src),
		subjectRelation: row.sr === null ? null : String(row.sr),
	}));
}

/** `self`: a direct edge `subject→object`, or a userset edge whose members include `subject`. */
async function evalSelf(
	ctx: CheckCtx,
	object: string,
	relation: string,
	subject: string,
): Promise<boolean> {
	for (const { src, subjectRelation } of await edgesInto(ctx, object, relation)) {
		if (subjectRelation === null) {
			if (src === subject) return true;
		} else if (await check(ctx, src, subjectRelation, subject)) {
			return true;
		}
	}
	return false;
}

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
		case 'union': {
			for (const child of expr.children) {
				if (await evalExpr(ctx, object, relation, subject, child)) return true;
			}
			return false;
		}
		default:
			throw new Error(
				`auth: rewrite '${(expr as { kind: string }).kind}' not supported until P3`,
			);
	}
}

/** `check(object, relation, subject)` with memoization + cycle guard. */
async function check(
	ctx: CheckCtx,
	object: string,
	relation: string,
	subject: string,
): Promise<boolean> {
	const key = `${object}#${relation}@${subject}`;
	const cached = ctx.memo.get(key);
	if (cached !== undefined) return cached;
	if (ctx.stack.has(key)) return false; // cycle on this path → not granted
	ctx.stack.add(key);
	const expr = ctx.model.rewrite(typeOf(object), relation); // throws on unknown type/relation
	const ok = await evalExpr(ctx, object, relation, subject, expr);
	ctx.stack.delete(key);
	ctx.memo.set(key, ok);
	return ok;
}

/** Entry point: evaluate a check against a fresh context (one `asOf` snapshot). */
export function runCheck(
	raw: Client,
	model: AuthModel,
	object: string,
	relation: string,
	subject: string,
	asOf?: number,
): Promise<boolean> {
	return check({ raw, model, asOf, memo: new Map(), stack: new Set() }, object, relation, subject);
}
```

- [ ] **Step 2: Type-check (no test yet — exercised in Task 4)**

Run: `cd packages/auth && tsc --noEmit`
Expected: clean. (If isolatedDeclarations flags `runCheck`, confirm its explicit `Promise<boolean>` return type is present.)

- [ ] **Step 3: Commit** (skip if holding commits)

```bash
git add packages/auth/src/check.ts
git commit -m "feat(auth): recursive check evaluator — self/computed/union (P2)"
```

---

## Task 4: Wire `Auth` + behavior tests (`auth.ts`)

`Auth.check` delegates to `runCheck`. `Auth.write` now accepts userset subjects (validates the subject's `subjectRelation` is a declared relation on the subject's type) and stores them. `Auth.delete` passes `subjectRelation` through.

**Files:**
- Modify: `packages/auth/src/auth.ts`
- Test: `packages/auth/test/p2-check.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/auth/test/p2-check.test.ts`

```typescript
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import { defineAuthModel, rel } from '../src/model.ts';

const MODEL = defineAuthModel({
	user: {},
	group: { member: rel() },
	doc: { editor: rel(), viewer: rel().or('editor') },
});

async function freshAuth(): Promise<{ db: Client; auth: Auth }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P2: computed userset — editor implies viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true); // via editor⇒viewer
	expect(await auth.check('doc:42', 'viewer', 'user:bob')).toBe(false);
	db.close();
});

test('P2: group userset — member of a group that is viewer', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'group:eng', relation: 'member', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:carol')).toBe(false);
	db.close();
});

test('P2: nested groups — membership recurses', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'team:core', relation: 'member', subject: 'user:alice' },
		{ object: 'group:eng', relation: 'member', subject: 'team:core', subjectRelation: 'member' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
	]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	db.close();
});

test('P2: membership cycle terminates and denies', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'group:b', relation: 'member', subject: 'group:a', subjectRelation: 'member' },
		{ object: 'group:a', relation: 'member', subject: 'group:b', subjectRelation: 'member' },
	]);
	expect(await auth.check('group:a', 'member', 'user:nobody')).toBe(false); // no hang
	db.close();
});

test('P2: asOf — group membership revoked after t1', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([
		{ object: 'group:eng', relation: 'member', subject: 'user:alice' },
		{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
	]);
	await sleep(20);
	const t1 = Date.now();
	await sleep(20);
	await auth.delete([{ object: 'group:eng', relation: 'member', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: t1 })).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // live: membership gone
	db.close();
});

test('P2: write rejects a userset whose subjectRelation is undeclared on the subject type', async () => {
	const { db, auth } = await freshAuth();
	await expect(
		auth.write([
			{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'admin' },
		]),
	).rejects.toThrow(/unknown relation/);
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/auth/test/p2-check.test.ts`
Expected: FAIL — `check` is still P1 (throws on `union`/`computed`) and `write` still rejects `subjectRelation`.

- [ ] **Step 3: Replace `packages/auth/src/auth.ts`**

```typescript
import type { Client } from '@libsql/client';
import type { Graph, GraphSchema } from '../../core/src/index.ts';
import { runCheck } from './check.ts';
import type { AuthModel } from './model.ts';
import { deleteTuple, writeTuple } from './store.ts';
import type { Tuple } from './types.ts';
import { typeOf } from './types.ts';

/** Options for a {@link Auth.check}. */
export interface CheckOpts {
	/** Evaluate as-of this epoch-ms instant (temporal snapshot). Omit ⇒ live (now). */
	asOf?: number;
}

/**
 * The ReBAC engine (L2 — see auth-rebac-spec.md). Wires an {@link AuthModel} to the
 * tuple store and the recursive check evaluator. P2: direct tuples, computed usersets,
 * and group usersets (including nested membership). P3 adds tuple-to-userset + set-ops.
 */
export class Auth {
	constructor(
		private readonly g: Graph<GraphSchema>,
		private readonly model: AuthModel,
	) {}

	private get raw(): Client {
		return this.g.raw;
	}

	/**
	 * Add relationship tuples. Validates the object's relation and, for a userset subject,
	 * that `subjectRelation` is a declared relation on the subject's type.
	 */
	async write(tuples: Tuple[]): Promise<void> {
		for (const t of tuples) {
			this.model.rewrite(typeOf(t.object), t.relation);
			if (t.subjectRelation !== undefined) {
				this.model.rewrite(typeOf(t.subject), t.subjectRelation);
			}
			await writeTuple(this.g, t);
		}
	}

	/** Revoke relationship tuples (temporal close), matched on `subjectRelation`. */
	async delete(tuples: Tuple[]): Promise<void> {
		for (const t of tuples) {
			this.model.rewrite(typeOf(t.object), t.relation);
			await deleteTuple(this.raw, t.subject, t.relation, t.object, t.subjectRelation);
		}
	}

	/**
	 * Does `subject` have `relation` on `object`? Recursively evaluates the relation's
	 * rewrite tree (self / computed / union) against tuples, at one `asOf` snapshot.
	 */
	check(object: string, relation: string, subject: string, opts: CheckOpts = {}): Promise<boolean> {
		return runCheck(this.raw, this.model, object, relation, subject, opts.asOf);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/auth/test/p2-check.test.ts` then `bun test packages/auth/test/p1-check.test.ts`
Expected: PASS both. (P1 check tests still green — direct `self` and `asOf` behavior is preserved by the generalized evaluator; the P1 "userset subjects rejected" test was for P1 only — see note below.)

> **P1 test reconciliation:** P1's `p1-check.test.ts` has a test "userset subjects are rejected (P2)" asserting `auth.write([...subjectRelation...])` throws. In P2 that is now *supported*. Update that single P1 test: change it to assert a userset write with a **valid** subjectRelation succeeds, OR remove it (the P2 suite covers userset writes). Make the minimal edit so the suite is internally consistent; note the change in your report.

- [ ] **Step 5: Commit** (skip if holding commits)

```bash
git add packages/auth/src/auth.ts packages/auth/test/p2-check.test.ts packages/auth/test/p1-check.test.ts
git commit -m "feat(auth): wire recursive check + userset writes into Auth (P2)"
```

---

## Task 5: Exports + full green gate

**Files:**
- Modify: `packages/auth/src/index.ts` (only if a new public symbol is needed — `RewriteExpr`/`Relation` are already exported from P1; `runCheck` is internal, not exported)
- Verify: full suite + type-check + lint + core untouched

- [ ] **Step 1: Confirm exports**

`index.ts` should already export `Auth`, `CheckOpts`, `AuthModel`, `defineAuthModel`, `ModelSpec`, `rel`, `Relation`, `RewriteExpr`, `Tuple`, `VERSION`. No new public symbol is required for P2 (the evaluator is internal). Leave `index.ts` unchanged unless something is missing.

- [ ] **Step 2: Full auth suite**

Run: `bun test packages/auth`
Expected: PASS — P1 + P2 suites green.

- [ ] **Step 3: Type-check**

Run: `cd packages/auth && tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint (do NOT run the whole-repo formatter)**

Run: `bun run lint`
Expected: clean. **Do not run `bun run format`** — it reformats the whole repo and dirties `packages/core` (a known oxfmt drift). If you must format, format only the auth files: `bunx oxfmt packages/auth`.

- [ ] **Step 5: Confirm core is untouched**

Run: `git diff --name-only -- packages/core`
Expected: empty.

- [ ] **Step 6: Commit** (skip if holding commits)

```bash
git add packages/auth/src/index.ts
git commit -m "chore(auth): P2 complete — computed + group usersets green"
```

---

## Self-Review (completed during planning)

- **Spec coverage (P2 row):** computed userset (`.or`) → Task 1; group usersets / `subjectRelation` storage → Task 2; recursive membership evaluator → Task 3; wiring + nested/cycle/asOf behavior → Task 4. ✅
- **Placeholders:** none — full code in every step.
- **Type consistency:** `RewriteExpr` union (`self|computed|union`) is produced by `RelationBuilder.rewrite` and consumed by `evalExpr`'s switch; `deleteTuple(raw, src, rel, dst, subjectRelation?)` signature matches `Auth.delete`'s call; `runCheck(raw, model, object, relation, subject, asOf?)` matches `Auth.check`. `Tuple.subjectRelation` flows write → store → props → `edgesInto` → recursion.
- **P1 regression handled:** the one P1 test asserting userset rejection is explicitly reconciled in Task 4 Step 4.
- **Zero-core-change** preserved; lint step warns against the whole-repo formatter (the P1 drift trap).
- **Deferred:** `.rel()` single-query fast-path for deep recursion (perf, later phase); `tupleToUserset` + `.and`/`.minus` (P3); `expand` (P4); `listObjects` (P5); governance fan-out caps on `edgesInto` (P6).

## Out of scope for P2 (next plans)

| Next plan | Scope |
|-----------|-------|
| P3 | tuple-to-userset hierarchy (recursive `.rel()` over a tupleset), set-ops `.and` / `.minus` (intersection / exclusion) |
| P4 | `expand(object, relation)` → userset tree |
| P5 | `listObjects(subject, relation, type)` (reverse-expand + verify) |
| P6 | consistency tokens, subproblem cache, governance fan-out caps, `mountAuth` HTTP routes, packaging |
