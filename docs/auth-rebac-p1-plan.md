# graphx/auth — P1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `auth` package with an authorization model, tuple write/revoke, and direct-tuple (`self`) `check` — the ReBAC foundation P2–P6 build on.

**Architecture:** ReBAC tuples are stored as graphx edges (`subject --relation--> object`); objects/subjects are bare existence nodes whose `id` is the Zanzibar ref (`doc:42`). No core changes: objects are written with an idempotent `ensureObject` (INSERT-OR-IGNORE), tuples reuse `Graph.addEdge` for temporal versioning, revoke closes the live edge version. P1 `check` is a single live-view (or `asOf`) edge lookup.

**Tech Stack:** TypeScript, bun (`bun test`), zod, @libsql/client, `core` workspace package (graphx core).

---

## Conventions (read once)

- **Runtime/test:** `bun test`; tests import `{ expect, test } from 'bun:test'`.
- **Importing core:** relative to core's source — `from '../../core/src/index.ts'` (the repo is src-first; this avoids a build step during TDD). Within `auth`, files import each other with `.ts` extensions (`./model.ts`), matching repo style (`allowImportingTsExtensions`, `verbatimModuleSyntax`).
- **isolatedDeclarations is ON** (inherited from `tsconfig.base.json`): every exported function/const MUST have an explicit return type / type annotation, or `bun run type-check` fails.
- **FOREVER** = `8640000000000000` (open-interval sentinel), exported from core.
- **Fresh DB in tests:** `createClient({ url: ':memory:' })` → `await init(client, 4)` → build model → `new Graph(client, model.schema)`. P1 uses only multi-valued edge appends + plain `UPDATE`/`SELECT`, all of which work on `:memory:` (no interactive `transaction()`).
- After each task: `bun test packages/auth` green, then commit.

## File Structure

```
packages/auth/
  package.json            — name "auth", mirrors packages/graphx/package.json
  tsconfig.json           — extends ../../tsconfig.base.json (same as core)
  src/
    index.ts              — public exports
    types.ts              — Tuple type, parseRef/typeOf ref helpers
    model.ts              — rel(), defineAuthModel(), AuthModel (rewrite/types), compile → graphx schema
    store.ts              — ensureObject, liveTupleExists, writeTuple, deleteTuple
    auth.ts               — Auth class: write / delete / check (direct `self` only in P1)
  test/
    p1-model.test.ts
    p1-store.test.ts
    p1-check.test.ts
```

Each file has one responsibility: `types` = ref parsing, `model` = the authorization model + schema compile, `store` = low-level node/edge persistence, `auth` = the public engine wiring model + store.

---

## Task 1: Scaffold the `auth` package

**Files:**

- Create: `packages/auth/package.json`
- Create: `packages/auth/tsconfig.json`
- Create: `packages/graphx/src/auth/index.ts`
- Test: `packages/graphx/test/auth/p1-smoke.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/graphx/test/auth/p1-smoke.test.ts`

```typescript
import { expect, test } from 'bun:test';
import { VERSION } from '../src/index.ts';
import { Graph } from '../../core/src/index.ts';

test('P1: package wiring — exports load and core is importable', () => {
	expect(VERSION).toBe('0.1.0');
	expect(typeof Graph).toBe('function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p1-smoke.test.ts`
Expected: FAIL — cannot resolve `../src/index.ts` (file missing).

- [ ] **Step 3: Create the package files**

`packages/auth/package.json`:

```json
{
	"name": "auth",
	"version": "0.1.0",
	"description": "Relationship-based access control (ReBAC) on graphx",
	"license": "MIT",
	"type": "module",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"import": {
				"types": "./dist/index.d.ts",
				"default": "./dist/index.js"
			}
		},
		"./package.json": "./package.json"
	},
	"scripts": {
		"type-check": "tsc --noEmit"
	},
	"dependencies": {
		"@libsql/client": "^0.17.3",
		"core": "workspace:*",
		"zod": "^4.4.3"
	},
	"devDependencies": {
		"@types/node": "^25.9.1"
	},
	"peerDependencies": {
		"typescript": ">=4.5.0"
	},
	"peerDependenciesMeta": {
		"typescript": {
			"optional": true
		}
	}
}
```

