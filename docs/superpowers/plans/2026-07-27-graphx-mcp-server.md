# graphx MCP server implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@graphx/mcp`, an MCP server exposing every graphx serving route as a tool, generated from the app's own OpenAPI registry.

**Architecture:** Each route in `serve.ts` gains an `operationId` (the tool name) and a `read`/`write` tag (the op). `@graphx/mcp` reads `app.openAPIRegistry.definitions`, merges each route's Zod `params`/`query`/`body` into one flat input shape, and registers it on an `McpServer`. Tool calls become HTTP requests through a one-method `Backend` seam: locally that is `app.fetch` on an in-process Hono app, remotely it is `fetch` against a deployed one. Handlers are never reimplemented.

**Tech Stack:** Bun, TypeScript (`isolatedDeclarations`), Hono, `@hono/zod-openapi`, Zod 4, `@modelcontextprotocol/sdk`, `@hono/mcp`.

**Spec:** `docs/superpowers/specs/2026-07-27-mcp-server-design.md`

## Global Constraints

- Runtime is Bun. Tests are `bun test`; the whole suite runs from the repo root with `bun test --timeout 30000`.
- Every package sets `isolatedDeclarations: true`. **Every exported symbol needs an explicit type annotation** — an exported function without a declared return type fails `bun run type-check`.
- Imports of local files carry the `.ts` extension: `import { x } from './backend.ts'`. This is the established repo style.
- Formatting is `oxfmt`, linting is `oxlint`. Tabs for indent, single quotes, semicolons. The pre-commit hook runs `bun run lint && bun run type-check` — both must pass before any commit lands.
- `@modelcontextprotocol/sdk` pins to `^1.29.0`. `@hono/mcp@0.3.1` peer-depends on `^1.29.0`, and the local registry policy blocks releases newer than 7 days.
- Zod comes from `@hono/zod-openapi`'s re-exported `z` inside `serve.ts`; `@graphx/mcp` imports plain `zod` (same underlying v4 instance).
- Core tests run against both backends via `GRAPHX_TEST_DRIVER=libsql` (default) and `GRAPHX_TEST_DRIVER=postgres`.
- Commits are conventional and scoped: `feat(mcp):`, `feat(core):`, `test(mcp):`.
- Never widen a tool surface silently. A route without an `operationId` is not mirrored — that is the opt-out.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/mcp/package.json` | package manifest, `graphx-mcp` bin, deps |
| `packages/mcp/tsconfig.json` | extends the base config, matches `packages/cli` |
| `packages/mcp/src/backend.ts` | the `Backend` seam and its two implementations |
| `packages/mcp/src/tools.ts` | registry → `ToolDescriptor[]`; args → HTTP request parts |
| `packages/mcp/src/resources.ts` | `graphx://schema` content, from a `GraphSchema` or inferred |
| `packages/mcp/src/server.ts` | `McpServer` construction: registers tools + resource, maps results |
| `packages/mcp/src/index.ts` | public exports |
| `packages/mcp/src/bin.ts` | stdio entry point, env config parsing |
| `packages/mcp/test/tools.test.ts` | descriptor extraction, arg splitting |
| `packages/mcp/test/backend.test.ts` | URL building, header injection |
| `packages/mcp/test/server.test.ts` | end-to-end over `InMemoryTransport` |
| `packages/mcp/test/resources.test.ts` | schema resource + `describe_schema` |
| `packages/mcp/README.md` | install, configure, tool list |

**Modified:**

| File | Change |
|---|---|
| `packages/core/src/serve.ts` | `operationId` + `tags` on 25 routes; new `GET /t/{tenant}/projects`; widen the authn middleware |
| `packages/core/test/openapi.test.ts` | coverage assertions for `operationId` and tags |
| `bunup.config.ts` | build entry for the new package |

---

### Task 1: Route metadata — `operationId` and read/write tags

Adds the two facts MCP needs to `serve.ts`'s route declarations. The read/write distinction currently exists only as the `requireGraph(cfg, 'read' | 'write')` middleware argument, which is invisible to the OpenAPI registry.

**Files:**
- Modify: `packages/core/src/serve.ts` (the 25 tenant `createRoute` calls, lines 727–1320)
- Test: `packages/core/test/openapi.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every tenant route in the registry carries `operationId: string` and `tags: ['read'] | ['write']`, except `GET /t/{tenant}/p/{project}/events`, which carries neither. `/health` and `/ready` carry neither.

The complete assignment — `operationId` matches the tag to the route's existing `requireGraph` argument:

| Line | Method | Path suffix | `tags` | `operationId` |
|---|---|---|---|---|
| 729 | post | `/nodes` | `write` | `create_node` |
| 749 | post | `/edges` | `write` | `create_edge` |
| 767 | get | `/nodes/{id}` | `read` | `get_node` |
| 785 | patch | `/nodes/{id}` | `write` | `update_node` |
| 807 | delete | `/edges/{id}` | `write` | `delete_edge` |
| 824 | delete | `/nodes/{id}` | `write` | `delete_node` |
| 839 | get | `/nodes/{id}/neighbors` | `read` | `neighbors` |
| 861 | get | `/nodes/{id}/neighborsPage` | `read` | `neighbors_page` |
| 883 | get | `/nodes` | `read` | `list_nodes` |
| 901 | get | `/graph` | `read` | `graph_slice` |
| 919 | get | `/nodes/{id}/content` | `read` | `get_node_content` |
| 935 | get | `/nodes/{id}/history` | `read` | `node_history` |
| 953 | get | `/retrieve` | `read` | `retrieve` |
| 979 | post | `/journey` | `read` | `journey` |
| 1006 | get | `/changes` | `read` | `change_feed` |
| 1032 | get | `/events` | *(none)* | *(none — not mirrored)* |
| 1105 | get | `/diff` | `read` | `diff` |
| 1122 | post | `/hybrid` | `read` | `hybrid_search` |
| 1150 | post | `/bulk` | `write` | `bulk_load` |
| 1176 | post | `/match` | `read` | `match_pattern` |
| 1232 | post | `/algorithms/shortest-path` | `read` | `shortest_path` |
| 1250 | post | `/algorithms/pagerank` | `write` | `pagerank` |
| 1268 | post | `/algorithms/community` | `write` | `community` |
| 1286 | post | `/algorithms/centrality` | `write` | `centrality` |
| 1307 | get | `/algorithms/top` | `read` | `top_nodes` |

That is 24 routes with metadata plus `/events` without. `list_projects` arrives in Task 2, bringing the mirrored total to 25.

Line numbers drift as edits are applied — match on the `path:` string, not the line.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/openapi.test.ts`:

```ts
test('openapi: every tenant operation is tagged read or write', async () => {
	const d = await doc();
	const offenders: string[] = [];
	for (const [path, item] of Object.entries<any>(d.paths)) {
		if (!path.startsWith('/t/{tenant}')) continue;
		for (const [method, op] of Object.entries<any>(item)) {
			const tags: string[] = op.tags ?? [];
			const tagged = tags.filter((t) => t === 'read' || t === 'write');
			if (tagged.length !== 1) offenders.push(`${method.toUpperCase()} ${path}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('openapi: every mirrored operation has a unique operationId', async () => {
	const d = await doc();
	const ids: string[] = [];
	const missing: string[] = [];
	for (const [path, item] of Object.entries<any>(d.paths)) {
		if (!path.startsWith('/t/{tenant}')) continue;
		for (const [method, op] of Object.entries<any>(item)) {
			// `/events` is SSE — deliberately unmirrored, so it carries no operationId.
			if (path.endsWith('/events')) {
				expect(op.operationId).toBeUndefined();
				continue;
			}
			if (!op.operationId) missing.push(`${method.toUpperCase()} ${path}`);
			else ids.push(op.operationId);
		}
	}
	expect(missing).toEqual([]);
	expect(new Set(ids).size).toBe(ids.length);
	expect(ids).toContain('create_node');
	expect(ids).toContain('neighbors_page');
	expect(ids).toContain('top_nodes');
});

