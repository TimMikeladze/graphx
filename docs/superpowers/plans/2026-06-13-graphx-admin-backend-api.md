# @graphx/admin Backend API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the HTTP/SDK surface the `@graphx/admin` UI needs — operator-scoped control-plane CRUD, governed node list/graph-slice reads, and node history — all on the existing `@graphx/core` Hono app.

**Architecture:** Two auth realms in one process. (1) A new mounted Hono sub-app (`createAdminApp`) gates control-plane registry CRUD behind an operator credential. (2) New tenant-scoped read routes (`/nodes`, `/graph`, `/nodes/:id/history`) reuse the existing `requireGraph('read')` middleware; cross-tenant operator browsing works via a one-field `Principal.operator` bypass in `authorize`. New read primitives are `Graph` methods (`listNodes`, `graphSlice`) reusing the class's private parsing/upcasting — not a separate file (spec §3 said `list.ts`; methods are more consistent with `neighbors`/`neighborsPage` and reach `rowToNode`).

**Tech Stack:** Bun, libSQL (`@libsql/client`), Hono, `@hono/zod-validator`, Zod 4, `bun:test`. In-memory libSQL (`:memory:`) for tests, matching the existing 244-test suite.

**Spec refinements (decided during planning, deviating from `2026-06-12-graphx-admin-ui-design.md`):**

- §3/§4: operator impersonation is NOT "zero authz change". `authorize()` reads membership from a table, so a synthesized principal alone fails the membership check (403). Resolution: add optional `Principal.operator` and a one-line bypass in `authorize`. The consumer's `authenticate` returns an operator principal (`tenantId` taken from the route param) when it recognizes the admin token.
- §3: `listNodes`/`graphSlice` are methods on `Graph` (in `graph.ts`), not a new `src/list.ts`.

---

## File Structure

- **Modify** `packages/core/src/authz.ts` — add `Principal.operator?: boolean` + bypass in `authorize`.
- **Modify** `packages/core/src/control-plane.ts` — add `listTenants`, `listProjects`, `listUsers`, `hashApiKey`, `createApiKey`.
- **Modify** `packages/core/src/graph.ts` — add `NodeListOpts`/`NodeListPage`/`GraphSliceOpts`/`GraphSlice`/`GraphSliceNode`/`GraphSliceLink` types, a private `ftsMatch` helper, and `Graph.listNodes` + `Graph.graphSlice` methods.
- **Create** `packages/core/src/admin.ts` — `AdminConfig` + `createAdminApp(cfg)` (operator-auth sub-app + CRUD routes).
- **Modify** `packages/core/src/serve.ts` — add `/nodes`, `/graph`, `/nodes/:id/history` routes + `invalid cursor` → 400 in `onError` + import `history`.
- **Modify** `packages/core/src/index.ts` — export the new symbols/types.
- **Create** `packages/core/test/admin-authz.test.ts` — operator bypass.
- **Create** `packages/core/test/admin-controlplane.test.ts` — control-plane list/create helpers.
- **Create** `packages/core/test/admin-list.test.ts` — `listNodes`/`graphSlice`.
- **Create** `packages/core/test/admin-routes.test.ts` — the three read routes + operator impersonation over HTTP.
- **Create** `packages/core/test/admin-app.test.ts` — `createAdminApp` CRUD + auth gate.

All `bun test` commands run from the repo root `/Users/tim/workspace/graphx`.

---

### Task 1: `Principal.operator` bypass in authz

**Files:**

- Modify: `packages/core/src/authz.ts:8-12` (Principal), `packages/core/src/authz.ts:41-69` (authorize)
- Test: `packages/core/test/admin-authz.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/admin-authz.test.ts`:

```ts
import { createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { authorize, AuthzError } from '../src/authz.ts';
import { createProject, createTenant, initControl } from '../src/control-plane.ts';

async function controlWithProject() {
	const control = createClient({ url: ':memory:' });
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const ns = `ns_${ulid().toLowerCase()}`;
	const project = await createProject(control, {
		tenantId: tenant,
		name: 'Alpha',
		dbNamespace: ns,
	});
	return { control, tenant, project, ns };
}

test('operator principal bypasses membership check and resolves the namespace', async () => {
	const { control, tenant, project, ns } = await controlWithProject();
	// No membership row exists for this operator user at all.
	const res = await authorize(
		control,
		{ userId: 'operator', tenantId: tenant, operator: true },
		project,
		'write',
	);
	expect(res.dbNamespace).toBe(ns);
	control.close();
});

test('operator still cannot reach a project outside the principal tenant (404, no leak)', async () => {
	const { control, project } = await controlWithProject();
	await expect(
		authorize(
			control,
			{ userId: 'operator', tenantId: 'some-other-tenant', operator: true },
			project,
			'read',
		),
	).rejects.toBeInstanceOf(AuthzError);
	control.close();
});

test('non-operator with no membership is still 403', async () => {
	const { control, tenant, project } = await controlWithProject();
	await expect(
		authorize(control, { userId: 'nobody', tenantId: tenant }, project, 'read'),
	).rejects.toMatchObject({ status: 403 });
	control.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/admin-authz.test.ts`
Expected: FAIL — the first test fails with a 403 `AuthzError` ("no membership in tenant") because `operator` is not yet honored.

- [ ] **Step 3: Add the `operator` field**

In `packages/core/src/authz.ts`, replace the `Principal` interface (lines 8-12):

```ts
/** Authenticated caller: carried on the request context after authn (§3.2 layer 1). */
export interface Principal {
	userId: string;
	tenantId: string;
	/**
	 * Operator (admin) principal. When true, {@link authorize} still enforces that the project
	 * belongs to `tenantId` (no cross-tenant leak) but SKIPS the per-tenant membership/role
	 * lookup — operators have no `memberships` row. Set by the consumer's `authenticate` when it
	 * recognizes the admin credential; `tenantId` should be taken from the request's route tenant.
	 */
	operator?: boolean;
}
```