`packages/auth/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": { "declaration": true, "isolatedDeclarations": true, "types": ["node"] },
	"include": ["src/**/*"]
}
```

`packages/graphx/src/auth/index.ts`:

```typescript
// Public API for `auth` — relationship-based access control (ReBAC) on graphx.
export const VERSION: string = '0.1.0';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p1-smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/auth/package.json packages/auth/tsconfig.json packages/graphx/src/auth/index.ts packages/graphx/test/auth/p1-smoke.test.ts
git commit -m "feat(auth): scaffold graphx/auth package (ReBAC P1)"
```

---

## Task 2: Ref helpers (`types.ts`)

A Zanzibar ref is `type:localId` (e.g. `doc:42`, `user:alice`). `parseRef` splits on the first `:`.

**Files:**

- Create: `packages/graphx/src/auth/types.ts`
- Test: `packages/graphx/test/auth/p1-model.test.ts` (shared with Task 3; create here, add to it there)

- [ ] **Step 1: Write the failing test** — append to `packages/graphx/test/auth/p1-model.test.ts`

```typescript
import { expect, test } from 'bun:test';
import { parseRef, typeOf } from '../src/types.ts';

test('P1: parseRef splits on first colon', () => {
	expect(parseRef('doc:42')).toEqual({ type: 'doc', id: '42' });
	expect(parseRef('user:alice:eu')).toEqual({ type: 'user', id: 'alice:eu' });
	expect(typeOf('group:eng')).toBe('group');
});

test('P1: parseRef rejects refs without a type', () => {
	expect(() => parseRef('doc')).toThrow();
	expect(() => parseRef(':42')).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p1-model.test.ts`
Expected: FAIL — cannot resolve `../src/types.ts`.

- [ ] **Step 3: Create `packages/graphx/src/auth/types.ts`**

```typescript
/** A ReBAC relationship tuple `⟨object, relation, subject⟩` (Zanzibar). */
export interface Tuple {
	/** Object ref, `type:id` (e.g. `doc:42`). */
	object: string;
	/** Relation name defined on the object's type (e.g. `viewer`). */
	relation: string;
	/** Subject ref, `type:id` (e.g. `user:alice` or `group:eng`). */
	subject: string;
	/** Userset subject relation (e.g. `member` for `group:eng#member`). P2+ — rejected in P1. */
	subjectRelation?: string;
}