test('openapi: ops routes are not mirrored', async () => {
	const d = await doc();
	expect(d.paths['/health'].get.operationId).toBeUndefined();
	expect(d.paths['/ready'].get.operationId).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/core/test/openapi.test.ts -t "tagged read or write"`

Expected: FAIL — `offenders` lists all 25 tenant operations, since none carry tags yet.

- [ ] **Step 3: Add the metadata**

For each row in the table above, add two fields to the `createRoute({...})` object, immediately after `path`. The first one, in full:

```ts
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/nodes',
				operationId: 'create_node',
				tags: ['write'],
				summary: 'Create a node',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: nodeInputSchema } } },
				},
				responses: { 201: json('Created', nodeSchema), ...WRITE_ERRORS },
			}),
```

The tag always matches the `requireGraph(cfg, …)` argument on the same route. `GET /t/{tenant}/p/{project}/events` gets neither field — leave it untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/core/test/openapi.test.ts`

Expected: PASS, all tests in the file including the pre-existing document-shape and validator tests.

- [ ] **Step 5: Verify the whole core suite still passes**

Run: `bun test packages/core --timeout 30000`

Expected: PASS. Adding `operationId`/`tags` is additive to the document; no existing assertion reads either field.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/serve.ts packages/core/test/openapi.test.ts
git commit -m "feat(core): declare operationId and read/write tags on the tenant routes

The read/write distinction lived only in the requireGraph() middleware
argument, which the OpenAPI registry cannot see. Both fields are
first-class OpenAPI, so /openapi.json gains operation ids and Scalar
groups routes by op."
```

---

### Task 2: `GET /t/{tenant}/projects`

The only way an agent learns which projects it can address. The existing control-plane listing lives in `createAdminApp`, a separate auth realm gated on "is this caller an operator" — a normal tenant credential gets 401 there.

**Files:**
- Modify: `packages/core/src/serve.ts`
- Test: `packages/core/test/p11-serving.test.ts`

**Interfaces:**
- Consumes: Task 1's tagging convention.
- Produces: `GET /t/{tenant}/projects` → `200 { projects: Array<{ id: string; name: string }> }`, `operationId: 'list_projects'`, `tags: ['read']`. This is the only route whose `request.params` omits `project`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/p11-serving.test.ts`. Read the top of that file first — it already builds a control plane, two tenants, and an app; reuse its existing setup helper rather than writing a new one. The test body:

```ts
test('serving: list_projects returns the caller tenant projects, without db namespaces', async () => {
	const { control, tenantA, projectA, userA, app, teardown } = await setup();

	const res = await app.request(`/t/${tenantA}/projects`, {
		headers: { 'x-user': userA, 'x-tenant': tenantA },
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { projects: Array<Record<string, unknown>> };
	expect(body.projects.map((p) => p.id)).toContain(projectA);
	// §2.9 — the sqld namespace is internal routing detail and never crosses the wire.
	for (const p of body.projects) expect(p.dbNamespace).toBeUndefined();

	// Confused-deputy guard: a route tenant that isn't the principal's is a 404, not a 403,
	// so cross-tenant existence doesn't leak.
	const other = await createTenant(control, { name: 'other' });
	const cross = await app.request(`/t/${other}/projects`, {
		headers: { 'x-user': userA, 'x-tenant': tenantA },
	});
	expect(cross.status).toBe(404);

	// A principal with no membership row in the tenant is 403.
	const stranger = await createUser(control, { email: 'stranger@local' });
	const noMem = await app.request(`/t/${tenantA}/projects`, {
		headers: { 'x-user': stranger, 'x-tenant': tenantA },
	});
	expect(noMem.status).toBe(403);

	await teardown();
});
```

If the file's existing setup helper returns different names, adapt the destructuring — do not rename the helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/test/p11-serving.test.ts -t "list_projects"`

Expected: FAIL with status 404 — the route does not exist, so Hono's not-found handler answers.

- [ ] **Step 3: Widen the authn middleware**

In `packages/core/src/serve.ts`, find this line in `buildApp` (just above the route chain):

```ts
	base.use('/t/:tenant/p/:project/*', authn(cfg));
```

Change it to:

```ts
	base.use('/t/:tenant/*', authn(cfg));
```

A superset: it covers every path the old pattern did, plus `/t/:tenant/projects`.

- [ ] **Step 4: Add the route**

Add `listProjects` to the existing `./control-plane.ts` import at the top of `serve.ts`. Then add this as the first `.openapi(...)` link in the tenant portion of the chain, immediately after the `/ready` route:

```ts
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/projects',
				operationId: 'list_projects',
				tags: ['read'],
				summary: "List the caller's projects in this tenant",
				security: SECURITY,
				request: { params: z.object({ tenant: z.string() }) },
				responses: {
					200: json(
						'Projects',
						z.object({
							projects: z.array(z.object({ id: z.string(), name: z.string() })),
						}),
					),
					...READ_ERRORS,
				},
			}),
			async (c) => {
				const principal = c.get('principal');
				// Same confused-deputy guard requireGraph applies: a route tenant that isn't the
				// principal's is 404, so cross-tenant existence never leaks.
				if (c.req.param('tenant') !== principal.tenantId) {
					throw new AuthzError(404, 'tenant not found');
				}
				// Operators have no memberships row (see authorize's operator bypass).
				if (!principal.operator) {
					const mem = await cfg.control.execute({
						sql: 'SELECT 1 FROM memberships WHERE user_id = ? AND tenant_id = ?',
						args: [principal.userId, principal.tenantId],
					});
					if (!mem.rows[0]) throw new AuthzError(403, 'no membership in tenant');
				}
				const rows = await listProjects(cfg.control, principal.tenantId);
				// §2.9: strip db_namespace — end users never receive a DB-level identifier.
				return c.json({ projects: rows.map(({ id, name }) => ({ id, name })) }, 200);
			},
		)
```

`AuthzError` is already imported in `serve.ts` and `onError` already maps it to 403/404, so no error-handling changes are needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/core/test/p11-serving.test.ts -t "list_projects"`

Expected: PASS.

- [ ] **Step 6: Run the full core suite on both drivers**

Run:
```bash
bun test packages/core --timeout 30000
GRAPHX_TEST_DRIVER=postgres bun test packages/core --timeout 30000
```

Expected: PASS on both. Task 1's coverage tests now also see `list_projects`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/serve.ts packages/core/test/p11-serving.test.ts
git commit -m "feat(core): member-scoped GET /t/{tenant}/projects

The admin sub-app's project listing is operator-gated, so a tenant
credential cannot discover its own projects. Same confused-deputy guard
as requireGraph, and db_namespace is stripped per §2.9."
```

---

### Task 3: Package scaffold and the `Backend` seam

The seam is one method. Everything downstream depends on it, and nothing in it knows about MCP.

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/src/backend.ts`
- Modify: `bunup.config.ts`
- Test: `packages/mcp/test/backend.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Backend { call(method: string, path: string, init?: BackendInit): Promise<Response> }`
  - `interface BackendInit { query?: Record<string, string>; body?: unknown }`
  - `function localBackend(app: FetchLike, headers?: Record<string, string>): Backend`
  - `function remoteBackend(cfg: { url: string; apiKey?: string }): Backend`
  - `interface FetchLike { fetch(req: Request): Response | Promise<Response> }`

- [ ] **Step 1: Create the package manifest**

`packages/mcp/package.json`:

```json
{
	"name": "@graphx/mcp",
	"version": "0.1.0",
	"description": "graphx MCP server — every serving route as an MCP tool",
	"license": "MIT",
	"type": "module",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"bin": {
		"graphx-mcp": "./dist/bin.js"
	},
	"exports": {
		".": {
			"import": {
				"types": "./dist/index.d.ts",
				"default": "./dist/index.js"
			}
		},
		"./package.json": "./package.json"
	},
	"files": [
		"dist"
	],
	"scripts": {
		"type-check": "tsc --noEmit"
	},
	"dependencies": {
		"@hono/mcp": "^0.3.1",
		"@modelcontextprotocol/sdk": "^1.29.0",
		"zod": "^4.4.3"
	},
	"peerDependencies": {
		"@graphx/core": "workspace:*",
		"hono": "^4.12.23",
		"typescript": ">=4.5.0"
	},
	"peerDependenciesMeta": {
		"typescript": {
			"optional": true
		}
	},
	"devDependencies": {
		"@graphx/core": "workspace:*",
		"@types/node": "^25.9.1"
	}
}
```

- [ ] **Step 2: Create the tsconfig and build entry**

`packages/mcp/tsconfig.json` — identical in shape to `packages/cli/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"declaration": true,
		"isolatedDeclarations": true,
		"esModuleInterop": true,
		"types": ["node"]
	},
	"include": ["src/**/*"]
}
```

In `bunup.config.ts`, add a workspace entry after the `cli` block:

```ts
	{
		name: 'mcp',
		root: 'packages/mcp',
		// `bin.ts` is a separate entry so `dist/bin.js` is the executable the `graphx-mcp`
		// bin points at; the shebang makes it runnable directly (mirrors cli).
		config: {
			entry: ['src/index.ts', 'src/bin.ts'],
			banner: '#!/usr/bin/env bun',
		},
	},