- [ ] **Step 4: Add the bypass in `authorize`**

In `packages/core/src/authz.ts`, inside `authorize`, immediately AFTER the project-tenant check (right after the `if (!row || String(row.tenant_id) !== principal.tenantId) { throw new AuthzError(404, 'project not found'); }` block, before the `const mem = ...` membership query), insert:

```ts
// Operator bypass: the project-tenant guard above already ran (no cross-tenant leak), so an
// operator is authorized for any op without a membership row. End users fall through to the
// membership/role check below.
if (principal.operator) {
	return { dbNamespace: String(row.db_namespace) };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/test/admin-authz.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/authz.ts packages/core/test/admin-authz.test.ts
git commit -m "feat(core): operator principal bypass in authorize (admin cross-tenant reads)"
```

---

### Task 2: Control-plane list/create helpers

**Files:**

- Modify: `packages/core/src/control-plane.ts` (append after `createProject`, end of file ~line 76)
- Test: `packages/core/test/admin-controlplane.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/admin-controlplane.test.ts`:

```ts
import { createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import {
	createApiKey,
	createProject,
	createTenant,
	createUser,
	hashApiKey,
	initControl,
	listProjects,
	listTenants,
	listUsers,
} from '../src/control-plane.ts';

async function freshControl() {
	const control = createClient({ url: ':memory:' });
	await initControl(control);
	return control;
}

test('listTenants returns created tenants by name', async () => {
	const control = await freshControl();
	await createTenant(control, { name: 'Globex' });
	await createTenant(control, { name: 'Acme' });
	const tenants = await listTenants(control);
	expect(tenants.map((t) => t.name)).toEqual(['Acme', 'Globex']);
	expect(tenants[0].id.length).toBe(26);
	control.close();
});

test('listProjects is scoped to one tenant', async () => {
	const control = await freshControl();
	const a = await createTenant(control, { name: 'A' });
	const b = await createTenant(control, { name: 'B' });
	await createProject(control, {
		tenantId: a,
		name: 'Alpha',
		dbNamespace: `ns_${ulid().toLowerCase()}`,
	});
	await createProject(control, {
		tenantId: b,
		name: 'Beta',
		dbNamespace: `ns_${ulid().toLowerCase()}`,
	});
	const projA = await listProjects(control, a);
	expect(projA.map((p) => p.name)).toEqual(['Alpha']);
	expect(projA[0].dbNamespace.startsWith('ns_')).toBe(true);
	control.close();
});

test('listUsers returns created users by email', async () => {
	const control = await freshControl();
	await createUser(control, { email: 'b@test.dev' });
	await createUser(control, { email: 'a@test.dev' });
	const users = await listUsers(control);
	expect(users.map((u) => u.email)).toEqual(['a@test.dev', 'b@test.dev']);
	control.close();
});

test('createApiKey stores only the hash and returns the plaintext once', async () => {
	const control = await freshControl();
	const tenant = await createTenant(control, { name: 'Acme' });
	const { key } = await createApiKey(control, { tenantId: tenant, scopes: ['read'] });
	expect(key.startsWith('gxk_')).toBe(true);
	const stored = await control.execute('SELECT hash, tenant_id, scopes FROM api_keys');
	expect(stored.rows.length).toBe(1);
	expect(String(stored.rows[0].hash)).toBe(hashApiKey(key)); // only the hash is persisted
	expect(String(stored.rows[0].hash)).not.toBe(key);
	expect(JSON.parse(String(stored.rows[0].scopes))).toEqual(['read']);
	control.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/admin-controlplane.test.ts`
Expected: FAIL — `listTenants`, `listProjects`, `listUsers`, `createApiKey`, `hashApiKey` are not exported.

- [ ] **Step 3: Implement the helpers**

In `packages/core/src/control-plane.ts`, add this import at the top (after the existing imports on lines 1-3):

```ts
import { createHash, randomBytes } from 'node:crypto';
```

Then append at the end of the file (after `createProject`):

```ts
/** List all tenants (registry read for the admin UI), ordered by name. */
export async function listTenants(control: Client): Promise<Array<{ id: string; name: string }>> {
	const r = await control.execute('SELECT id, name FROM tenants ORDER BY name');
	return r.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

/** List a tenant's projects (with their sqld namespace), ordered by name. */
export async function listProjects(
	control: Client,
	tenantId: string,
): Promise<Array<{ id: string; name: string; dbNamespace: string }>> {
	const r = await control.execute({
		sql: 'SELECT id, name, db_namespace FROM projects WHERE tenant_id = ? ORDER BY name',
		args: [tenantId],
	});
	return r.rows.map((row) => ({
		id: String(row.id),
		name: String(row.name),
		dbNamespace: String(row.db_namespace),
	}));
}

/** List all users (registry read for the admin UI), ordered by email. */
export async function listUsers(control: Client): Promise<Array<{ id: string; email: string }>> {
	const r = await control.execute('SELECT id, email FROM users ORDER BY email');
	return r.rows.map((row) => ({ id: String(row.id), email: String(row.email) }));
}

/** The stored hash for an API key (sha256 hex). Exported so an `authenticate` impl can verify a presented key. */
export function hashApiKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

/**
 * Mint an API key for a tenant. Stores ONLY the {@link hashApiKey} hash (never the plaintext)
 * and returns the plaintext key exactly once — the caller must surface it immediately.
 */
export async function createApiKey(
	control: Client,
	a: { tenantId: string; scopes: string[] },
): Promise<{ key: string }> {
	const key = `gxk_${randomBytes(24).toString('base64url')}`;
	await control.execute({
		sql: 'INSERT INTO api_keys (hash, tenant_id, scopes, created_at) VALUES (?, ?, ?, ?)',
		args: [hashApiKey(key), a.tenantId, JSON.stringify(a.scopes), Date.now()],
	});
	return { key };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/admin-controlplane.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/control-plane.ts packages/core/test/admin-controlplane.test.ts
git commit -m "feat(core): control-plane list helpers + api-key minting (admin registry reads)"
```