/** Split a ref `type:id` on the FIRST colon. Throws if either side is empty. */
export function parseRef(ref: string): { type: string; id: string } {
	const i = ref.indexOf(':');
	if (i <= 0 || i >= ref.length - 1) {
		throw new Error(`auth: invalid ref '${ref}' (expected 'type:id')`);
	}
	return { type: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** The type segment of a ref (`doc:42` → `doc`). */
export function typeOf(ref: string): string {
	return parseRef(ref).type;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p1-model.test.ts`
Expected: PASS (the 2 ref tests).

- [ ] **Step 5: Commit**

```bash
git add packages/graphx/src/auth/types.ts packages/graphx/test/auth/p1-model.test.ts
git commit -m "feat(auth): ref parsing (type:id) + Tuple type"
```

---

## Task 3: Authorization model + schema compile (`model.ts`)

P1 supports only the `self` rewrite (direct tuples). A bare `rel()` means "direct tuples" (`_this`). Computed/ttu/set-ops are P2+. The model compiles to a graphx schema: object types → node kinds (bare `z.object({})`), relations → **unconstrained** edge defs (`{}`, no `from`/`to`) so cross-type relations (e.g. `viewer` on both `doc` and `folder`) collapse to one edge def and `addEdge` skips endpoint checks.

**Files:**

- Create: `packages/graphx/src/auth/model.ts`
- Test: `packages/graphx/test/auth/p1-model.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `packages/graphx/test/auth/p1-model.test.ts`

```typescript
import { defineAuthModel, rel } from '../src/model.ts';

const MODEL = defineAuthModel({
	user: {},
	group: { member: rel() },
	doc: { editor: rel(), viewer: rel() },
});

test('P1: model exposes types and relations', () => {
	expect(new Set(MODEL.types)).toEqual(new Set(['user', 'group', 'doc']));
	expect(MODEL.relationsOf('doc')).toEqual(['editor', 'viewer']);
	expect(MODEL.relationsOf('user')).toEqual([]);
});

test('P1: rewrite returns self for a declared relation', () => {
	expect(MODEL.rewrite('doc', 'viewer')).toEqual({ kind: 'self' });
});

test('P1: rewrite throws on unknown type or relation', () => {
	expect(() => MODEL.rewrite('doc', 'owner')).toThrow();
	expect(() => MODEL.rewrite('widget', 'viewer')).toThrow();
});

test('P1: compiled schema has a node kind per type and one edge per relation', () => {
	expect(Object.keys(MODEL.schema.nodes).sort()).toEqual(['doc', 'group', 'user']);
	// `member`, `editor`, `viewer` — deduped across types
	expect(Object.keys(MODEL.schema.edges).sort()).toEqual(['editor', 'member', 'viewer']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p1-model.test.ts`
Expected: FAIL — cannot resolve `../src/model.ts`.

- [ ] **Step 3: Create `packages/graphx/src/auth/model.ts`**

```typescript
import { z } from 'zod';
import {
	defineGraphSchema,
	type EdgeDef,
	type GraphSchema,
	type ZObj,
} from '../../core/src/index.ts';

/**
 * A userset rewrite expression. P1 supports only `self` (direct tuples, Zanzibar `_this`).
 * P2+ extends this union with `computed`, `ttu`, `union`, `intersection`, `exclusion`.
 */
export type RewriteExpr = { kind: 'self' };

/** One relation's definition. A bare `rel()` is direct tuples (`self`). */
export interface Relation {
	rewrite: RewriteExpr;
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

/** Declare a relation. P1: direct tuples only. */
export function rel(): Relation {
	return { rewrite: { kind: 'self' } };
}

/** Build an {@link AuthModel} from a spec and compile its graphx schema. */
export function defineAuthModel(spec: ModelSpec): AuthModel {
	const types = Object.keys(spec);

	const nodes: Record<string, ZObj> = {};
	const edges: Record<string, EdgeDef<string>> = {};
	for (const type of types) {
		nodes[type] = z.object({});
		for (const relation of Object.keys(spec[type] ?? {})) {
			edges[relation] = {}; // unconstrained; dedupes across types
		}
	}
	const schema = defineGraphSchema({ nodes, edges }) as GraphSchema;

	return {
		spec,
		types,
		relationsOf: (type: string): string[] => Object.keys(spec[type] ?? {}),
		rewrite: (type: string, relation: string): RewriteExpr => {
			const r = spec[type]?.[relation];
			if (!r) throw new Error(`auth: unknown relation '${relation}' on type '${type}'`);
			return r.rewrite;
		},
		schema,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p1-model.test.ts`
Expected: PASS (all model + ref tests).

- [ ] **Step 5: Commit**

```bash
git add packages/graphx/src/auth/model.ts packages/graphx/test/auth/p1-model.test.ts
git commit -m "feat(auth): authorization model DSL + graphx schema compile"
```

---

## Task 4: `ensureObject` — idempotent object existence (`store.ts`)

Objects/subjects are bare existence nodes (`id` = ref, `kind` = type, props `{}`). `addNode` can't be used (it mints a ULID and isn't idempotent). `ensureObject` writes the identity row + one live version, idempotently.

**Files:**

- Create: `packages/graphx/src/auth/store.ts`
- Test: `packages/graphx/test/auth/p1-store.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/graphx/test/auth/p1-store.test.ts`

```typescript
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { FOREVER, init } from '../../core/src/index.ts';
import { ensureObject } from '../src/store.ts';

async function freshDb(): Promise<Client> {
	const client = createClient({ url: ':memory:' });
	await init(client, 4);
	return client;
}

test('P1: ensureObject creates one live node with id=ref, kind=type', async () => {
	const db = await freshDb();
	await ensureObject(db, 'doc:42');
	const r = await db.execute({
		sql: 'SELECT kind FROM nodes WHERE id = ?',
		args: ['doc:42'],
	});
	expect(r.rows.length).toBe(1);
	expect(String(r.rows[0]!.kind)).toBe('doc');
	db.close();
});

test('P1: ensureObject is idempotent — second call adds no row', async () => {
	const db = await freshDb();
	await ensureObject(db, 'doc:42');
	await ensureObject(db, 'doc:42');
	const r = await db.execute({
		sql: 'SELECT COUNT(*) AS n FROM node_versions WHERE id = ? AND valid_to = ?',
		args: ['doc:42', FOREVER],
	});
	expect(Number(r.rows[0]!.n)).toBe(1);
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p1-store.test.ts`
Expected: FAIL — cannot resolve `../src/store.ts`.

- [ ] **Step 3: Create `packages/graphx/src/auth/store.ts`**

```typescript
import type { Client } from '@libsql/client';
import { FOREVER } from '../../core/src/index.ts';
import { typeOf } from './types.ts';

/**
 * Ensure an object/subject exists as a bare node (id = ref, kind = type, props `{}`).
 * Idempotent: INSERT-OR-IGNORE the identity row, then insert a live version only if
 * none exists. Existence is binary — no temporal versioning of objects themselves.
 */
export async function ensureObject(raw: Client, ref: string): Promise<void> {
	const kind = typeOf(ref);
	await raw.batch(
		[
			{ sql: 'INSERT OR IGNORE INTO node_identity (id) VALUES (?)', args: [ref] },
			{
				sql: `INSERT INTO node_versions (id, kind, props, valid_from)
					SELECT ?, ?, '{}', ?
					WHERE NOT EXISTS (SELECT 1 FROM node_versions WHERE id = ? AND valid_to = ?)`,
				args: [ref, kind, Date.now(), ref, FOREVER],
			},
		],
		'write',
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p1-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/graphx/src/auth/store.ts packages/graphx/test/auth/p1-store.test.ts
git commit -m "feat(auth): ensureObject — idempotent object existence rows"
```

---

## Task 5: `writeTuple` + `liveTupleExists` (`store.ts`)

A tuple is an edge `subject --relation--> object`. Both endpoints are ensured first (FK), then the edge is appended via `Graph.addEdge` (reuses temporal versioning + the write-contention envelope). Idempotent: skip if a live edge already exists.

**Files:**

- Modify: `packages/graphx/src/auth/store.ts`
- Test: `packages/graphx/test/auth/p1-store.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `packages/graphx/test/auth/p1-store.test.ts`

```typescript
import { Graph } from '../../core/src/index.ts';
import { defineAuthModel, rel } from '../src/model.ts';
import { liveTupleExists, writeTuple } from '../src/store.ts';

const STORE_MODEL = defineAuthModel({ user: {}, doc: { viewer: rel() } });

test('P1: writeTuple creates a live edge subject→object; check via liveTupleExists', async () => {
	const db = await freshDb();
	const g = new Graph(db, STORE_MODEL.schema);
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'user:alice' });
	expect(await liveTupleExists(db, 'user:alice', 'viewer', 'doc:42')).toBe(true);
	expect(await liveTupleExists(db, 'user:bob', 'viewer', 'doc:42')).toBe(false);
	db.close();
});