```

- [ ] **Step 3: Install and confirm the workspace resolves**

Run: `bun install`

Expected: `@graphx/mcp` linked into the workspace; `@modelcontextprotocol/sdk` and `@hono/mcp` installed.

- [ ] **Step 4: Write the failing test**

`packages/mcp/test/backend.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { localBackend, remoteBackend } from '../src/backend.ts';

test('backend: local dispatches through app.fetch with no socket', async () => {
	const seen: Request[] = [];
	const app = {
		fetch: (req: Request) => {
			seen.push(req);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		},
	};
	const backend = localBackend(app, { 'x-user': 'u', 'x-tenant': 't' });
	const res = await backend.call('GET', '/t/t/p/p/nodes', { query: { limit: '5' } });

	expect(res.status).toBe(200);
	expect(seen).toHaveLength(1);
	const url = new URL(seen[0]!.url);
	expect(url.pathname).toBe('/t/t/p/p/nodes');
	expect(url.searchParams.get('limit')).toBe('5');
	expect(seen[0]!.headers.get('x-user')).toBe('u');
});

test('backend: local sends a JSON body on writes', async () => {
	let body: unknown;
	const app = {
		fetch: async (req: Request) => {
			body = await req.json();
			return new Response(null, { status: 201 });
		},
	};
	const backend = localBackend(app);
	await backend.call('POST', '/t/t/p/p/nodes', { body: { type: 'person', data: { name: 'a' } } });
	expect(body).toEqual({ type: 'person', data: { name: 'a' } });
});

test('backend: local omits an empty query string', async () => {
	const seen: string[] = [];
	const app = {
		fetch: (req: Request) => {
			seen.push(req.url);
			return new Response('{}', { status: 200 });
		},
	};
	await localBackend(app).call('GET', '/t/t/p/p/nodes', { query: {} });
	expect(seen[0]).not.toContain('?');
});

test('backend: remote targets the base url and sends the bearer credential', async () => {
	const seen: Request[] = [];
	const backend = remoteBackend({
		url: 'https://api.example.com',
		apiKey: 'k1',
		fetch: (req) => {
			seen.push(req);
			return Promise.resolve(new Response('{}', { status: 200 }));
		},
	});
	await backend.call('GET', '/t/t/p/p/nodes', { query: { limit: '5' } });

	expect(seen[0]!.url).toBe('https://api.example.com/t/t/p/p/nodes?limit=5');
	expect(seen[0]!.headers.get('authorization')).toBe('Bearer k1');
});

test('backend: remote tolerates a base url with a trailing slash', async () => {
	const seen: Request[] = [];
	const backend = remoteBackend({
		url: 'https://api.example.com/',
		fetch: (req) => {
			seen.push(req);
			return Promise.resolve(new Response('{}', { status: 200 }));
		},
	});
	await backend.call('GET', '/t/t/p/p/nodes');
	expect(seen[0]!.url).toBe('https://api.example.com/t/t/p/p/nodes');
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `bun test packages/mcp/test/backend.test.ts`

Expected: FAIL — `Cannot find module '../src/backend.ts'`.

- [ ] **Step 6: Implement `backend.ts`**

`packages/mcp/src/backend.ts`:

```ts
/**
 * The seam between MCP tool calls and graphx's serving layer. Handlers are never
 * reimplemented here: a tool call becomes an HTTP request, and the only difference between
 * running against a local graph and a deployed one is who answers that request.
 *
 * `localBackend` dispatches straight into a Hono app — Hono routes a `Request` to a
 * `Response` without a socket — so the local path runs the *same* authn, authz, upcasting,
 * and governance middleware as production, because it is that middleware.
 */

/** Optional request parts for a {@link Backend} call. */
export interface BackendInit {
	/** Query-string pairs, already stringified. Omitted keys produce no parameter. */
	query?: Record<string, string>;
	/** JSON request body. `undefined` sends no body. */
	body?: unknown;
}

/** One method: a graphx HTTP request, however it is delivered. */
export interface Backend {
	call(method: string, path: string, init?: BackendInit): Promise<Response>;
}

/** The structural bit of a Hono app the local backend needs. */
export interface FetchLike {
	fetch(req: Request): Response | Promise<Response>;
}

/** Config for {@link remoteBackend}. `fetch` is injectable for tests. */
export interface RemoteBackendConfig {
	/** Base URL of a running graphx server, with or without a trailing slash. */
	url: string;
	/** Bearer credential. Omit when the deployment authenticates some other way. */
	apiKey?: string;
	/** Override the fetch implementation (tests). Defaults to the global. */
	fetch?: (req: Request) => Promise<Response>;
}

/** `?a=1&b=2`, or `''` when there is nothing to encode. */
function queryString(query: Record<string, string> | undefined): string {
	if (!query) return '';
	const params = new URLSearchParams(query);
	const s = params.toString();
	return s ? `?${s}` : '';
}

function buildRequest(
	url: string,
	method: string,
	init: BackendInit | undefined,
	headers: Record<string, string>,
): Request {
	const hasBody = init?.body !== undefined;
	return new Request(url, {
		method,
		headers: hasBody ? { 'content-type': 'application/json', ...headers } : headers,
		body: hasBody ? JSON.stringify(init?.body) : undefined,
	});
}

/**
 * In-process backend. `headers` are attached to every request — a dev app reads
 * `x-user`/`x-tenant`, a production app reads whatever its `authenticate` expects.
 * The origin is a placeholder: Hono routes on the path and never dials it.
 */
export function localBackend(app: FetchLike, headers: Record<string, string> = {}): Backend {
	return {
		call: (method, path, init) =>
			Promise.resolve(
				app.fetch(buildRequest(`http://graphx.local${path}${queryString(init?.query)}`, method, init, headers)),
			),
	};
}