---

### Task 3: `Graph.listNodes` — governed, temporal, filterable node list

**Files:**

- Modify: `packages/core/src/graph.ts` (add types near line 93; add `ftsMatch` + `listNodes` inside the `Graph` class, e.g. after `neighborsPage` ends at line 399)
- Test: `packages/core/test/admin-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/admin-list.test.ts`:

```ts
import { createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string() }),
		person: z.object({ name: z.string() }),
	},
	edges: { knows: { from: 'person', to: 'person' }, owns: { from: 'person', to: 'device' } },
});

async function graph() {
	const raw = createClient({ url: ':memory:' });
	await init(raw);
	return new Graph(raw, SCHEMA);
}

test('listNodes returns all live nodes ordered by id with nextCursor=null when they fit', async () => {
	const g = await graph();
	const a = await g.addNode({ kind: 'person', props: { name: 'a' } });
	const b = await g.addNode({ kind: 'device', props: { type: 'router' } });
	const page = await g.listNodes();
	expect(page.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
	expect(page.nextCursor).toBeNull();
	g.raw.close();
});

test('listNodes filters by kind', async () => {
	const g = await graph();
	await g.addNode({ kind: 'person', props: { name: 'a' } });
	const d = await g.addNode({ kind: 'device', props: { type: 'router' } });
	const page = await g.listNodes({ kind: 'device' });
	expect(page.nodes.map((n) => n.id)).toEqual([d.id]);
	g.raw.close();
});

test('listNodes full-text filters on body via FTS', async () => {
	const g = await graph();
	const hit = await g.addNode({
		kind: 'device',
		props: { type: 'router' },
		body: 'mercury gateway',
	});
	await g.addNode({ kind: 'device', props: { type: 'switch' }, body: 'venus relay' });
	const page = await g.listNodes({ q: 'mercury' });
	expect(page.nodes.map((n) => n.id)).toEqual([hit.id]);
	g.raw.close();
});

test('listNodes keyset-paginates with cursor', async () => {
	const g = await graph();
	const ids: string[] = [];
	for (let i = 0; i < 3; i++)
		ids.push((await g.addNode({ kind: 'person', props: { name: `p${i}` } })).id);
	ids.sort();
	const p1 = await g.listNodes({ limit: 2 });
	expect(p1.nodes.map((n) => n.id)).toEqual(ids.slice(0, 2));
	expect(p1.nextCursor).not.toBeNull();
	const p2 = await g.listNodes({ limit: 2, cursor: p1.nextCursor! });
	expect(p2.nodes.map((n) => n.id)).toEqual(ids.slice(2));
	expect(p2.nextCursor).toBeNull();
	g.raw.close();
});

test('listNodes maxRows cap bounds the page', async () => {
	const g = await graph();
	for (let i = 0; i < 5; i++) await g.addNode({ kind: 'person', props: { name: `p${i}` } });
	const page = await g.listNodes({ limits: { maxRows: 2 } });
	expect(page.nodes.length).toBe(2);
	g.raw.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/admin-list.test.ts`
Expected: FAIL — `g.listNodes is not a function`.

- [ ] **Step 3: Add the option/return types**

In `packages/core/src/graph.ts`, after the `NeighborPage` interface (ends line 93), add:

```ts
/** Filter/pagination options for {@link Graph.listNodes}. */
export interface NodeListOpts {
	/** Restrict to one node kind. */
	kind?: string;
	/** Full-text query over `body` (FTS5). No usable tokens ⇒ empty page. */
	q?: string;
	/** As-of epoch ms (D3 half-open read). Omit ⇒ current (live) nodes. */
	asOf?: number;
	/** Page size; clamped to `maxRows`. Defaults to `maxRows`. */
	limit?: number;
	/** Opaque keyset cursor from a prior page's `nextCursor`; omit for the first page. */
	cursor?: string;
	/** §19.2 governance caps; `maxRows` bounds the page (default 10k). */
	limits?: Partial<QueryLimits>;
}

/** One page of {@link Graph.listNodes}: the rows + the cursor for the next page. */
export interface NodeListPage<S extends GraphSchema> {
	nodes: AnyNode<S>[];
	/** `null` when this is the last page. */
	nextCursor: string | null;
}

/** Filter options for {@link Graph.graphSlice}. */
export interface GraphSliceOpts {
	kind?: string;
	q?: string;
	asOf?: number;
	limits?: Partial<QueryLimits>;
}

/** A canvas node in a {@link GraphSlice}. */
export interface GraphSliceNode {
	id: string;
	kind: string;
}

/** A canvas link in a {@link GraphSlice} (Cosmograph `source`/`target` naming). */
export interface GraphSliceLink {
	id: string;
	source: string;
	target: string;
	rel: string;
	weight: number;
}

/** A governed graph slice for the Cosmograph canvas: the filtered node set + edges among them. */
export interface GraphSlice {
	nodes: GraphSliceNode[];
	links: GraphSliceLink[];
	/** True when the node set hit the `maxRows` cap (UI shows a "narrow filters" banner). */
	truncated: boolean;
}
```

- [ ] **Step 4: Add the `ftsMatch` helper + `listNodes` method**

In `packages/core/src/graph.ts`, inside the `Graph` class, add a private helper and the method (place after `neighborsPage`, before `runWriteBatch` at line 408):

