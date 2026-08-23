# graphx-auth — P6a (HTTP Serving) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the ReBAC engine over HTTP — `createAuthApp(cfg)` returns a standalone Hono app with `/check`, `/expand`, `/list-objects`, and `/tuples` routes, so an application can call `check` etc. over the wire.

**Architecture:** A self-contained Hono sub-app (NOT mounted into core's `serve.ts` — preserves the zero-core-change invariant from P1–P5). The operator injects two functions: `authenticate(c)` (L1 authn → an opaque principal) and `resolveAuth(c, principal, op)` (resolve the per-request `Auth` engine — the operator owns tenant/project → `${project}__auth` namespace resolution). The package owns wire validation (zod), op-tagged middleware, the handlers, and error→HTTP mapping. The operator mounts it under whatever URL scheme they use: `app.route('/t/:tenant/p/:project/auth', createAuthApp(cfg))`.

**Tech Stack:** TypeScript, bun, hono, @hono/zod-validator, zod, @libsql/client, `core` workspace. Builds on `packages/auth` (P1–P5).

> **P6 is decomposed.** This plan (P6a) is HTTP serving only. Separate follow-up plans: P6b consistency tokens, P6c perf (shared memo + reverse index + governance fan-out caps), P6d packaging (publishable build, replace the relative `../../core/src` import). Each is independent.

---

## Conventions (same as prior phases)

- `bun test`; `{ expect, test } from 'bun:test'`. Import core via `../../core/src/index.ts`; `.ts` extensions.
- **isolatedDeclarations ON** — exported decls need explicit return types referencing exported/nameable types.
- **Do NOT run `bun run format`** (dirties `packages/core`). Use `bun run lint`.
- HTTP tests use Hono's in-memory `app.request(path, init)` — no network/port.
- After each task: `bun test packages/auth` green. **Do not commit** unless the human asks. **Zero core changes.**

## Contract

`createAuthApp(cfg)` → `Hono<AuthEnv>`. Request flow per route: `authn` (run `cfg.authenticate`, 401 on throw) → `requireAuth(op)` (run `cfg.resolveAuth(c, principal, op)`, put `Auth` on ctx; 403 on throw unless it throws an `HTTPException`) → handler.

Routes (paths are relative — the operator mounts under a tenant/project prefix; `resolveAuth` reads `c.req.param(...)` to pick the namespace):

| Method + path        | op    | body                                                | response             |
| -------------------- | ----- | --------------------------------------------------- | -------------------- |
| `POST /check`        | read  | `{object, relation, subject, asOf?}`                | `{allowed: boolean}` |
| `POST /expand`       | read  | `{object, relation, asOf?}`                         | `UsersetTree`        |
| `POST /list-objects` | read  | `{subject, relation, type, asOf?, limit?, cursor?}` | `ListObjectsPage`    |
| `POST /tuples`       | write | `{writes?: Tuple[], deletes?: Tuple[]}`             | `{ok: true}`         |

Error mapping (`app.onError`): `HTTPException` passthrough; `ZodError` → 400 `{error:'validation', issues}`; any `Error` whose message starts `auth:` (model validation — unknown type/relation, etc.) → 400 `{error}`; else → 500 `{error:'internal'}`.

## Files changed

```
packages/auth/
  package.json          — MODIFY: add hono + @hono/zod-validator deps
  src/http.ts           — CREATE: createAuthApp, AuthServeConfig, AuthEnv, AuthOp + middleware + routes + onError
  src/index.ts          — MODIFY: export createAuthApp + the serve types
  test/p6-http.test.ts  — CREATE
```

---

## Task 1: Package deps + `createAuthApp` skeleton + `/check` + `/tuples`

**Files:**

- Modify: `packages/auth/package.json`
- Create: `packages/auth/src/http.ts`
- Test: `packages/auth/test/p6-http.test.ts`

- [ ] **Step 1: Add deps to `packages/auth/package.json`**

Add to `dependencies` (alphabetical), then run `bun install` from repo root:

```json
		"@hono/zod-validator": "^0.8.0",
		"hono": "^4.12.23",
```

(Match the versions core uses. After editing, run: `bun install`.)

- [ ] **Step 2: Write the failing test** — `packages/auth/test/p6-http.test.ts`

```typescript
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import { createAuthApp } from '../src/http.ts';
import { defineAuthModel, rel } from '../src/model.ts';

const MODEL = defineAuthModel({ user: {}, doc: { editor: rel(), viewer: rel().or('editor') } });

async function freshApp(): Promise<{ db: Client; app: ReturnType<typeof createAuthApp> }> {
	const db = createClient({ url: ':memory:' });
	await init(db, 4);
	const auth = new Auth(new Graph(db, MODEL.schema), MODEL);
	const app = createAuthApp({
		// L1 authn: require a bearer token, else throw → 401
		authenticate: (c) => {
			if (!c.req.header('authorization')) throw new Error('no token');
			return { svc: 'app' };
		},
		// resolve the engine; deny writes for a "reader" token → 403
		resolveAuth: (c, _principal, op) => {
			if (op === 'write' && c.req.header('authorization') === 'Bearer reader') {
				throw new HTTPException(403, { message: 'read-only' });
			}
			return auth;
		},
	});
	return { db, app };
}

const H = { authorization: 'Bearer writer', 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createAuthApp>, path: string, body: unknown, headers = H) =>
	app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

test('P6: /tuples writes, then /check reflects it', async () => {
	const { db, app } = await freshApp();
	const w = await post(app, '/tuples', {
		writes: [{ object: 'doc:1', relation: 'editor', subject: 'user:alice' }],
	});
	expect(w.status).toBe(200);
	expect(await w.json()).toEqual({ ok: true });

	const r = await post(app, '/check', {
		object: 'doc:1',
		relation: 'viewer',
		subject: 'user:alice',
	});
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ allowed: true }); // via editor⇒viewer
	db.close();
});

test('P6: /check is false for a non-grant', async () => {
	const { db, app } = await freshApp();
	const r = await post(app, '/check', { object: 'doc:1', relation: 'viewer', subject: 'user:bob' });
	expect(await r.json()).toEqual({ allowed: false });
	db.close();
});

test('P6: 401 when authn throws (no token)', async () => {
	const { db, app } = await freshApp();
	const r = await post(
		app,
		'/check',
		{ object: 'doc:1', relation: 'viewer', subject: 'user:a' },
		{
			'content-type': 'application/json',
		},
	);
	expect(r.status).toBe(401);
	db.close();
});

test('P6: 403 when resolveAuth denies the op', async () => {
	const { db, app } = await freshApp();
	const r = await post(
		app,
		'/tuples',
		{ writes: [{ object: 'doc:1', relation: 'editor', subject: 'user:a' }] },
		{ authorization: 'Bearer reader', 'content-type': 'application/json' },
	);
	expect(r.status).toBe(403);
	db.close();
});

test('P6: 400 on a malformed body', async () => {
	const { db, app } = await freshApp();
	const r = await post(app, '/check', { object: 'doc:1' }); // missing relation/subject
	expect(r.status).toBe(400);
	db.close();
});

test('P6: 400 on an unknown relation (model validation)', async () => {
	const { db, app } = await freshApp();
	const r = await post(app, '/check', { object: 'doc:1', relation: 'owner', subject: 'user:a' });
	expect(r.status).toBe(400);
	db.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/auth/test/p6-http.test.ts`
Expected: FAIL — `../src/http.ts` missing.

- [ ] **Step 4: Create `packages/auth/src/http.ts`**

```typescript
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z, ZodError } from 'zod';
import type { Auth } from './auth.ts';

/** Operation class for a route — passed to `resolveAuth` so operators can gate writes. */
export type AuthOp = 'read' | 'write';

/** Per-request server config. `authenticate` is L1; `resolveAuth` yields the engine for the request. */
export interface AuthServeConfig {
	/** L1 authn: verify the request → an opaque principal. Throw to reject (mapped to 401). */
	authenticate: (c: Context) => unknown | Promise<unknown>;
	/**
	 * Resolve the {@link Auth} engine for this request and op (the operator owns tenant/project →
	 * `${project}__auth` namespace resolution + op-level authz). Throw an {@link HTTPException} for a
	 * precise status, or any error → 403.
	 */
	resolveAuth: (c: Context, principal: unknown, op: AuthOp) => Auth | Promise<Auth>;
}

/** Hono env: the per-request principal + the resolved engine. */
export type AuthEnv = { Variables: { principal: unknown; auth: Auth } };

const tupleSchema = z.object({
	object: z.string(),
	relation: z.string(),
	subject: z.string(),
	subjectRelation: z.string().optional(),
});
const tuplesBody = z.object({
	writes: z.array(tupleSchema).default([]),
	deletes: z.array(tupleSchema).default([]),
});
const checkBody = z.object({
	object: z.string(),
	relation: z.string(),
	subject: z.string(),
	asOf: z.number().optional(),
});
const expandBody = z.object({
	object: z.string(),
	relation: z.string(),
	asOf: z.number().optional(),
});
const listBody = z.object({
	subject: z.string(),
	relation: z.string(),
	type: z.string(),
	asOf: z.number().optional(),
	limit: z.number().optional(),
	cursor: z.string().optional(),
});

function authn(cfg: AuthServeConfig): MiddlewareHandler<AuthEnv> {
	return createMiddleware<AuthEnv>(async (c, next) => {
		let principal: unknown;
		try {
			principal = await cfg.authenticate(c);
		} catch {
			throw new HTTPException(401, { message: 'unauthenticated' });
		}
		c.set('principal', principal);
		await next();
	});
}

function requireAuth(cfg: AuthServeConfig, op: AuthOp): MiddlewareHandler<AuthEnv> {
	return createMiddleware<AuthEnv>(async (c, next) => {
		let auth: Auth;
		try {
			auth = await cfg.resolveAuth(c, c.get('principal'), op);
		} catch (e) {
			if (e instanceof HTTPException) throw e;
			throw new HTTPException(403, { message: 'forbidden' });
		}
		c.set('auth', auth);
		await next();
	});
}

function onError(err: Error, c: Context): Response {
	if (err instanceof HTTPException) return err.getResponse();
	if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
	// Model validation (unknown type/relation, unsupported subject) throws `Error('auth: ...')`.
	if (/^auth:/.test(err.message)) return c.json({ error: err.message }, 400);
	return c.json({ error: 'internal' }, 500);
}

/**
 * Build a standalone Hono app exposing the ReBAC engine. Mount it under your URL scheme,
 * e.g. `app.route('/t/:tenant/p/:project/auth', createAuthApp(cfg))`, and have `cfg.resolveAuth`
 * read the route params to select the project's auth engine.
 */
export function createAuthApp(cfg: AuthServeConfig): Hono<AuthEnv> {
	const app = new Hono<AuthEnv>()
		.post(
			'/check',
			authn(cfg),
			requireAuth(cfg, 'read'),
			zValidator('json', checkBody),
			async (c) => {
				const { object, relation, subject, asOf } = c.req.valid('json');
				const allowed = await c.get('auth').check(object, relation, subject, { asOf });
				return c.json({ allowed });
			},
		)
		.post(
			'/tuples',
			authn(cfg),
			requireAuth(cfg, 'write'),
			zValidator('json', tuplesBody),
			async (c) => {
				const { writes, deletes } = c.req.valid('json');
				const auth = c.get('auth');
				if (writes.length > 0) await auth.write(writes);
				if (deletes.length > 0) await auth.delete(deletes);
				return c.json({ ok: true });
			},
		);
	app.onError(onError);
	return app;
}
```

> Note: `authn`/`requireAuth` are attached per-route (rather than `app.use`) so the chained `.post(...)` type stays precise and isolatedDeclarations can emit `Hono<AuthEnv>`. `/expand` + `/list-objects` are added in Task 2.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/auth/test/p6-http.test.ts`
Expected: PASS (6 tests). (`/expand`, `/list-objects` not yet routed — Task 2.)

- [ ] **Step 6: Commit** (skip if holding commits)

```bash
git add packages/auth/package.json packages/auth/src/http.ts packages/auth/test/p6-http.test.ts bun.lock
git commit -m "feat(auth): HTTP serving — createAuthApp + /check + /tuples (P6a)"
```

---

## Task 2: `/expand` + `/list-objects` routes + exports + green gate

**Files:**

- Modify: `packages/auth/src/http.ts`, `packages/auth/src/index.ts`
- Test: `packages/auth/test/p6-http.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `packages/auth/test/p6-http.test.ts`

```typescript
test('P6: /expand returns the userset tree', async () => {
	const { db, app } = await freshApp();
	await post(app, '/tuples', {
		writes: [{ object: 'doc:1', relation: 'editor', subject: 'user:alice' }],
	});
	const r = await post(app, '/expand', { object: 'doc:1', relation: 'viewer' });
	expect(r.status).toBe(200);
	const tree = await r.json();
	// doc.viewer = union(self, computed(editor)); editor leaf has alice
	expect(tree).toEqual({
		type: 'union',
		children: [
			{ type: 'leaf', subjects: [], usersets: [] },
			{ type: 'leaf', subjects: ['user:alice'], usersets: [] },
		],
	});
	db.close();
});

test('P6: /list-objects returns a page', async () => {
	const { db, app } = await freshApp();
	await post(app, '/tuples', {
		writes: [
			{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
			{ object: 'doc:2', relation: 'editor', subject: 'user:alice' },
		],
	});
	const r = await post(app, '/list-objects', {
		subject: 'user:alice',
		relation: 'viewer',
		type: 'doc',
	});
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ objects: ['doc:1', 'doc:2'], nextCursor: null });
	db.close();
});

test('P6: /list-objects paginates via limit + cursor', async () => {
	const { db, app } = await freshApp();
	await post(app, '/tuples', {
		writes: [
			{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
			{ object: 'doc:2', relation: 'viewer', subject: 'user:alice' },
		],
	});
	const p1 = await (
		await post(app, '/list-objects', {
			subject: 'user:alice',
			relation: 'viewer',
			type: 'doc',
			limit: 1,
		})
	).json();
	expect(p1).toEqual({ objects: ['doc:1'], nextCursor: 'doc:1' });
	const p2 = await (
		await post(app, '/list-objects', {
			subject: 'user:alice',
			relation: 'viewer',
			type: 'doc',
			limit: 1,
			cursor: 'doc:1',
		})
	).json();
	expect(p2).toEqual({ objects: ['doc:2'], nextCursor: 'doc:2' });
	db.close();
});
```

> The pagination test's `nextCursor: 'doc:2'` on the last page reflects P5's page-fill semantics (cursor = last returned id when the page fills). A subsequent page from `doc:2` would return `{objects: [], nextCursor: null}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/auth/test/p6-http.test.ts`
Expected: FAIL — `/expand` and `/list-objects` return 404 (not routed).

- [ ] **Step 3: Add the two routes in `createAuthApp` (`packages/auth/src/http.ts`)**

Chain them onto the app (after `/tuples`, before `app.onError`):

```typescript
		.post('/expand', authn(cfg), requireAuth(cfg, 'read'), zValidator('json', expandBody), async (c) => {
			const { object, relation, asOf } = c.req.valid('json');
			return c.json(await c.get('auth').expand(object, relation, { asOf }));
		})
		.post(
			'/list-objects',
			authn(cfg),
			requireAuth(cfg, 'read'),
			zValidator('json', listBody),
			async (c) => {
				const { subject, relation, type, asOf, limit, cursor } = c.req.valid('json');
				return c.json(await c.get('auth').listObjects(subject, relation, type, { asOf, limit, cursor }));
			},
		);
```

- [ ] **Step 4: Export from `packages/auth/src/index.ts`**

Add:

```typescript
export { type AuthEnv, type AuthOp, type AuthServeConfig, createAuthApp } from './http.ts';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/auth/test/p6-http.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Full suite + type-check + lint + scope check**

Run: `bun test packages/auth` → all P1–P6a green.
Run: `cd packages/auth && tsc --noEmit` → clean.
Run: `bun run lint` → clean (NOT `bun run format`).
Run: `git diff --name-only -- packages/core` → empty.

- [ ] **Step 7: Commit** (skip if holding commits)

```bash
git add packages/auth/src/http.ts packages/auth/src/index.ts packages/auth/test/p6-http.test.ts
git commit -m "feat(auth): HTTP serving — /expand + /list-objects (P6a complete)"
```

---

## Self-Review (completed during planning)

- **Scope:** P6a = HTTP serving only. Consistency tokens (P6b), perf (P6c), packaging (P6d) are separate plans — noted, not crammed in.
- **Architecture:** standalone Hono sub-app, operator-injected `authenticate`/`resolveAuth` → preserves the zero-core-change invariant (no edit to core's `serve.ts`). Operator composes via `app.route(...)`.
- **Placeholders:** none.
- **Type consistency:** `createAuthApp(cfg: AuthServeConfig): Hono<AuthEnv>`; handlers call the existing `Auth.{check,expand,listObjects,write,delete}` with their P1–P5 signatures; wire schemas mirror `Tuple` + the opts shapes. Per-route middleware keeps the chain type precise for isolatedDeclarations.
- **Error mapping:** 401 (authn), 403 (resolveAuth / HTTPException), 400 (ZodError + `auth:`-prefixed model errors), 500 (else) — tested.
- **Tests:** in-memory `app.request` (no port); covers each route, authz (401/403), validation (400 bad body + unknown relation), and pagination over HTTP.
- **Zero-core-change** preserved; formatter trap flagged.

## Remaining P6 (separate plans)

| Plan | Scope                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6b  | consistency tokens — opaque snapshot token wrapping `asOf` (read-your-writes / repeatable reads)                                                              |
| P6c  | perf — shared memo across `listObjects` candidates; materialized reverse index; wire §19.2 governance fan-out caps into `check`/`edgesInto`/`reachableOfType` |
| P6d  | packaging — publishable `graphx-auth` (workspace dep + bunup build; replace the relative `../../core/src` import with the `core` package import)              |