/** HTTP backend against a deployed graphx server. */
export function remoteBackend(cfg: RemoteBackendConfig): Backend {
	const base = cfg.url.replace(/\/+$/, '');
	const doFetch = cfg.fetch ?? ((req: Request) => fetch(req));
	const headers: Record<string, string> = cfg.apiKey
		? { authorization: `Bearer ${cfg.apiKey}` }
		: {};
	return {
		call: (method, path, init) =>
			doFetch(buildRequest(`${base}${path}${queryString(init?.query)}`, method, init, headers)),
	};
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test packages/mcp/test/backend.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 8: Verify types and lint**

Run: `bun run lint && bun run type-check`

Expected: both exit 0. If `type-check` complains about a missing return type, add it — `isolatedDeclarations` requires explicit annotations on every export.

- [ ] **Step 9: Commit**

```bash
git add packages/mcp bunup.config.ts package.json bun.lock
git commit -m "feat(mcp): package scaffold and the Backend seam

One method separates a tool call from its transport. Local dispatches
into a Hono app via app.fetch, so it runs the real middleware chain
without a socket; remote is the same shape against a base URL."
```

---

### Task 4: Registry → tool descriptors

Reads the app's own OpenAPI registry and turns each declared route into everything the MCP layer needs. No knowledge of MCP lives here — it is a pure transformation, which is what makes it cheap to test.

**Files:**
- Create: `packages/mcp/src/tools.ts`
- Test: `packages/mcp/test/tools.test.ts`

**Interfaces:**
- Consumes: `Backend`/`BackendInit` from `./backend.ts` (types only).
- Produces:
  - `interface ToolDescriptor { name: string; description: string; method: string; path: string; readOnly: boolean; pathFields: string[]; queryFields: string[]; bodyFields: string[]; inputShape: Record<string, ZodType>; annotations: ToolAnnotations }`
  - `interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }`
  - `function toolsFrom(app: RegistryHost): ToolDescriptor[]`
  - `function buildCall(desc: ToolDescriptor, args: Record<string, unknown>): { method: string; path: string; init: BackendInit }`
  - `interface RegistryHost { openAPIRegistry: { definitions: readonly unknown[] } }`

- [ ] **Step 1: Write the failing test**

`packages/mcp/test/tools.test.ts`:

```ts
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { expect, test } from 'bun:test';
import { buildCall, toolsFrom } from '../src/tools.ts';

/** A miniature app carrying the same declaration shapes serve.ts uses. */
function fixtureApp() {
	const app = new OpenAPIHono();
	const scope = z.object({ tenant: z.string(), project: z.string() });
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/nodes',
			operationId: 'list_nodes',
			tags: ['read'],
			summary: 'List nodes',
			request: { params: scope, query: z.object({ limit: z.coerce.number().optional() }) },
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.json({}, 200),
	);
	app.openapi(
		createRoute({
			method: 'post',
			path: '/t/{tenant}/p/{project}/nodes',
			operationId: 'create_node',
			tags: ['write'],
			summary: 'Create a node',
			request: {
				params: scope,
				body: {
					required: true,
					content: {
						'application/json': {
							schema: z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }),
						},
					},
				},
			},
			responses: { 201: { description: 'created' } },
		}),
		(c) => c.json({}, 201),
	);
	app.openapi(
		createRoute({
			method: 'delete',
			path: '/t/{tenant}/p/{project}/nodes/{id}',
			operationId: 'delete_node',
			tags: ['write'],
			summary: 'Retract a node',
			request: { params: scope.extend({ id: z.string() }) },
			responses: { 204: { description: 'no content' } },
		}),
		(c) => c.body(null, 204),
	);
	// No operationId — the opt-out. Must not be mirrored.
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/events',
			summary: 'SSE stream',
			request: { params: scope },
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.body(null, 200),
	);
	return app;
}

test('tools: mirrors only routes carrying an operationId', () => {
	const tools = toolsFrom(fixtureApp());
	expect(tools.map((t) => t.name).sort()).toEqual(['create_node', 'delete_node', 'list_nodes']);
});

test('tools: merges path, query and body into one flat input shape', () => {
	const tools = toolsFrom(fixtureApp());
	const list = tools.find((t) => t.name === 'list_nodes')!;
	expect(Object.keys(list.inputShape).sort()).toEqual(['limit', 'project', 'tenant']);
	expect(list.pathFields.sort()).toEqual(['project', 'tenant']);
	expect(list.queryFields).toEqual(['limit']);
	expect(list.bodyFields).toEqual([]);

	const create = tools.find((t) => t.name === 'create_node')!;
	expect(Object.keys(create.inputShape).sort()).toEqual(['data', 'project', 'tenant', 'type']);
	expect(create.bodyFields.sort()).toEqual(['data', 'type']);
});

test('tools: annotations come off the tag, with the destructive exceptions', () => {
	const tools = toolsFrom(fixtureApp());
	const byName = new Map(tools.map((t) => [t.name, t]));
	expect(byName.get('list_nodes')!.readOnly).toBe(true);
	expect(byName.get('list_nodes')!.annotations).toEqual({ readOnlyHint: true });
	expect(byName.get('create_node')!.annotations).toEqual({ destructiveHint: false });
	expect(byName.get('delete_node')!.annotations).toEqual({ destructiveHint: true });
});

test('tools: an untagged route is a build-time error, not a silent default', () => {
	const app = new OpenAPIHono();
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/oops',
			operationId: 'oops',
			request: { params: z.object({ tenant: z.string(), project: z.string() }) },
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.json({}, 200),
	);
	expect(() => toolsFrom(app)).toThrow(/oops/);
});

test('tools: a field name colliding across sources is a build-time error', () => {
	const app = new OpenAPIHono();
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/clash',
			operationId: 'clash',
			tags: ['read'],
			request: {
				params: z.object({ tenant: z.string(), project: z.string() }),
				query: z.object({ tenant: z.string() }),
			},
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.json({}, 200),
	);
	expect(() => toolsFrom(app)).toThrow(/tenant/);
});

test('buildCall: routes each argument to its source', () => {
	const tools = toolsFrom(fixtureApp());
	const list = tools.find((t) => t.name === 'list_nodes')!;
	expect(buildCall(list, { tenant: 't1', project: 'p1', limit: 5 })).toEqual({
		method: 'GET',
		path: '/t/t1/p/p1/nodes',
		init: { query: { limit: '5' }, body: undefined },
	});

	const create = tools.find((t) => t.name === 'create_node')!;
	expect(buildCall(create, { tenant: 't1', project: 'p1', type: 'person', data: { name: 'a' } })).toEqual({
		method: 'POST',
		path: '/t/t1/p/p1/nodes',
		init: { query: {}, body: { type: 'person', data: { name: 'a' } } },
	});
});

test('buildCall: omits undefined query fields and url-encodes path values', () => {
	const tools = toolsFrom(fixtureApp());
	const list = tools.find((t) => t.name === 'list_nodes')!;
	const call = buildCall(list, { tenant: 't/1', project: 'p1' });
	expect(call.path).toBe('/t/t%2F1/p/p1/nodes');
	expect(call.init.query).toEqual({});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/mcp/test/tools.test.ts`

Expected: FAIL — `Cannot find module '../src/tools.ts'`.

- [ ] **Step 3: Implement `tools.ts`**

`packages/mcp/src/tools.ts`:

```ts
import type { ZodType } from 'zod';
import type { BackendInit } from './backend.ts';

/**
 * Turns the serving app's own OpenAPI registry into tool descriptors. There is no exported
 * route table to keep in sync: `OpenAPIHono` records every `createRoute` declaration on
 * `openAPIRegistry.definitions` with its Zod request schemas intact, so the manifest is not
 * checked against the app — it is the app.
 *
 * A route opts out by omitting `operationId` (the SSE `/events` route does exactly this).
 * A route that opts IN must be tagged `read` or `write`; anything else throws at construction,
 * because a missing tag would otherwise silently mean "not filtered by read-only mode".
 */

/** MCP tool behaviour hints, surfaced to clients so they can prompt before mutations. */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
}

/** Everything the MCP layer needs about one mirrored route. */
export interface ToolDescriptor {
	/** The route's `operationId`. */
	name: string;
	/** The route's `summary`, shown to the model. */
	description: string;
	/** Upper-case HTTP method. */
	method: string;
	/** OpenAPI-templated path, e.g. `/t/{tenant}/p/{project}/nodes/{id}`. */
	path: string;
	/** True when the route is tagged `read`. */
	readOnly: boolean;
	pathFields: string[];
	queryFields: string[];
	bodyFields: string[];
	/** The merged Zod shape handed to `registerTool` as `inputSchema`. */
	inputShape: Record<string, ZodType>;
	annotations: ToolAnnotations;
}

/** The structural bit of `OpenAPIHono` this module reads. */
export interface RegistryHost {
	openAPIRegistry: { definitions: readonly unknown[] };
}

/** Retracts are recoverable via `asOf`, but they still remove the live version. */
const DESTRUCTIVE = new Set(['delete_node', 'delete_edge']);
/** A patch applied twice lands the same node state. */
const IDEMPOTENT = new Set(['update_node']);

/** A Zod object's field map, or `{}` for anything that isn't one. */
function shapeOf(schema: unknown): Record<string, ZodType> {
	const shape = (schema as { shape?: Record<string, ZodType> } | undefined)?.shape;
	return shape && typeof shape === 'object' ? shape : {};
}

function annotationsFor(name: string, readOnly: boolean): ToolAnnotations {
	if (readOnly) return { readOnlyHint: true };
	if (DESTRUCTIVE.has(name)) return { destructiveHint: true };
	if (IDEMPOTENT.has(name)) return { destructiveHint: false, idempotentHint: true };
	// Writes that only add — creates, bulk load, and the algorithm runs that persist metrics.
	return { destructiveHint: false };
}

/** Every mirrored route in `app`, in registration order. */
export function toolsFrom(app: RegistryHost): ToolDescriptor[] {
	const out: ToolDescriptor[] = [];
	for (const def of app.openAPIRegistry.definitions) {
		const entry = def as { type?: string; route?: Record<string, any> };
		if (entry.type !== 'route' || !entry.route) continue;
		const route = entry.route;
		const name: string | undefined = route.operationId;
		if (!name) continue;

		const tags: string[] = route.tags ?? [];
		const readOnly = tags.includes('read');
		if (!readOnly && !tags.includes('write')) {
			throw new Error(`${name}: a mirrored route must be tagged 'read' or 'write'`);
		}

		const params = shapeOf(route.request?.params);
		const query = shapeOf(route.request?.query);
		const body = shapeOf(route.request?.body?.content?.['application/json']?.schema);

		const inputShape: Record<string, ZodType> = {};
		const add = (shape: Record<string, ZodType>): string[] => {
			for (const key of Object.keys(shape)) {
				if (key in inputShape) {
					throw new Error(`${name}: field '${key}' is declared in more than one request source`);
				}
				inputShape[key] = shape[key] as ZodType;
			}
			return Object.keys(shape);
		};

		out.push({
			name,
			description: route.summary ?? name,
			method: String(route.method).toUpperCase(),
			path: route.path,
			readOnly,
			pathFields: add(params),
			queryFields: add(query),
			bodyFields: add(body),
			inputShape,
			annotations: annotationsFor(name, readOnly),
		});
	}
	return out;
}

/** Split validated tool arguments back into the path, query, and body the route expects. */
export function buildCall(
	desc: ToolDescriptor,
	args: Record<string, unknown>,
): { method: string; path: string; init: BackendInit } {
	let path = desc.path;
	for (const field of desc.pathFields) {
		const value = args[field];
		if (value === undefined) throw new Error(`${desc.name}: missing path parameter '${field}'`);
		path = path.replace(`{${field}}`, encodeURIComponent(String(value)));
	}

	const query: Record<string, string> = {};
	for (const field of desc.queryFields) {
		const value = args[field];
		if (value !== undefined) query[field] = String(value);
	}

	let body: Record<string, unknown> | undefined;
	if (desc.bodyFields.length > 0) {
		body = {};
		for (const field of desc.bodyFields) {
			if (args[field] !== undefined) body[field] = args[field];
		}
	}

	return { method: desc.method, path, init: { query, body } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/mcp/test/tools.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Run lint and types**

Run: `bun run lint && bun run type-check`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): derive tool descriptors from the OpenAPI registry

Reads app.openAPIRegistry.definitions, merges each route's Zod params,
query and body into one flat input shape, and reads annotations off the
read/write tag. Missing tag or a colliding field name throws at
construction rather than defaulting."
```

---

### Task 5: The MCP server

Wires descriptors to the backend and maps HTTP responses onto MCP results. This is the task that produces something a client can actually talk to.

**Files:**
- Create: `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`
- Test: `packages/mcp/test/server.test.ts`

**Interfaces:**
- Consumes: `Backend` (Task 3), `toolsFrom` / `buildCall` / `ToolDescriptor` (Task 4).
- Produces:
  - `interface GraphxMcpOptions { app: RegistryHost; backend: Backend; readOnly?: boolean; name?: string; version?: string; schema?: GraphSchemaLike }`
  - `function createGraphxMcp(opts: GraphxMcpOptions): McpServer`
  - `interface GraphSchemaLike { nodes: Record<string, unknown>; edges: Record<string, unknown> }`

`schema` is accepted here but only consumed in Task 6; declare the field now so the option type does not change shape mid-plan.

- [ ] **Step 1: Write the failing test**

`packages/mcp/test/server.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createApp, defineGraphSchema, hashEmbed } from '@graphx/core';
import { localBackend } from '../src/backend.ts';
import { createGraphxMcp } from '../src/server.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string() }),
		device: z.object({ kind: z.string() }),
	},
	edges: { owns: { from: 'person', to: 'device' } },
});

/** A dev app + an MCP client wired to it over an in-memory transport pair. */
async function harness(opts: { readOnly?: boolean } = {}) {
	const db = `mcp_test_${crypto.randomUUID().replaceAll('-', '')}`;
	const dev = await createApp({
		schema: SCHEMA,
		db,
		embed: hashEmbed(),
		seed: async (g) => {
			await g.addNode({ type: 'person', data: { name: 'ada' } });
		},
	});
	const backend = localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant });
	const server = createGraphxMcp({ app: dev.app, backend, readOnly: opts.readOnly, schema: SCHEMA });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test', version: '1.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		tenant: dev.tenant,
		project: dev.project,
		teardown: async () => {
			await client.close();
			await server.close();
		},
	};
}

/** The JSON payload of a tool result, or throw with the error text. */
function payload(res: any): any {
	if (res.isError) throw new Error(`tool error: ${res.content[0]?.text}`);
	return JSON.parse(res.content[0].text);
}

test('server: exposes one tool per mirrored route, with annotations', async () => {
	const h = await harness();
	const { tools } = await h.client.listTools();
	const names = new Set(tools.map((t) => t.name));

	expect(names.has('list_nodes')).toBe(true);
	expect(names.has('create_node')).toBe(true);
	expect(names.has('list_projects')).toBe(true);
	// SSE is deliberately unmirrored.
	expect(names.has('events')).toBe(false);

	const list = tools.find((t) => t.name === 'list_nodes')!;
	expect(list.annotations?.readOnlyHint).toBe(true);
	expect(list.inputSchema.required).toEqual(expect.arrayContaining(['tenant', 'project']));

	const del = tools.find((t) => t.name === 'delete_node')!;
	expect(del.annotations?.destructiveHint).toBe(true);

	await h.teardown();
});

test('server: a read tool returns the same payload as the HTTP route', async () => {
	const h = await harness();
	const res = await h.client.callTool({
		name: 'list_nodes',
		arguments: { tenant: h.tenant, project: h.project },
	});
	const body = payload(res);
	expect(body.nodes.map((n: any) => n.data.name)).toContain('ada');
	await h.teardown();
});

test('server: a write tool round-trips through a read tool', async () => {
	const h = await harness();
	const created = payload(
		await h.client.callTool({
			name: 'create_node',
			arguments: { tenant: h.tenant, project: h.project, type: 'device', data: { kind: 'sensor' } },
		}),
	);
	expect(created.id).toBeString();

	const fetched = payload(
		await h.client.callTool({
			name: 'get_node',
			arguments: { tenant: h.tenant, project: h.project, id: created.id },
		}),
	);
	expect(fetched.data.kind).toBe('sensor');
	await h.teardown();
});

test('server: a 204 route reports ok rather than an empty body', async () => {
	const h = await harness();
	const created = payload(
		await h.client.callTool({
			name: 'create_node',
			arguments: { tenant: h.tenant, project: h.project, type: 'device', data: { kind: 'gone' } },
		}),
	);
	const res: any = await h.client.callTool({
		name: 'delete_node',
		arguments: { tenant: h.tenant, project: h.project, id: created.id },
	});
	expect(res.isError).toBeFalsy();
	expect(res.structuredContent).toEqual({ ok: true });
	await h.teardown();
});

test('server: a failing route becomes isError, not a thrown transport error', async () => {
	const h = await harness();
	const res: any = await h.client.callTool({
		name: 'get_node',
		arguments: { tenant: h.tenant, project: h.project, id: 'nope' },
	});
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain('404');
	await h.teardown();
});

test('server: read-only mode drops every write tool', async () => {
	const h = await harness({ readOnly: true });
	const { tools } = await h.client.listTools();
	const names = tools.map((t) => t.name);

	for (const write of ['create_node', 'create_edge', 'update_node', 'delete_node', 'delete_edge', 'bulk_load', 'pagerank', 'community', 'centrality']) {
		expect(names).not.toContain(write);
	}
	expect(names).toContain('list_nodes');
	expect(tools.every((t) => t.annotations?.readOnlyHint === true || t.name === 'describe_schema')).toBe(true);
	await h.teardown();
});

test('server: list_projects reaches the tenant-scoped route', async () => {
	const h = await harness();
	const body = payload(await h.client.callTool({ name: 'list_projects', arguments: { tenant: h.tenant } }));
	expect(body.projects.map((p: any) => p.id)).toContain(h.project);
	await h.teardown();
});
```

If `@graphx/core` does not resolve from the test, import from the source path (`../../core/src/index.ts`) the way sibling packages do — check `packages/cli/test/cli.test.ts` for the established convention and match it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/mcp/test/server.test.ts`

Expected: FAIL — `Cannot find module '../src/server.ts'`.

- [ ] **Step 3: Implement `server.ts`**

`packages/mcp/src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Backend } from './backend.ts';
import { buildCall, type RegistryHost, type ToolDescriptor, toolsFrom } from './tools.ts';