```ts
	/**
	 * FTS5 MATCH expression from a free-text query: each whitespace token quoted (quotes
	 * doubled) and OR-joined. Mirrors `sanitizeMatch` in hybrid.ts — inlined here to avoid an
	 * import cycle (hybrid → retrieve → graph). `null` when the query has no usable tokens.
	 */
	private ftsMatch(query: string): string | null {
		const tokens = query
			.split(/\s+/)
			.filter((t) => t.length > 0)
			.map((t) => `"${t.replace(/"/g, '""')}"`);
		return tokens.length > 0 ? tokens.join(' OR ') : null;
	}

	/**
	 * Build the node-filter WHERE for {@link listNodes}/{@link graphSlice} over `node_versions`
	 * aliased `nv`: a temporal predicate (live via the FOREVER sentinel, or as-of half-open),
	 * an optional `kind`, and an optional FTS `q` (joined by `ver` into `nodes_fts`). Returns
	 * `null` when `q` is present but yields no tokens (⇒ caller returns an empty result).
	 */
	private nodeFilter(opts: {
		kind?: string;
		q?: string;
		asOf?: number;
	}): { where: string; args: (string | number)[] } | null {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (opts.asOf !== undefined) {
			where.push('nv.valid_from <= ? AND ? < nv.valid_to');
			args.push(opts.asOf, opts.asOf);
		} else {
			where.push('nv.valid_to = ?');
			args.push(FOREVER);
		}
		if (opts.kind) {
			where.push('nv.kind = ?');
			args.push(opts.kind);
		}
		if (opts.q !== undefined) {
			const match = this.ftsMatch(opts.q);
			if (match === null) return null;
			where.push('nv.ver IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)');
			args.push(match);
		}
		return { where: where.join(' AND '), args };
	}

	/**
	 * List nodes with optional `kind`/full-text/as-of filters, keyset-paginated by id (§19.7)
	 * and bounded by the §19.2 row cap. Each id has exactly one matching version (live, or the
	 * single as-of version), so the id keyset is a strict total order — no skip, no overlap.
	 * Props are upcast + parsed via the same path as `getNode`/`neighbors` (P12).
	 */
	async listNodes(opts: NodeListOpts = {}): Promise<NodeListPage<S>> {
		if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
			throw new Error(`listNodes: limit must be a positive integer, got ${opts.limit}`);
		}
		const filter = this.nodeFilter(opts);
		if (filter === null) return { nodes: [], nextCursor: null };
		const maxRows = resolveLimits(opts.limits).maxRows;
		const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
		const args = [...filter.args];
		let cursorClause = '';
		if (opts.cursor) {
			const [lastId] = decodeCursor(opts.cursor);
			cursorClause = ' AND nv.id > ?';
			args.push(lastId as string);
		}
		const sql = `SELECT nv.id AS id, nv.kind AS kind, nv.props AS props
			FROM node_versions nv
			WHERE ${filter.where}${cursorClause}
			ORDER BY nv.id
			LIMIT ?`;
		args.push(pageSize + 1); // over-fetch one to detect a next page
		const r = await this.raw.execute({ sql, args });
		const rows = r.rows.map((row) => this.rowToNode(row));
		if (rows.length > pageSize) {
			const page = rows.slice(0, pageSize);
			return { nodes: page, nextCursor: encodeCursor([(page[page.length - 1] as AnyNode<S>).id]) };
		}
		return { nodes: rows, nextCursor: null };
	}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/core/test/admin-list.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/graph.ts packages/core/test/admin-list.test.ts
git commit -m "feat(core): Graph.listNodes — governed temporal/kind/FTS node list (admin master)"
```

---

### Task 4: `Graph.graphSlice` — governed `{nodes, links}` for the canvas

**Files:**

- Modify: `packages/core/src/graph.ts` (add `graphSlice` after `listNodes`)
- Test: `packages/core/test/admin-list.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/admin-list.test.ts`:

```ts
test('graphSlice returns the node set and only edges with both endpoints inside it', async () => {
	const g = await graph();
	const p1 = await g.addNode({ kind: 'person', props: { name: 'p1' } });
	const p2 = await g.addNode({ kind: 'person', props: { name: 'p2' } });
	const d1 = await g.addNode({ kind: 'device', props: { type: 'router' } });
	await g.addEdge({ rel: 'knows', src: p1.id, dst: p2.id });
	await g.addEdge({ rel: 'owns', src: p1.id, dst: d1.id });

	// Unfiltered: all 3 nodes, both edges.
	const all = await g.graphSlice();
	expect(all.nodes.map((n) => n.id).sort()).toEqual([p1.id, p2.id, d1.id].sort());
	expect(all.links.map((l) => l.rel).sort()).toEqual(['knows', 'owns']);
	expect(all.truncated).toBe(false);

	// kind=person drops d1, so the `owns` edge (endpoint d1 outside the set) is excluded.
	const persons = await g.graphSlice({ kind: 'person' });
	expect(persons.nodes.map((n) => n.id).sort()).toEqual([p1.id, p2.id].sort());
	expect(persons.links.map((l) => l.rel)).toEqual(['knows']);
	g.raw.close();
});

test('graphSlice links carry Cosmograph source/target/weight', async () => {
	const g = await graph();
	const p1 = await g.addNode({ kind: 'person', props: { name: 'p1' } });
	const p2 = await g.addNode({ kind: 'person', props: { name: 'p2' } });
	await g.addEdge({ rel: 'knows', src: p1.id, dst: p2.id, weight: 3 });
	const slice = await g.graphSlice();
	expect(slice.links[0]).toMatchObject({ source: p1.id, target: p2.id, rel: 'knows', weight: 3 });
	g.raw.close();
});

test('graphSlice sets truncated when the node set hits maxRows', async () => {
	const g = await graph();
	for (let i = 0; i < 5; i++) await g.addNode({ kind: 'person', props: { name: `p${i}` } });
	const slice = await g.graphSlice({ limits: { maxRows: 2 } });
	expect(slice.nodes.length).toBe(2);
	expect(slice.truncated).toBe(true);
	g.raw.close();
});