test('P1: writeTuple is idempotent — duplicate writes leave one live edge', async () => {
	const db = await freshDb();
	const g = new Graph(db, STORE_MODEL.schema);
	const t = { object: 'doc:42', relation: 'viewer', subject: 'user:alice' };
	await writeTuple(g, t);
	await writeTuple(g, t);
	const r = await db.execute({
		sql: 'SELECT COUNT(*) AS n FROM edges WHERE src = ? AND rel = ? AND dst = ?',
		args: ['user:alice', 'viewer', 'doc:42'],
	});
	expect(Number(r.rows[0]!.n)).toBe(1);
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p1-store.test.ts`
Expected: FAIL — `writeTuple`/`liveTupleExists` not exported.

- [ ] **Step 3: Add to `packages/graphx/src/auth/store.ts`**

Add imports at the top (merge with the existing import block):

```typescript
import { FOREVER, type Graph, type GraphSchema } from '../../core/src/index.ts';
import type { Tuple } from './types.ts';
```

Append:

```typescript
/** Is there a live edge `src --rel--> dst`? (P1 direct-tuple existence check.) */
export async function liveTupleExists(
	raw: Client,
	src: string,
	rel: string,
	dst: string,
): Promise<boolean> {
	const r = await raw.execute({
		sql: 'SELECT 1 FROM edges WHERE src = ? AND rel = ? AND dst = ? LIMIT 1',
		args: [src, rel, dst],
	});
	return r.rows.length > 0;
}

/**
 * Write a direct tuple as an edge `subject --relation--> object`. Ensures both
 * endpoints exist, then appends via `addEdge` (temporal versioning reuse). Idempotent:
 * a no-op when the live edge already exists. P1 rejects userset subjects (P2).
 */
export async function writeTuple(g: Graph<GraphSchema>, tuple: Tuple): Promise<void> {
	if (tuple.subjectRelation !== undefined) {
		throw new Error('auth: userset subjects (subjectRelation) are not supported until P2');
	}
	await ensureObject(g.raw, tuple.object);
	await ensureObject(g.raw, tuple.subject);
	if (await liveTupleExists(g.raw, tuple.subject, tuple.relation, tuple.object)) return;
	await g.addEdge({ rel: tuple.relation, src: tuple.subject, dst: tuple.object });
}
```

> Note: `FOREVER` is already imported by Task 4; merge the named imports rather than duplicating the line. `Graph`/`GraphSchema` are type-only imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p1-store.test.ts`
Expected: PASS (4 tests total in file).

- [ ] **Step 5: Commit**

```bash
git add packages/graphx/src/auth/store.ts packages/graphx/test/auth/p1-store.test.ts
git commit -m "feat(auth): writeTuple + liveTupleExists (tuples as edges)"
```

---

## Task 6: `deleteTuple` — temporal revoke (`store.ts`)

Revoke closes the live edge version (`valid_to = ts`), preserving history so `asOf` past still sees the grant. `ts` is bumped past the live `valid_from` to avoid a zero-width interval (mirrors core's close pattern, graph.ts:280).

**Files:**

- Modify: `packages/graphx/src/auth/store.ts`
- Test: `packages/graphx/test/auth/p1-store.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `packages/graphx/test/auth/p1-store.test.ts`

```typescript
import { deleteTuple } from '../src/store.ts';

test('P1: deleteTuple closes the live edge — no live tuple, history retained', async () => {
	const db = await freshDb();
	const g = new Graph(db, STORE_MODEL.schema);
	await writeTuple(g, { object: 'doc:42', relation: 'viewer', subject: 'user:alice' });
	await deleteTuple(db, 'user:alice', 'viewer', 'doc:42');

	expect(await liveTupleExists(db, 'user:alice', 'viewer', 'doc:42')).toBe(false);
	// the closed version still exists with a finite valid_to
	const r = await db.execute({
		sql: 'SELECT valid_to FROM edge_versions WHERE src = ? AND rel = ? AND dst = ?',
		args: ['user:alice', 'viewer', 'doc:42'],
	});
	expect(r.rows.length).toBe(1);
	expect(Number(r.rows[0]!.valid_to)).toBeLessThan(8640000000000000);
	db.close();
});

test('P1: deleteTuple on a missing tuple is a no-op', async () => {
	const db = await freshDb();
	await deleteTuple(db, 'user:ghost', 'viewer', 'doc:42'); // must not throw
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p1-store.test.ts`
Expected: FAIL — `deleteTuple` not exported.

- [ ] **Step 3: Append to `packages/graphx/src/auth/store.ts`**

```typescript
/**
 * Revoke a tuple: close the live edge version (`valid_to = ts`). History is retained,
 * so an `asOf` read before `ts` still sees the grant. `ts` is bumped past the row's
 * `valid_from` to keep the interval non-empty (M6). No-op if no live edge exists.
 */
export async function deleteTuple(
	raw: Client,
	src: string,
	rel: string,
	dst: string,
): Promise<void> {
	const live = (
		await raw.execute({
			sql: `SELECT MAX(valid_from) AS vf FROM edge_versions
				WHERE src = ? AND rel = ? AND dst = ? AND valid_to = ?`,
			args: [src, rel, dst, FOREVER],
		})
	).rows[0];
	const vf = live?.vf;
	if (vf == null) return; // nothing live to close
	const ts = Math.max(Date.now(), Number(vf) + 1);
	await raw.execute({
		sql: `UPDATE edge_versions SET valid_to = ?
			WHERE src = ? AND rel = ? AND dst = ? AND valid_to = ?`,
		args: [ts, src, rel, dst, FOREVER],
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p1-store.test.ts`
Expected: PASS (6 tests total in file).

- [ ] **Step 5: Commit**

```bash
git add packages/graphx/src/auth/store.ts packages/graphx/test/auth/p1-store.test.ts
git commit -m "feat(auth): deleteTuple — temporal revoke (close live edge)"
```

---

## Task 7: `Auth` class — write / delete / check (live) (`auth.ts`)

The public engine. Wires the model + store. P1 `check` handles only the `self` rewrite (direct tuples) via a live-view lookup; non-`self` rewrites throw (P2). `write` validates each tuple's (type, relation) against the model.

**Files:**

- Create: `packages/graphx/src/auth/auth.ts`
- Test: `packages/graphx/test/auth/p1-check.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/graphx/test/auth/p1-check.test.ts`

```typescript
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import { defineAuthModel, rel } from '../src/model.ts';

const MODEL = defineAuthModel({ user: {}, doc: { editor: rel(), viewer: rel() } });

async function freshAuth(): Promise<{ db: Client; auth: Auth }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	return { db, auth: new Auth(new Graph(db, MODEL.schema), MODEL) };
}

test('P1: check is true after write, false otherwise', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:bob')).toBe(false);
	expect(await auth.check('doc:42', 'editor', 'user:alice')).toBe(false);
	db.close();
});

test('P1: check is false after delete', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	await auth.delete([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false);
	db.close();
});

test('P1: write/check reject an unknown relation', async () => {
	const { db, auth } = await freshAuth();
	await expect(
		auth.write([{ object: 'doc:42', relation: 'owner', subject: 'user:alice' }]),
	).rejects.toThrow();
	await expect(auth.check('doc:42', 'owner', 'user:alice')).rejects.toThrow();
	db.close();
});

test('P1: userset subjects are rejected (P2)', async () => {
	const { db, auth } = await freshAuth();
	await expect(
		auth.write([
			{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
		]),
	).rejects.toThrow();
	db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/graphx/test/auth/p1-check.test.ts`
Expected: FAIL — cannot resolve `../src/auth.ts`.

- [ ] **Step 3: Create `packages/graphx/src/auth/auth.ts`**

```typescript
import type { Client } from '@libsql/client';
import type { Graph, GraphSchema } from '../../core/src/index.ts';
import type { AuthModel } from './model.ts';
import { deleteTuple, liveTupleExists, writeTuple } from './store.ts';
import type { Tuple } from './types.ts';
import { typeOf } from './types.ts';

/** Options for a {@link Auth.check}. */
export interface CheckOpts {
	/** Evaluate as-of this epoch-ms instant (temporal snapshot). Omit ⇒ live (now). */
	asOf?: number;
}

/**
 * The ReBAC engine (L2 — see auth-rebac-spec.md). Wires an {@link AuthModel} to the
 * tuple store. P1: direct-tuple (`self`) `check` only; computed/hierarchical rewrites
 * and `expand`/`listObjects` arrive in P2–P5.
 */
export class Auth {
	constructor(
		private readonly g: Graph<GraphSchema>,
		private readonly model: AuthModel,
	) {}

	private get raw(): Client {
		return this.g.raw;
	}

	/** Add relationship tuples. Validates each (object-type, relation) against the model. */
	async write(tuples: Tuple[]): Promise<void> {
		for (const t of tuples) {
			this.model.rewrite(typeOf(t.object), t.relation); // throws on unknown type/relation
			await writeTuple(this.g, t);
		}
	}

	/** Revoke relationship tuples (temporal close). */
	async delete(tuples: Tuple[]): Promise<void> {
		for (const t of tuples) {
			await deleteTuple(this.raw, t.subject, t.relation, t.object);
		}
	}

	/**
	 * Does `subject` have `relation` on `object`? P1 evaluates only the `self` rewrite
	 * (a direct tuple). A non-`self` rewrite throws (implemented in P2+).
	 */
	async check(
		object: string,
		relation: string,
		subject: string,
		opts: CheckOpts = {},
	): Promise<boolean> {
		const expr = this.model.rewrite(typeOf(object), relation); // throws on unknown
		if (expr.kind !== 'self') {
			throw new Error(`auth: rewrite '${expr.kind}' not supported until P2`);
		}
		if (opts.asOf !== undefined) {
			const r = await this.raw.execute({
				sql: `SELECT 1 FROM edge_versions
					WHERE src = ? AND rel = ? AND dst = ? AND valid_from <= ? AND valid_to > ? LIMIT 1`,
				args: [subject, relation, object, opts.asOf, opts.asOf],
			});
			return r.rows.length > 0;
		}
		return liveTupleExists(this.raw, subject, relation, object);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/graphx/test/auth/p1-check.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/graphx/src/auth/auth.ts packages/graphx/test/auth/p1-check.test.ts
git commit -m "feat(auth): Auth engine — write/delete/check (direct self, P1)"
```

---

## Task 8: Temporal `check` — `asOf` snapshot (`auth.ts`)

Verify the `asOf` branch end-to-end: a grant written at t1 then revoked at t2 must read `true` as-of t1 and `false` as-of t2 / now.

**Files:**

- Test: `packages/graphx/test/auth/p1-check.test.ts` (append) — no new source; this exercises the `asOf` branch from Task 7.

- [ ] **Step 1: Write the failing test** — append to `packages/graphx/test/auth/p1-check.test.ts`

```typescript
import { setTimeout as sleep } from 'node:timers/promises';

test('P1: check asOf sees the grant in the past, not after revoke', async () => {
	const { db, auth } = await freshAuth();
	await auth.write([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);
	await sleep(5);
	const t1 = Date.now(); // grant is live here
	await sleep(5);
	await auth.delete([{ object: 'doc:42', relation: 'viewer', subject: 'user:alice' }]);

	expect(await auth.check('doc:42', 'viewer', 'user:alice', { asOf: t1 })).toBe(true);
	expect(await auth.check('doc:42', 'viewer', 'user:alice')).toBe(false); // live = now
	db.close();
});
```

- [ ] **Step 2: Run test to verify it passes (no new code)**

Run: `bun test packages/graphx/test/auth/p1-check.test.ts`
Expected: PASS (5 tests). If it fails, the `asOf` SQL bounds in Task 7 are wrong — fix there (interval is `[valid_from, valid_to)`, so `valid_from <= asOf AND valid_to > asOf`).

- [ ] **Step 3: Commit**

```bash
git add packages/graphx/test/auth/p1-check.test.ts
git commit -m "test(auth): temporal asOf check — grant visible in the past"
```

---

## Task 9: Public exports + full green gate (`index.ts`)

**Files:**

- Modify: `packages/graphx/src/auth/index.ts`
- Test: full suite + type-check + lint

- [ ] **Step 1: Replace `packages/graphx/src/auth/index.ts`**

```typescript
// Public API for `auth` — relationship-based access control (ReBAC) on graphx.
export const VERSION: string = '0.1.0';

export { Auth, type CheckOpts } from './auth.ts';
export {
	type AuthModel,
	defineAuthModel,
	type ModelSpec,
	rel,
	type Relation,
	type RewriteExpr,
} from './model.ts';
export { type Tuple } from './types.ts';
```

- [ ] **Step 2: Run the full auth suite**

Run: `bun test packages/auth`
Expected: PASS — all P1 tests (smoke, model, store, check) green.

- [ ] **Step 3: Type-check the package**

Run: `cd packages/auth && tsc --noEmit`
Expected: no errors. (If isolatedDeclarations complains, add the missing explicit return type to the flagged export.)

- [ ] **Step 4: Lint + format**

Run: `bun run lint && bun run format`
Expected: clean (or auto-fixed). Re-run `bun test packages/auth` if format changed files.

- [ ] **Step 5: Confirm core is untouched**

Run: `git diff --name-only main -- packages/graphx`
Expected: empty — P1 added zero core changes (the design's guarantee).

- [ ] **Step 6: Commit**

```bash
git add packages/graphx/src/auth/index.ts
git commit -m "feat(auth): public exports — Auth, defineAuthModel, rel, Tuple (P1 complete)"
```

---

## Self-Review (completed during planning)

- **Spec coverage (P1 row):** model definition → Task 3; tuple write/read → Tasks 4–5; direct-tuple `check` → Task 7; temporal `asOf` (spec §"Consistency") → Tasks 6, 8. ✅
- **Zero-core-change guarantee** (agreed realization) → verified in Task 9 Step 5. ✅
- **Placeholders:** none — every step has full code/commands.
- **Type consistency:** `Tuple` (types.ts) used uniformly; `RewriteExpr {kind:'self'}` matches `rewrite()` return + `check` guard; `writeTuple(g, tuple)` / `deleteTuple(raw, src, rel, dst)` / `liveTupleExists(raw, src, rel, dst)` signatures match every call site; `Auth` ctor `(Graph<GraphSchema>, AuthModel)` matches tests.
- **Deferred to later plans:** computed/ttu/set-op rewrites (P2–P3), `expand` (P4), `listObjects` (P5), `asOf` consistency tokens + caching (P6), HTTP routes via `mountAuth` on serve.ts, package publishing (`from 'core'` package import + bunup externalization to replace the P1 relative `../../core/src` import).

## Out of scope for P1 (tracked for next plans)

| Next plan | Scope                                                                                        |
| --------- | -------------------------------------------------------------------------------------------- |
| P2        | computed userset (`.or`), group usersets (`subjectRelation`, recursive `member`)             |
| P3        | tuple-to-userset hierarchy (recursive `.rel()`), set-ops (∪ ∩ −)                             |
| P4        | `expand(object, relation)`                                                                   |
| P5        | `listObjects` (reverse-expand + verify)                                                      |
| P6        | consistency tokens, subproblem cache; `mountAuth` HTTP routes on serve.ts; packaging cleanup |