/**
 * Builds the `McpServer`: one tool per mirrored route, each call forwarded through the
 * backend as an HTTP request.
 *
 * Failures come back as `isError` results rather than thrown exceptions. A thrown error
 * reaches the model as a transport fault it cannot act on; an `isError` result reaches it as
 * text it can read and retry against.
 */

/** The shape of a `defineGraphSchema` result, structurally. */
export interface GraphSchemaLike {
	nodes: Record<string, unknown>;
	edges: Record<string, unknown>;
}

export interface GraphxMcpOptions {
	/** The serving app — the source of the route registry. */
	app: RegistryHost;
	/** Where tool calls are delivered. */
	backend: Backend;
	/** Register only routes tagged `read`. Default `false`. */
	readOnly?: boolean;
	/** Server name reported in the MCP handshake. Default `graphx`. */
	name?: string;
	/** Server version reported in the MCP handshake. Default `0.1.0`. */
	version?: string;
	/** The graph schema, for the `graphx://schema` resource. Wired in `resources.ts`. */
	schema?: GraphSchemaLike;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `{ error }` message graphx's `onError` emits, or the raw body. */
function errorText(status: number, body: unknown, raw: string): string {
	const message = isRecord(body) && typeof body.error === 'string' ? body.error : raw || 'request failed';
	const issues = isRecord(body) && body.issues ? ` ${JSON.stringify(body.issues)}` : '';
	return `HTTP ${status}: ${message}${issues}`;
}

/** Map a graphx HTTP response onto an MCP tool result. */
export async function toToolResult(res: Response): Promise<{
	content: Array<{ type: 'text'; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}> {
	const raw = await res.text();
	const body = raw ? parseJson(raw) : undefined;

	if (!res.ok) {
		return { isError: true, content: [{ type: 'text', text: errorText(res.status, body, raw) }] };
	}
	// 204 carries no body; an empty string would read to the model as a failed call.
	if (res.status === 204 || raw === '') {
		return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } };
	}
	return {
		content: [{ type: 'text', text: raw }],
		...(isRecord(body) ? { structuredContent: body } : {}),
	};
}