test('graphSlice with an unmatched full-text query returns empty', async () => {
	const g = await graph();
	await g.addNode({ kind: 'person', props: { name: 'p1' }, body: 'hello' });
	const slice = await g.graphSlice({ q: 'zzzznomatch' });
	expect(slice.nodes).toEqual([]);
	expect(slice.links).toEqual([]);
	g.raw.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/admin-list.test.ts`
Expected: FAIL — `g.graphSlice is not a function`.

- [ ] **Step 3: Implement `graphSlice`**

In `packages/core/src/graph.ts`, add inside the `Graph` class right after `listNodes`:

```ts
	/**
	 * A governed graph slice for the canvas (D-UI-3): the filtered node set (capped at the §19.2
	 * row cap) plus every edge whose BOTH endpoints are in that set. The node set is the same
	 * filter as {@link listNodes} (live or as-of), evaluated as an SQL subquery so the edge
	 * endpoint membership tests never materialize a giant `IN (...)` parameter list. `truncated`
	 * signals the node set hit the cap so the UI can prompt to narrow filters.
	 */
	async graphSlice(opts: GraphSliceOpts = {}): Promise<GraphSlice> {
		const filter = this.nodeFilter(opts);
		if (filter === null) return { nodes: [], links: [], truncated: false };
		const maxRows = resolveLimits(opts.limits).maxRows;

		// 1) The capped node set (id + kind). Reused as a subquery for the edge endpoint filter.
		const nodeSub = `SELECT nv.id AS id, nv.kind AS kind
			FROM node_versions nv
			WHERE ${filter.where}
			ORDER BY nv.id
			LIMIT ${Math.floor(maxRows)}`;
		const nodesRes = await this.raw.execute({ sql: nodeSub, args: filter.args });
		const nodes: GraphSliceNode[] = nodesRes.rows.map((r) => ({
			id: String(r.id),
			kind: String(r.kind),
		}));
		const truncated = nodes.length >= maxRows;

		if (nodes.length === 0) return { nodes, links: [], truncated };

		// 2) Edges among the node set. Live edges via the `edges` view; as-of via edge_versions.
		const idSub = `SELECT id FROM (${nodeSub})`;
		let edgeSql: string;
		const edgeArgs: (string | number)[] = [];
		if (opts.asOf !== undefined) {
			edgeSql = `SELECT ev.id AS id, ev.src AS source, ev.dst AS target, ev.rel AS rel, ev.weight AS weight
				FROM edge_versions ev
				WHERE (ev.valid_from <= ? AND ? < ev.valid_to)
					AND ev.src IN (${idSub}) AND ev.dst IN (${idSub})`;
			edgeArgs.push(opts.asOf, opts.asOf, ...filter.args, ...filter.args);
		} else {
			edgeSql = `SELECT e.id AS id, e.src AS source, e.dst AS target, e.rel AS rel, e.weight AS weight
				FROM edges e
				WHERE e.src IN (${idSub}) AND e.dst IN (${idSub})`;
			edgeArgs.push(...filter.args, ...filter.args);
		}
		const edgesRes = await this.raw.execute({ sql: edgeSql, args: edgeArgs });
		const links: GraphSliceLink[] = edgesRes.rows.map((r) => ({
			id: String(r.id),
			source: String(r.source),
			target: String(r.target),
			rel: String(r.rel),
			weight: Number(r.weight),
		}));
		return { nodes, links, truncated };
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/admin-list.test.ts`
Expected: PASS (9 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/graph.ts packages/core/test/admin-list.test.ts
git commit -m "feat(core): Graph.graphSlice — governed {nodes,links} canvas slice (admin viz)"
```

---

### Task 5: Tenant-scoped read routes (`/nodes`, `/graph`, `/nodes/:id/history`)

**Files:**

- Modify: `packages/core/src/serve.ts` (import `history`; add 3 query schemas; add 3 routes to the chain; add `invalid cursor` branch in `onError`)
- Test: `packages/core/test/admin-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/admin-routes.test.ts`:

```ts
import { rmSync } from 'node:fs';
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Principal } from '../src/authz.ts';
import {
	addMembership,
	createProject,
	createTenant,
	createUser,
	initControl,
} from '../src/control-plane.ts';
import { evict } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { createApp } from '../src/serve.ts';

const SCHEMA = defineGraphSchema({
	nodes: { device: z.object({ type: z.string() }), person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' }, owns: { from: 'person', to: 'device' } },
});

// authenticate: x-admin-token => operator principal scoped to the route tenant; else x-user/x-tenant.
function authenticate(c: {
	req: { header: (n: string) => string | undefined; param: (n: string) => string };
}): Principal {
	if (c.req.header('x-admin-token') === 'secret') {
		return { userId: 'operator', tenantId: c.req.param('tenant'), operator: true };
	}
	const userId = c.req.header('x-user');
	const tenantId = c.req.header('x-tenant');
	if (!userId || !tenantId) throw new Error('missing auth');
	return { userId, tenantId };
}

interface Setup {
	control: Client;
	app: ReturnType<typeof createApp<typeof SCHEMA>>;
	tenantA: string;
	editor: string;
	pA: string;
	nsA: string;
}

async function setup(): Promise<Setup> {
	const control = createClient({ url: ':memory:' });
	await initControl(control);
	const tenantA = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenantA, role: 'editor' });
	const nsA = `ns_${ulid().toLowerCase()}`;
	const pA = await createProject(control, { tenantId: tenantA, name: 'Alpha', dbNamespace: nsA });
	const app = createApp({ control, schema: SCHEMA, authenticate });
	return { control, app, tenantA, editor, pA, nsA };
}

function cleanup(s: Setup): void {
	evict(s.nsA);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${s.nsA}.db${sfx}`, { force: true });
	s.control.close();
}

function hdr(s: Setup): Record<string, string> {
	return { 'x-user': s.editor, 'x-tenant': s.tenantA, 'content-type': 'application/json' };
}

async function addNode(s: Setup, body: unknown): Promise<string> {
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		method: 'POST',
		headers: hdr(s),
		body: JSON.stringify(body),
	});
	return (await res.json()).id;
}