function registerTool(server: McpServer, desc: ToolDescriptor, backend: Backend): void {
	server.registerTool(
		desc.name,
		{
			description: desc.description,
			inputSchema: desc.inputShape,
			annotations: desc.annotations,
		},
		async (args: Record<string, unknown>) => {
			try {
				const { method, path, init } = buildCall(desc, args);
				return await toToolResult(await backend.call(method, path, init));
			} catch (err) {
				// Only a transport-level failure lands here — the graph's own errors arrive as
				// non-2xx responses and are mapped above.
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `${desc.name} failed: ${(err as Error).message}` }],
				};
			}
		},
	);
}

/** The graphx MCP server, ready to `connect(transport)`. */
export function createGraphxMcp(opts: GraphxMcpOptions): McpServer {
	const server = new McpServer({
		name: opts.name ?? 'graphx',
		version: opts.version ?? '0.1.0',
	});
	for (const desc of toolsFrom(opts.app)) {
		if (opts.readOnly && !desc.readOnly) continue;
		registerTool(server, desc, opts.backend);
	}
	return server;
}
```

- [ ] **Step 4: Write `index.ts`**

`packages/mcp/src/index.ts`:

```ts
// Public API for @graphx/mcp — every graphx serving route as an MCP tool.

export {
	type Backend,
	type BackendInit,
	type FetchLike,
	localBackend,
	type RemoteBackendConfig,
	remoteBackend,
} from './backend.ts';
export {
	createGraphxMcp,
	type GraphSchemaLike,
	type GraphxMcpOptions,
	toToolResult,
} from './server.ts';
export {
	buildCall,
	type RegistryHost,
	type ToolAnnotations,
	type ToolDescriptor,
	toolsFrom,
} from './tools.ts';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/mcp/test/server.test.ts`

Expected: PASS, 7 tests. If `list_projects` fails, Task 2 did not land — check it before touching this file.

- [ ] **Step 6: Run the full suite and types**

Run: `bun test --timeout 30000 && bun run lint && bun run type-check`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): the MCP server, tools forwarded through the backend

Each descriptor becomes a registerTool call whose handler rebuilds the
HTTP request and maps the response. Non-2xx becomes an isError result the
model can read, not a thrown transport fault; 204 reports ok rather than
an empty body."
```

---

### Task 6: Schema resource and `describe_schema`

Without this, an agent writing to an empty graph is guessing type names. The resource loads once as context; the tool exists because several MCP clients do not implement resources.

**Files:**
- Create: `packages/mcp/src/resources.ts`
- Modify: `packages/mcp/src/server.ts`, `packages/mcp/src/index.ts`
- Test: `packages/mcp/test/resources.test.ts`

**Interfaces:**
- Consumes: `GraphSchemaLike` (Task 5), `Backend` (Task 3).
- Produces:
  - `interface SchemaDoc { nodes: Record<string, unknown>; edges: Array<{ rel: string; from?: unknown; to?: unknown; single?: boolean }>; inferred?: true }`
  - `function schemaDoc(schema: GraphSchemaLike): SchemaDoc`
  - `function inferSchemaDoc(backend: Backend, tenant: string, project: string): Promise<SchemaDoc>`
  - `function registerSchema(server: McpServer, opts: { schema?: GraphSchemaLike; backend: Backend }): void`

- [ ] **Step 1: Write the failing test**

`packages/mcp/test/resources.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '@graphx/core';
import { schemaDoc } from '../src/resources.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string(), age: z.number().optional() }),
		device: z.object({ kind: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device', single: true },
		knows: { from: 'person', to: 'person' },
	},
});

test('resources: node types become JSON Schema', () => {
	const doc = schemaDoc(SCHEMA);
	expect(Object.keys(doc.nodes).sort()).toEqual(['device', 'person']);
	const person = doc.nodes.person as any;
	expect(person.type).toBe('object');
	expect(Object.keys(person.properties).sort()).toEqual(['age', 'name']);
	expect(person.required).toEqual(['name']);
	expect(doc.inferred).toBeUndefined();
});

test('resources: relations carry their endpoint constraints', () => {
	const doc = schemaDoc(SCHEMA);
	const owns = doc.edges.find((e) => e.rel === 'owns')!;
	expect(owns.from).toBe('person');
	expect(owns.to).toBe('device');
	expect(owns.single).toBe(true);
	const knows = doc.edges.find((e) => e.rel === 'knows')!;
	expect(knows.single).toBeUndefined();
});
```

Then add to `packages/mcp/test/server.test.ts` (the `harness` there already passes `schema: SCHEMA`):

```ts
test('server: exposes the schema as a resource and as a tool', async () => {
	const h = await harness();

	const listed = await h.client.listResources();
	expect(listed.resources.map((r) => r.uri)).toContain('graphx://schema');

	const read = await h.client.readResource({ uri: 'graphx://schema' });
	const doc = JSON.parse(read.contents[0].text as string);
	expect(Object.keys(doc.nodes).sort()).toEqual(['device', 'person']);
	expect(doc.edges.map((e: any) => e.rel)).toContain('owns');

	const viaTool = payload(
		await h.client.callTool({
			name: 'describe_schema',
			arguments: { tenant: h.tenant, project: h.project },
		}),
	);
	expect(viaTool).toEqual(doc);

	await h.teardown();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/mcp/test/resources.test.ts`

Expected: FAIL — `Cannot find module '../src/resources.ts'`.

- [ ] **Step 3: Implement `resources.ts`**

`packages/mcp/src/resources.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Backend } from './backend.ts';
import type { GraphSchemaLike } from './server.ts';

/**
 * Graph-schema discovery. Node types and relation names are compile-time knowledge in
 * `defineGraphSchema` and reach no HTTP surface, so without this an agent writing to an empty
 * graph is guessing type names.
 *
 * Served as a resource (loaded once as context) AND as a tool, because several MCP clients do
 * not implement resources. When the server was built without a schema — the standalone binary
 * pointed at someone else's deployment — types are sampled from the graph and flagged
 * `inferred`, so a caller can tell a guess from a contract.
 */

/** One relation's declaration, flattened. */
export interface SchemaEdge {
	rel: string;
	from?: unknown;
	to?: unknown;
	single?: boolean;
}

/** The `graphx://schema` payload. */
export interface SchemaDoc {
	/** Node type → JSON Schema of its data. Empty objects when inferred. */
	nodes: Record<string, unknown>;
	edges: SchemaEdge[];
	/** Present only when types were sampled from data rather than read from a schema. */
	inferred?: true;
}

export const SCHEMA_URI: string = 'graphx://schema';

/** Convert a `defineGraphSchema` result into the wire document. */
export function schemaDoc(schema: GraphSchemaLike): SchemaDoc {
	const nodes: Record<string, unknown> = {};
	for (const [type, def] of Object.entries(schema.nodes)) {
		nodes[type] = z.toJSONSchema(def as z.ZodType, { io: 'input' });
	}
	const edges: SchemaEdge[] = Object.entries(schema.edges).map(([rel, def]) => {
		const d = (def ?? {}) as { from?: unknown; to?: unknown; single?: boolean };
		return {
			rel,
			...(d.from === undefined ? {} : { from: d.from }),
			...(d.to === undefined ? {} : { to: d.to }),
			...(d.single === undefined ? {} : { single: d.single }),
		};
	});
	return { nodes, edges };
}

/** Fallback for a schemaless server: sample distinct node types off the graph. */
export async function inferSchemaDoc(
	backend: Backend,
	tenant: string,
	project: string,
): Promise<SchemaDoc> {
	const res = await backend.call('GET', `/t/${encodeURIComponent(tenant)}/p/${encodeURIComponent(project)}/nodes`, {
		query: { limit: '200' },
	});
	if (!res.ok) return { nodes: {}, edges: [], inferred: true };
	const body = (await res.json()) as { nodes?: Array<{ type?: string }> };
	const nodes: Record<string, unknown> = {};
	for (const n of body.nodes ?? []) {
		if (n.type) nodes[n.type] = {};
	}
	// Relations are not derivable from a node listing; an empty list is honest here.
	return { nodes, edges: [], inferred: true };
}

/** Register the schema resource and the `describe_schema` tool on `server`. */
export function registerSchema(
	server: McpServer,
	opts: { schema?: GraphSchemaLike; backend: Backend },
): void {
	const known = opts.schema ? schemaDoc(opts.schema) : undefined;

	if (known) {
		server.registerResource(
			'graph-schema',
			SCHEMA_URI,
			{
				title: 'graphx graph schema',
				description: 'Node types as JSON Schema, and the declared relations.',
				mimeType: 'application/json',
			},
			(uri) =>
				Promise.resolve({
					contents: [
						{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(known) },
					],
				}),
		);
	}

	server.registerTool(
		'describe_schema',
		{
			description:
				'The graph schema: node types as JSON Schema, and the declared relations. Read this before writing nodes or building pattern queries.',
			inputSchema: { tenant: z.string(), project: z.string() },
			annotations: { readOnlyHint: true },
		},
		async (args: { tenant: string; project: string }) => {
			const doc = known ?? (await inferSchemaDoc(opts.backend, args.tenant, args.project));
			const text = JSON.stringify(doc);
			return { content: [{ type: 'text' as const, text }], structuredContent: doc as unknown as Record<string, unknown> };
		},
	);
}
```

- [ ] **Step 4: Wire it into `createGraphxMcp`**

In `packages/mcp/src/server.ts`, add the import:

```ts
import { registerSchema } from './resources.ts';
```

and register before returning, inside `createGraphxMcp`:

```ts
	for (const desc of toolsFrom(opts.app)) {
		if (opts.readOnly && !desc.readOnly) continue;
		registerTool(server, desc, opts.backend);
	}
	// Discovery is read-only, so it survives read-only mode.
	registerSchema(server, { schema: opts.schema, backend: opts.backend });
	return server;
```

Add to `packages/mcp/src/index.ts`:

```ts
export {
	inferSchemaDoc,
	registerSchema,
	SCHEMA_URI,
	type SchemaDoc,
	type SchemaEdge,
	schemaDoc,
} from './resources.ts';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/mcp`

Expected: PASS — 2 new resource tests, plus the server test's new resource assertion, plus everything from Tasks 3–5.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): graphx://schema resource and describe_schema tool

Node types and relation names are compile-time knowledge that reaches no
HTTP surface, so an agent writing to an empty graph would be guessing.
A server built without a schema samples types from the graph and flags
the result inferred rather than presenting a guess as a contract."
```

---

### Task 7: Transports — stdio binary and Hono mount

Two ways to reach the server: a process a desktop client spawns, and a route on an existing app.

**Files:**
- Create: `packages/mcp/src/bin.ts`
- Modify: `packages/mcp/src/index.ts`
- Test: `packages/mcp/test/server.test.ts` (mount test appended)

**Interfaces:**
- Consumes: `createGraphxMcp` (Task 5), `localBackend` / `remoteBackend` (Task 3).
- Produces: `function createMcpApp(opts: GraphxMcpOptions): Hono` — a Hono app answering MCP over Streamable HTTP at `/`, meant to be mounted with `app.route('/mcp', createMcpApp(...))`.

- [ ] **Step 1: Write the failing test**

Append to `packages/mcp/test/server.test.ts`:

```ts
test('server: mounts on a Hono app and answers an MCP initialize', async () => {
	const { Hono } = await import('hono');
	const { createMcpApp } = await import('../src/index.ts');

	const db = `mcp_mount_${crypto.randomUUID().replaceAll('-', '')}`;
	const dev = await createApp({ schema: SCHEMA, db, embed: hashEmbed() });
	const host = new Hono();
	host.route(
		'/mcp',
		createMcpApp({
			app: dev.app,
			backend: localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant }),
			schema: SCHEMA,
		}),
	);

	const res = await host.request('/mcp', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1.0.0' },
			},
		}),
	});
	expect(res.status).toBe(200);
	const text = await res.text();
	expect(text).toContain('serverInfo');
	expect(text).toContain('graphx');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/mcp/test/server.test.ts -t "mounts on a Hono app"`

Expected: FAIL — `createMcpApp` is not exported.

- [ ] **Step 3: Implement `createMcpApp`**

Append to `packages/mcp/src/server.ts`:

> **Corrected after the whole-branch review.** This step originally shared one `McpServer` and
> one `StreamableHTTPTransport` across every request, on the claim that this "is what Streamable
> HTTP's session handling expects — the transport, not the route, tracks sessions." That is
> wrong. With no `sessionIdGenerator` the transport runs stateless and keys its request→stream
> mapping on the bare JSON-RPC id, which is a per-client counter starting at 0: two clients
> collide on their first message, one is answered on the other's stream and the other is never
> answered at all (reproduced, and now covered by a test). Both objects are built per request
> instead — which also lets `backend` be resolved per request, so a mounted server can carry the
> caller's identity rather than one baked in at mount time. The shipped code is below.

```ts
import { StreamableHTTPTransport } from '@hono/mcp';
import { type Context, Hono } from 'hono';

/** Options for {@link createMcpApp}. */
export interface McpAppOptions extends Omit<GraphxMcpOptions, 'backend'> {
	backend: Backend | ((c: Context) => Backend | Promise<Backend>);
}

/**
 * The server as a mountable Hono app: `app.route('/mcp', createMcpApp(...))`. Built per
 * request; neither is closed, because `handleRequest` returns while the SSE stream carrying
 * the response is still open. The route authenticates nothing of its own.
 */
export function createMcpApp(opts: McpAppOptions): Hono {
	const app = new Hono();
	app.all('/', async (c) => {
		const backend = typeof opts.backend === 'function' ? await opts.backend(c) : opts.backend;
		const server = createGraphxMcp({ ...opts, backend });
		const transport = new StreamableHTTPTransport();
		await server.connect(transport);
		return (await transport.handleRequest(c)) ?? c.body(null, 202);
	});
	return app;
}
```