test('GET /nodes lists nodes and filters by kind', async () => {
	const s = await setup();
	await addNode(s, { kind: 'person', props: { name: 'p1' } });
	const d = await addNode(s, { kind: 'device', props: { type: 'router' } });
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes?kind=device`, {
		headers: hdr(s),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.nodes.map((n: { id: string }) => n.id)).toEqual([d]);
	expect(body.nextCursor).toBeNull();
	cleanup(s);
});

test('GET /graph returns a {nodes,links,truncated} slice', async () => {
	const s = await setup();
	const p1 = await addNode(s, { kind: 'person', props: { name: 'p1' } });
	const p2 = await addNode(s, { kind: 'person', props: { name: 'p2' } });
	await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s),
		body: JSON.stringify({ rel: 'knows', src: p1, dst: p2 }),
	});
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/graph`, { headers: hdr(s) });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.nodes.length).toBe(2);
	expect(body.links[0]).toMatchObject({ source: p1, target: p2, rel: 'knows' });
	expect(body.truncated).toBe(false);
	cleanup(s);
});

test('GET /nodes/:id/history returns the version trail', async () => {
	const s = await setup();
	const id = await addNode(s, { kind: 'person', props: { name: 'p1' } });
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${id}/history`, {
		headers: hdr(s),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.versions.length).toBe(1);
	expect(String(body.versions[0].id)).toBe(id);
	cleanup(s);
});

test('GET /nodes with a malformed cursor -> 400', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes?cursor=not-base64-json`, {
		headers: hdr(s),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('operator token reads a tenant graph with no membership row -> 200', async () => {
	const s = await setup();
	await addNode(s, { kind: 'person', props: { name: 'p1' } });
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		headers: { 'x-admin-token': 'secret' },
	});
	expect(res.status).toBe(200);
	expect((await res.json()).nodes.length).toBe(1);
	cleanup(s);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/admin-routes.test.ts`
Expected: FAIL — the `/nodes`, `/graph`, `/nodes/:id/history` routes 404 (not yet defined); the malformed-cursor test gets 500 not 400.

- [ ] **Step 3: Import `history` and add query schemas**

In `packages/core/src/serve.ts`, add to the imports (after line 12, `import { journey } from './journey.ts';`):

```ts
import { history } from './temporal.ts';
```

After the `journeyInputSchema` block (ends line 161), add:

```ts
/** GET /nodes query — kind/full-text/as-of filters + keyset pagination. */
const nodeListQuerySchema = z.object({
	kind: z.string().optional(),
	q: z.string().optional(),
	asOf: z.coerce.number().optional(),
	limit: z.coerce.number().optional(),
	cursor: z.string().optional(),
});

/** GET /graph query — kind/full-text/as-of filters for the canvas slice. */
const graphSliceQuerySchema = z.object({
	kind: z.string().optional(),
	q: z.string().optional(),
	asOf: z.coerce.number().optional(),
});
```

- [ ] **Step 4: Add the routes to the chain**

In `packages/core/src/serve.ts`, in `buildApp`, insert these three routes into the chain immediately AFTER the `/nodes/:id/neighbors` route (which ends at line 276 with `)`), before the `/retrieve` route:

```ts
			.get(
				'/t/:tenant/p/:project/nodes',
				requireGraph(cfg, 'read'),
				zValidator('query', nodeListQuerySchema),
				async (c) => {
					const { kind, q, asOf, limit, cursor } = c.req.valid('query');
					const page = await c.get('graph').listNodes({ kind, q, asOf, limit, cursor, limits: cfg.limits });
					return c.json(page);
				},
			)
			.get(
				'/t/:tenant/p/:project/graph',
				requireGraph(cfg, 'read'),
				zValidator('query', graphSliceQuerySchema),
				async (c) => {
					const { kind, q, asOf } = c.req.valid('query');
					const slice = await c.get('graph').graphSlice({ kind, q, asOf, limits: cfg.limits });
					return c.json(slice);
				},
			)
			.get('/t/:tenant/p/:project/nodes/:id/history', requireGraph(cfg, 'read'), async (c) => {
				const versions = await history(c.get('graph').raw, c.req.param('id'));
				return c.json({ versions });
			})
```

> Note: place the new `.get('.../nodes', ...)` route AFTER `.get('.../nodes/:id', ...)` already in the chain — Hono matches the more specific `/nodes/:id` and `/nodes/:id/neighbors` fine regardless of order, but keeping the collection route grouped with the others is clearest. The `:id` and collection paths do not collide (`/nodes` has no extra segment).

- [ ] **Step 5: Add the `invalid cursor` branch in `onError`**

In `packages/core/src/serve.ts`, in `onError`, add this branch right before the final `return c.json({ error: 'internal' }, 500);` (line 222):

```ts
// decodeCursor / decodeFeedCursor reject a tampered/stale keyset cursor with this message.
if (err.message === 'invalid cursor') return c.json({ error: 'invalid cursor' }, 400);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/core/test/admin-routes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the full existing serving suite to confirm no regression**

Run: `bun test packages/core/test/p11-serving.test.ts packages/core/test/p12-serve.test.ts`
Expected: PASS (all existing tests still green — the new routes are additive).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/serve.ts packages/core/test/admin-routes.test.ts
git commit -m "feat(core): /nodes /graph /nodes/:id/history read routes + invalid-cursor 400 (admin explore)"
```

---

### Task 6: `createAdminApp` — operator-gated control-plane CRUD sub-app

**Files:**

- Create: `packages/core/src/admin.ts`
- Test: `packages/core/test/admin-app.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/admin-app.test.ts`:

```ts
import { type Client, createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { createAdminApp } from '../src/admin.ts';
import { initControl } from '../src/control-plane.ts';

function operatorAuth(c: Context): void {
	if (c.req.header('x-admin-token') !== 'secret') throw new Error('forbidden');
}

interface Setup {
	control: Client;
	app: Hono;
}

async function setup(): Promise<Setup> {
	const control = createClient({ url: ':memory:' });
	await initControl(control);
	// Mount under /admin exactly as the deployment does.
	const app = new Hono();
	app.route('/admin', createAdminApp({ control, authenticate: operatorAuth }));
	return { control, app };
}

const AUTH = { 'x-admin-token': 'secret', 'content-type': 'application/json' };

test('unauthenticated admin request -> 401', async () => {
	const s = await setup();
	const res = await s.app.request('/admin/tenants');
	expect(res.status).toBe(401);
	s.control.close();
});

test('create + list tenants round-trips', async () => {
	const s = await setup();
	const created = await s.app.request('/admin/tenants', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ name: 'Acme' }),
	});
	expect(created.status).toBe(201);
	const { id } = await created.json();
	expect(id.length).toBe(26);
	const list = await s.app.request('/admin/tenants', { headers: AUTH });
	expect((await list.json()).tenants).toEqual([{ id, name: 'Acme' }]);
	s.control.close();
});