Add to `packages/mcp/src/index.ts` — extend the existing `./server.ts` export block:

```ts
export {
	createGraphxMcp,
	createMcpApp,
	type GraphSchemaLike,
	type GraphxMcpOptions,
	toToolResult,
} from './server.ts';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/mcp/test/server.test.ts -t "mounts on a Hono app"`

Expected: PASS.

- [ ] **Step 5: Implement the stdio binary**

`packages/mcp/src/bin.ts`:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import process from 'node:process';
import { createApp, hashEmbed } from '@graphx/core';
import { localBackend, remoteBackend } from './backend.ts';
import { createGraphxMcp } from './server.ts';

/**
 * `graphx-mcp` — the stdio entry point an MCP client spawns.
 *
 * Local mode opens the database directly and runs the serving app in-process. Remote mode
 * proxies a deployed server. Either way the tools are identical, because both go through the
 * same routes.
 *
 * NOTHING may be written to stdout: stdio transport frames JSON-RPC there, and a stray
 * `console.log` corrupts the stream. Diagnostics go to stderr.
 */

/**
 * A graph schema is a TypeScript value, so the binary cannot import one. It runs
 * schemaless: writes still work (the server validates), and `describe_schema` samples types
 * from the graph and flags them `inferred`. Embed a schema by importing this package instead
 * of spawning the binary.
 */
async function main(): Promise<void> {
	const readOnly = process.argv.includes('--read-only') || process.env.GRAPHX_MCP_READ_ONLY === '1';
	const mode = process.env.GRAPHX_MCP_MODE ?? (process.env.GRAPHX_URL ? 'remote' : 'local');

	let app: Parameters<typeof createGraphxMcp>[0]['app'];
	let backend: ReturnType<typeof localBackend>;

	if (mode === 'remote') {
		const url = process.env.GRAPHX_URL;
		if (!url) throw new Error('GRAPHX_MCP_MODE=remote requires GRAPHX_URL');
		// The route registry still comes from a locally built app: the tool surface is a
		// property of the graphx version, not of the deployment being addressed.
		const dev = await createApp({ schema: { nodes: {}, edges: {} }, db: ':memory:', embed: hashEmbed() });
		app = dev.app;
		backend = remoteBackend({ url, apiKey: process.env.GRAPHX_API_KEY });
	} else {
		const db = process.env.GRAPHX_DB;
		if (!db) throw new Error('GRAPHX_MCP_MODE=local requires GRAPHX_DB');
		const dev = await createApp({ schema: { nodes: {}, edges: {} }, db, embed: hashEmbed() });
		app = dev.app;
		backend = localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant });
		// hashEmbed is lexical, not semantic. Saying so beats letting `retrieve` look broken.
		process.stderr.write(
			'graphx-mcp: no embedder configured; retrieve/hybrid use hashEmbed (lexical, not semantic)\n',
		);
	}

	const server = createGraphxMcp({ app, backend, readOnly });
	await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
	process.stderr.write(`graphx-mcp: ${(err as Error).message}\n`);
	process.exit(1);
});
```

If `createApp`'s dev overload rejects an empty schema, pass `defineGraphSchema({ nodes: {}, edges: {} })` instead and import it from `@graphx/core`.

- [ ] **Step 6: Smoke-test the binary**

Run:
```bash
GRAPHX_DB=mcp_smoke bun run packages/mcp/src/bin.ts <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}
EOF
```

Expected: one JSON-RPC response line on stdout containing `"serverInfo"`, and the hashEmbed warning on stderr. The process stays open on stdio — interrupt it.

- [ ] **Step 7: Run everything**

Run: `bun test --timeout 30000 && bun run lint && bun run type-check`

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): stdio binary and mountable Hono app

createMcpApp mounts Streamable HTTP on an existing app; the bin spawns
over stdio. The bin runs schemaless because a graph schema is a
TypeScript value it cannot import, so describe_schema samples and flags
the result. Diagnostics go to stderr — stdout carries JSON-RPC frames."
```

---

### Task 8: Documentation

**Files:**
- Create: `packages/mcp/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing consumed by code.

- [ ] **Step 1: Generate the live tool list**

Run:
```bash
bun -e '
import { createApp, defineGraphSchema } from "./packages/core/src/serve.ts";
import { toolsFrom } from "./packages/mcp/src/tools.ts";
const dev = await createApp({ schema: { nodes: {}, edges: {} }, db: "doc_gen" });
for (const t of toolsFrom(dev.app)) console.log(`| \`${t.name}\` | ${t.readOnly ? "read" : "write"} | ${t.description} |`);
process.exit(0);
'
```

Paste the output into the README's tool table. Do not hand-write it — a stale tool list is worse than none.

- [ ] **Step 2: Write the README**

`packages/mcp/README.md` covering, in order:

1. One paragraph: what it is — every graphx serving route as an MCP tool, generated from the app's OpenAPI registry.
2. **Install**: `bun add @graphx/mcp`.
3. **Claude Desktop / Claude Code config** — a real `mcpServers` JSON block:

```json
{
	"mcpServers": {
		"graphx": {
			"command": "npx",
			"args": ["-y", "@graphx/mcp"],
			"env": {
				"GRAPHX_MCP_MODE": "local",
				"GRAPHX_DB": "file:./graph.db"
			}
		}
	}
}
```

4. **Library usage** — the schema-aware path, which is the one worth recommending:

```ts
import { createApp, hashEmbed } from '@graphx/core';
import { createGraphxMcp, localBackend } from '@graphx/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schema } from './my-schema.ts';

const dev = await createApp({ schema, db: 'file:./graph.db', embed: hashEmbed() });
const server = createGraphxMcp({
	app: dev.app,
	backend: localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant }),
	schema,
});
await server.connect(new StdioServerTransport());
```

5. **Mounting on an existing server**: `app.route('/mcp', createMcpApp({ app, backend, schema }))`.
6. **Configuration table**: `GRAPHX_MCP_MODE`, `GRAPHX_DB`, `GRAPHX_URL`, `GRAPHX_API_KEY`, `GRAPHX_MCP_READ_ONLY`.
7. **Tool list**: the generated table from Step 1, plus `describe_schema`.
8. **Limitations**, stated plainly: `/events` is not mirrored (SSE); the binary runs schemaless so `describe_schema` returns `inferred: true`; the binary defaults to `hashEmbed`, which is lexical rather than semantic.

- [ ] **Step 3: Verify every code block runs**

Copy each TypeScript block from the README into a scratch file and run it under `bun`. Fix whatever fails. A README example that does not run is a bug report waiting to be filed.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/README.md
git commit -m "docs(mcp): README with client config, library usage and limits"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Package layout, deps | 3 |
| Backend seam, local + remote | 3 |
| Registry as source of truth | 4 |
| `operationId` + tags | 1 |
| Input-schema merge, collision guard | 4 |
| Annotations | 4 |
| Read-only mode | 5 |
| Result and error mapping | 5 |
| `graphx://schema` resource | 6 |
| `describe_schema` + inferred fallback | 6 |
| `list_projects` + widened authn | 2 |
| Configuration + embedder warning | 7 |
| stdio + Streamable HTTP transports | 7 |
| Testing (manifest, read-only, reads, writes, errors, resource, coverage, both drivers) | 1, 2, 4, 5, 6 |
| Deferred `GET /stats` | not implemented, per spec |

**Known deviations from the spec, both deliberate:**

1. The spec pins `@modelcontextprotocol/sdk@^1.30`; the plan uses `^1.29.0`. `@hono/mcp@0.3.1` peer-depends on `^1.29.0`, and the local registry blocks releases under 7 days old.
2. The spec's remote-adapter test reuses the read/write assertions with an HTTP-pointed backend. The plan covers the remote backend at the unit level (Task 3) rather than re-running the full suite through it, since `remoteBackend` differs from `localBackend` only in URL construction and one header — both directly asserted.

**Type consistency:** `Backend.call` keeps the same signature in Tasks 3, 4, 5, and 7. `ToolDescriptor` fields are written in Task 4 and read unchanged in Task 5. `GraphSchemaLike` is declared in Task 5 and consumed in Task 6. `createGraphxMcp` and `createMcpApp` share `GraphxMcpOptions`.