test('create project under a tenant + list projects', async () => {
	const s = await setup();
	const t = await (
		await s.app.request('/admin/tenants', {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ name: 'Acme' }),
		})
	).json();
	const ns = `ns_${ulid().toLowerCase()}`;
	const created = await s.app.request(`/admin/tenants/${t.id}/projects`, {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ name: 'Alpha', dbNamespace: ns }),
	});
	expect(created.status).toBe(201);
	const list = await s.app.request(`/admin/tenants/${t.id}/projects`, { headers: AUTH });
	const { projects } = await list.json();
	expect(projects).toEqual([{ id: (await created.json()).id, name: 'Alpha', dbNamespace: ns }]);
	s.control.close();
});

test('create user, add membership (204), mint api-key (201, key once)', async () => {
	const s = await setup();
	const t = await (
		await s.app.request('/admin/tenants', {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ name: 'Acme' }),
		})
	).json();
	const u = await (
		await s.app.request('/admin/users', {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ email: 'a@test.dev' }),
		})
	).json();
	expect(u.id.length).toBe(26);

	const mem = await s.app.request('/admin/memberships', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ userId: u.id, tenantId: t.id, role: 'editor' }),
	});
	expect(mem.status).toBe(204);

	const key = await s.app.request('/admin/api-keys', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ tenantId: t.id, scopes: ['read'] }),
	});
	expect(key.status).toBe(201);
	expect((await key.json()).key.startsWith('gxk_')).toBe(true);
	s.control.close();
});

test('invalid body -> 400 (Zod validation mapped)', async () => {
	const s = await setup();
	const res = await s.app.request('/admin/tenants', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ name: '' }), // min(1) fails
	});
	expect(res.status).toBe(400);
	s.control.close();
});

test('duplicate user email -> 400 (constraint mapped, not 500)', async () => {
	const s = await setup();
	await s.app.request('/admin/users', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ email: 'dup@test.dev' }),
	});
	const again = await s.app.request('/admin/users', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ email: 'dup@test.dev' }),
	});
	expect(again.status).toBe(400);
	s.control.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/test/admin-app.test.ts`
Expected: FAIL — `Cannot find module '../src/admin.ts'`.

- [ ] **Step 3: Implement `admin.ts`**

Create `packages/core/src/admin.ts`:

```ts
import type { Client } from '@libsql/client';
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';
import {
	addMembership,
	createApiKey,
	createProject,
	createTenant,
	createUser,
	listProjects,
	listTenants,
	listUsers,
} from './control-plane.ts';

/**
 * The operator (admin) sub-app — control-plane registry CRUD, gated by an operator credential
 * and mounted by the deployment at `/admin` (`app.route('/admin', createAdminApp(cfg))`). This is
 * a SEPARATE auth realm from the tenant-scoped graph routes in `serve.ts`: there is no per-tenant
 * role here, only "is this caller an operator". `authenticate` is the single injection point — a
 * dev build compares a bearer/header token to a configured secret; production verifies a real
 * operator session/JWT. Throwing is surfaced as 401.
 */
export interface AdminConfig {
	/** The shared control-plane client (registry of tenants/projects/users/memberships/api_keys). */
	control: Client;
	/** Operator authn: verify the request is an operator. Throw to reject (mapped to 401). */
	authenticate: (c: Context) => void | Promise<void>;
}

const tenantBody = z.object({ name: z.string().min(1) });
const projectBody = z.object({ name: z.string().min(1), dbNamespace: z.string().min(1) });
const userBody = z.object({ email: z.string().min(3) });
const membershipBody = z.object({
	userId: z.string(),
	tenantId: z.string(),
	role: z.enum(['owner', 'editor', 'viewer']),
});
const apiKeyBody = z.object({ tenantId: z.string(), scopes: z.array(z.string()).default([]) });

/** Error map for the admin sub-app: Zod → 400, control-plane UNIQUE/FK → 400, else 500. */
function adminError(err: Error, c: Context) {
	if (err instanceof HTTPException) return err.getResponse();
	if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
	if (String((err as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
		return c.json({ error: 'constraint violation' }, 400);
	}
	return c.json({ error: 'internal' }, 500);
}

/** Build the operator-gated control-plane CRUD sub-app. Mount with `app.route('/admin', ...)`. */
export function createAdminApp(cfg: AdminConfig): Hono {
	const app = new Hono();
	app.use('*', async (c, next) => {
		try {
			await cfg.authenticate(c);
		} catch {
			throw new HTTPException(401, { message: 'unauthenticated' });
		}
		await next();
	});
	app
		.get('/tenants', async (c) => c.json({ tenants: await listTenants(cfg.control) }))
		.post('/tenants', zValidator('json', tenantBody), async (c) => {
			const id = await createTenant(cfg.control, c.req.valid('json'));
			return c.json({ id }, 201);
		})
		.get('/tenants/:id/projects', async (c) =>
			c.json({ projects: await listProjects(cfg.control, c.req.param('id')) }),
		)
		.post('/tenants/:id/projects', zValidator('json', projectBody), async (c) => {
			const { name, dbNamespace } = c.req.valid('json');
			const id = await createProject(cfg.control, {
				tenantId: c.req.param('id'),
				name,
				dbNamespace,
			});
			return c.json({ id }, 201);
		})
		.get('/users', async (c) => c.json({ users: await listUsers(cfg.control) }))
		.post('/users', zValidator('json', userBody), async (c) => {
			const id = await createUser(cfg.control, c.req.valid('json'));
			return c.json({ id }, 201);
		})
		.post('/memberships', zValidator('json', membershipBody), async (c) => {
			await addMembership(cfg.control, c.req.valid('json'));
			return c.body(null, 204);
		})
		.post('/api-keys', zValidator('json', apiKeyBody), async (c) => {
			const { key } = await createApiKey(cfg.control, c.req.valid('json'));
			return c.json({ key }, 201);
		});
	app.onError(adminError);
	return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/core/test/admin-app.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/admin.ts packages/core/test/admin-app.test.ts
git commit -m "feat(core): createAdminApp — operator-gated control-plane CRUD sub-app"
```

---

### Task 7: Public API exports + full suite + type-check

**Files:**

- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add the control-plane export additions**

In `packages/core/src/index.ts`, replace the existing control-plane export block (the `export { addMembership, CONTROL_SCHEMA, createProject, createTenant, createUser, initControl } from './control-plane.ts';` block) with:

```ts
// P0.5 — control plane + authz
export {
	addMembership,
	CONTROL_SCHEMA,
	createApiKey,
	createProject,
	createTenant,
	createUser,
	hashApiKey,
	initControl,
	listProjects,
	listTenants,
	listUsers,
} from './control-plane.ts';
```

- [ ] **Step 2: Add the admin sub-app export**

In `packages/core/src/index.ts`, immediately after the control-plane export block, add:

```ts
// Admin — operator-gated control-plane CRUD sub-app (mount with app.route('/admin', ...))
export { type AdminConfig, createAdminApp } from './admin.ts';
```

- [ ] **Step 3: Add the new Graph read types to the existing graph export block**

In `packages/core/src/index.ts`, in the `export { ... } from './graph.ts';` block (the "P3 / P6 — data layer + temporal mutations" block), add these type members (keep alphabetical-ish ordering consistent with the file):

```ts
	type GraphSlice,
	type GraphSliceLink,
	type GraphSliceNode,
	type GraphSliceOpts,
	type NodeListOpts,
	type NodeListPage,
```

(Insert them among the existing members of that one `export { ... } from './graph.ts';` statement — do not create a second graph export block.)

- [ ] **Step 4: Type-check the package**

Run: `bun run --filter 'core' type-check`
Expected: `core type-check: Exited with code 0` (no TS errors — all new exports resolve, no isolatedDeclarations violation).

- [ ] **Step 5: Run the FULL core test suite**

Run: `bun test`
Expected: PASS — the prior 244 tests plus the new admin tests (authz 3, control-plane 4, list 9, routes 5, admin-app 6 = 27 new), all green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): export admin API — createAdminApp, control-plane helpers, list/slice types"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-12-graphx-admin-ui-design.md` §5 contract):

- `/admin/tenants` GET+POST → Task 6 ✓
- `/admin/tenants/:id/projects` GET+POST → Task 6 ✓
- `/admin/users` GET+POST → Task 6 ✓
- `/admin/memberships` POST (204) → Task 6 ✓
- `/admin/api-keys` POST (key once) → Task 6 ✓
- `/t/:t/p/:p/nodes` (listNodes) → Tasks 3 + 5 ✓
- `/t/:t/p/:p/graph` (graphSlice) → Tasks 4 + 5 ✓
- `/t/:t/p/:p/nodes/:id/history` → Task 5 ✓
- Filter params kind/q/asOf/limit/cursor + governance caps → Tasks 3,4,5 ✓
- Operator auth + impersonation (§4) → Tasks 1 + 5 (operator-token authenticate test) ✓
- `truncated` on graph slice → Task 4 ✓
- `invalid cursor` → 400 → Task 5 ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows full assertions. ✓

**3. Type consistency:** `listNodes` returns `NodeListPage` (`{nodes, nextCursor}`); `graphSlice` returns `GraphSlice` (`{nodes, links, truncated}`); links use `source`/`target`/`rel`/`weight`; `Principal.operator?: boolean`; `AdminConfig.authenticate: (c) => void | Promise<void>`. Route handlers call `c.get('graph').listNodes(...)` / `.graphSlice(...)` matching the method names added in Tasks 3/4. `createApiKey` returns `{key}`; route returns `{key}` 201. All consistent across tasks. ✓

**4. Notes for the executor:**

- Zod 4: `z.string().min(3)` is used for email (avoids any `.email()` API-version friction); validation is intentionally loose — the DB `UNIQUE` on `users.email` is the real guard (tested via the duplicate-email 400 test).
- Tests that open a project DB (`admin-routes.test.ts`) must `evict` + `rmSync` the namespace files in `cleanup`, mirroring `p11-serving.test.ts` — libSQL writes `ns_*.db` files to cwd.
- The `nodeFilter`/`graphSlice` subquery inlines `LIMIT <maxRows>` (validated integer from `resolveLimits`, injection-safe — same pattern as `applyLimit`).
