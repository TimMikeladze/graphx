# Admin Temporal Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin explorer's as-of time travel correct on every read, and replace the sidebar `datetime-local` input with a docked timeline bar that scrubs, snaps to real change points, steps, plays, and locks the UI read-only while viewing the past.

**Architecture:** Four `packages/core` read methods gain an `asOf` parameter and route it through the existing half-open temporal predicate instead of the live `nodes`/`edges` views; a new `timeline.ts` module aggregates change points from both version tables into an extent, a density histogram, and a snap-tick list, served at `GET /timeline`. In `packages/admin`, `asOf` threads into the three inspector reads and their query keys, and a new `components/timeline/` bar drives the existing `filters.asOf` URL state.

**Tech Stack:** Bun (runtime + test runner), TypeScript, Hono + `@hono/zod-openapi` (core HTTP), libSQL and Postgres (dual dialect), React 19 + TanStack Query + TanStack Router, Tailwind + shadcn/ui (admin).

**Spec:** `docs/superpowers/specs/2026-07-28-admin-temporal-filters-design.md`

## Global Constraints

- **No new dependencies.** Every task uses packages already in the workspace.
- **Dual-driver tests.** Core tests obtain connections only via `makeTestDb()` from `packages/core/test/harness.ts` — never `createClient` directly. The suite must pass under both `bun test` (libSQL, the default) and `GRAPHX_TEST_DRIVER=postgres bun test`.
- **Indentation:** tabs in `packages/core`, two spaces in `packages/admin`. Match the file you are editing.
- **Temporal predicate:** always half-open — `valid_from <= t AND t < valid_to`. Use `asOfPredicate(alias)` from `packages/core/src/temporal.ts` rather than retyping it.
- **Live-read convention:** `asOf === undefined` *or* `asOf >= FOREVER` means "now" and must take the live `nodes`/`edges` view path. Never bind `FOREVER` into a temporal predicate. `FOREVER` is imported from `packages/core/src/db.ts`.
- **Pre-commit hook** runs `bun run lint && bun run type-check && bun run clean:db`. A commit that fails lint or type-check will not land — fix, do not bypass.
- **Full test command:** `bun test --timeout 30000` from the repo root (the `test` script). Single file: `bun test packages/core/test/<file>.test.ts`.

## Spec Deviations

Two corrections found while mapping files. Both are already reflected in the tasks below.

1. **Spec §9 says to gate "the write entries in the ⌘K palette."** `packages/admin/src/components/command-palette.tsx` has no write entries — its items are node search, navigate-to-admin, set-token, and theme toggle. Nothing to gate; the palette is not modified by this plan.
2. **Spec §9 omits `ContentTab`.** `packages/admin/src/components/content-tab.tsx` holds an inline body editor backed by `useUpdateNodeBody` — a genuine write path inside the inspector. Task 10 gates it.
3. **Spec §8 lists a "hover readout" on the track.** Task 8 reports the previewed time while *dragging* only. A readout that jumps every time the pointer crosses the track is noise, and the same information is available on drag, which is when it is wanted. Deliberate, not an omission.

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/core/src/timeline.ts` | Change-point aggregation: extent, density buckets, snap ticks. Pure DB reads, no HTTP. |
| `packages/core/test/timeline.test.ts` | Dual-driver tests for the above. |
| `packages/admin/src/lib/timeline.ts` | Pure scrub math — snap, step, presets, time↔pixel. No React. |
| `packages/admin/src/lib/timeline.test.ts` | Unit tests for the above. |
| `packages/admin/src/components/timeline/timeline-track.tsx` | SVG histogram + drag handle. Reports a time; owns no time state. |
| `packages/admin/src/components/timeline/timeline-bar.tsx` | The docked frame: transport controls, track, readout, presets. Owns only `playing`. |
| `packages/admin/src/components/time-travel-banner.tsx` | Amber "viewing the past, read-only" bar with a Return-to-now action. |

**Modified**

| Path | Change |
|---|---|
| `packages/core/src/graph.ts` | `asOf` on `getNode`, `getNodeContent`, `neighborSubquery`, `neighbors`, `neighborsPage`. |
| `packages/core/src/serve.ts` | `asOf` on four route query schemas; new `GET /timeline` route. |
| `packages/core/src/index.ts` | Export the timeline module. |
| `packages/core/test/openapi.test.ts` | Assert the new path is in the document. |
| `packages/admin/src/lib/types.ts` | `Timeline` DTO. |
| `packages/admin/src/lib/api.ts` | `asOf` on three reads; `timeline()`. |
| `packages/admin/src/lib/query-keys.ts` | `asOf` suffix on three keys; `timeline` key. |
| `packages/admin/src/hooks/use-graph.ts` | Thread `asOf`; add `useTimeline`. |
| `packages/admin/src/components/node-detail.tsx` | Accept `asOf` + `readOnly`; pass through. |
| `packages/admin/src/components/node-detail-sheet.tsx` | Same pass-through. |
| `packages/admin/src/components/content-tab.tsx` | Accept `asOf` + `readOnly`; disable editing when read-only. |
| `packages/admin/src/components/graph-shell.tsx` | Render the timeline bar under the canvas. |
| `packages/admin/src/components/app-sidebar.tsx` | Drop the `AsOfPicker`; keep the as-of filter chip. |
| `packages/admin/src/routes/explorer-page.tsx` | Derive `readOnly`; wire the bar, the banner, and `asOf`. |

**Deleted**

| Path | Reason |
|---|---|
| `packages/admin/src/components/filters/as-of-picker.tsx` | Superseded by the timeline bar. Two controls for one filter is a worse UI than either alone. |

---

### Task 1: Core — `asOf` on `getNode` and `getNodeContent`

**Files:**
- Modify: `packages/core/src/graph.ts:622-649` (`getNode`, `getNodeContent`)
- Test: `packages/core/test/p6-temporal.test.ts` (append)

**Interfaces:**
- Consumes: `asOfPredicate` from `./temporal.ts`, `FOREVER` from `./db.ts` (already imported in `graph.ts`).
- Produces:
  - `getNode(id: string, opts?: { asOf?: number }): Promise<AnyNode<S> | null>`
  - `getNodeContent(id: string, opts?: { asOf?: number }): Promise<NodeContent | null>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/p6-temporal.test.ts`:

```ts
test('P6: getNode(asOf) reads the version live at that instant', async () => {
	const { g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router' } });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.updateNode(n.id, { data: { type: 'switch' } });

	// Live and an explicit "now" agree.
	expect((await g.getNode(n.id))?.data.type).toBe('switch');
	expect((await g.getNode(n.id, { asOf: FOREVER }))?.data.type).toBe('switch');
	// The past sees the original.
	expect((await g.getNode(n.id, { asOf: t0 }))?.data.type).toBe('router');
	// Before the node existed there is nothing to see.
	expect(await g.getNode(n.id, { asOf: 1 })).toBeNull();
});

test('P6: getNode(asOf) still finds a retracted node before its retraction', async () => {
	const { g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router' } });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.deleteNode(n.id);

	expect(await g.getNode(n.id)).toBeNull();
	expect((await g.getNode(n.id, { asOf: t0 }))?.data.type).toBe('router');
});

test('P6: getNodeContent(asOf) reads that version body and provenance', async () => {
	const { g } = await freshGraph();
	const n = await g.addNode({ type: 'device', data: { type: 'router' }, body: 'first' });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.updateNode(n.id, { body: 'second' });

	expect((await g.getNodeContent(n.id))?.body).toBe('second');
	expect((await g.getNodeContent(n.id, { asOf: t0 }))?.body).toBe('first');
	expect(await g.getNodeContent(n.id, { asOf: 1 })).toBeNull();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test packages/core/test/p6-temporal.test.ts -t "asOf"`
Expected: FAIL — `getNode` ignores the second argument, so the as-of assertions return the live value (`'switch'`, not `'router'`).

- [ ] **Step 3: Add the import**

In `packages/core/src/graph.ts`, after the `./events.ts` import block, add:

```ts
import { asOfPredicate } from './temporal.ts';
```

- [ ] **Step 4: Implement `getNode`**

Replace the body of `getNode` (`graph.ts:622`):

```ts
	/**
	 * Read a node's version through the live `nodes` view (D3), or — when `asOf` names a past
	 * instant — the single `node_versions` row whose half-open interval contains it. Returns the
	 * typed `{ id, type, data }` shape with data parsed back to an object, or `null` when no
	 * version was live then.
	 */
	async getNode(id: string, opts: { asOf?: number } = {}): Promise<AnyNode<S> | null> {
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const r = await this.raw.execute(
			past
				? {
						sql: `SELECT id, type, data FROM node_versions nv WHERE nv.id = ? AND ${asOfPredicate('nv')}`,
						args: [id, opts.asOf as number, opts.asOf as number],
					}
				: { sql: 'SELECT id, type, data FROM nodes WHERE id = ?', args: [id] },
		);
		const row = r.rows[0];
		if (!row) return null;
		return this.rowToNode(row);
	}
```

- [ ] **Step 5: Implement `getNodeContent`**

Replace the body of `getNodeContent` (`graph.ts:637`), keeping its existing doc comment and adding a sentence about `asOf`:

```ts
	async getNodeContent(id: string, opts: { asOf?: number } = {}): Promise<NodeContent | null> {
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const cols = 'body, uri, content_type, content_hash';
		const r = await this.raw.execute(
			past
				? {
						sql: `SELECT ${cols} FROM node_versions nv WHERE nv.id = ? AND ${asOfPredicate('nv')}`,
						args: [id, opts.asOf as number, opts.asOf as number],
					}
				: { sql: `SELECT ${cols} FROM nodes WHERE id = ?`, args: [id] },
		);
		const row = r.rows[0];
		if (!row) return null;
		return {
			body: (row.body as string | null) ?? null,
			uri: (row.uri as string | null) ?? null,
			contentType: (row.content_type as string | null) ?? null,
			contentHash: (row.content_hash as string | null) ?? null,
		};
	}
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `bun test packages/core/test/p6-temporal.test.ts`
Expected: PASS, including the pre-existing tests in the file.

- [ ] **Step 7: Run the same tests on Postgres**

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/p6-temporal.test.ts`
Expected: PASS. If the Postgres harness is unavailable in this environment, say so explicitly in the task report rather than silently skipping.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/graph.ts packages/core/test/p6-temporal.test.ts
git commit -m "feat(core): read a node and its content as of a past instant"
```

---

### Task 2: Core — `asOf` on `neighbors` and `neighborsPage`

**Files:**
- Modify: `packages/core/src/graph.ts:104-118` (`NeighborOpts`), `:653-706` (`neighborSubquery`, `neighbors`), `:707-742` (`neighborsPage`)
- Test: `packages/core/test/p6-temporal.test.ts` (append)

**Interfaces:**
- Consumes: `asOfPredicate` (imported in Task 1).
- Produces: `NeighborOpts.asOf?: number`, inherited by `NeighborPageOpts`. Both `neighbors(id, opts)` and `neighborsPage(id, opts)` honour it.

Both methods share `neighborSubquery`, so the edge half is one edit. The node-join half is one more in each method.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/p6-temporal.test.ts`:

```ts
test('P6: neighbors(asOf) sees an edge that has since been deleted', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.deleteEdge(e.id);

	expect((await g.neighbors(p.id)).length).toBe(0);
	const past = await g.neighbors(p.id, { asOf: t0 });
	expect(past.map((n) => n.id)).toEqual([d.id]);
});

test('P6: neighbors(asOf) returns the neighbor version live at that instant', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.updateNode(d.id, { data: { type: 'switch' } });

	expect((await g.neighbors(p.id))[0]?.data.type).toBe('switch');
	expect((await g.neighbors(p.id, { asOf: t0 }))[0]?.data.type).toBe('router');
});

test('P6: neighbors(asOf) in both directions, and asOf=FOREVER matches the live read', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'router' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id, data: { since: 1 } });
	const t = Date.now();

	expect((await g.neighbors(d.id, { direction: 'reverse', asOf: t })).map((n) => n.id)).toEqual([
		p.id,
	]);
	expect((await g.neighbors(p.id, { direction: 'both', asOf: t })).map((n) => n.id)).toEqual([d.id]);
	expect((await g.neighbors(p.id, { asOf: FOREVER })).map((n) => n.id)).toEqual(
		(await g.neighbors(p.id)).map((n) => n.id),
	);
});

test('P6: neighborsPage(asOf) pages the as-of neighbor set', async () => {
	const { g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const a = await g.addNode({ type: 'device', data: { type: 'a' } });
	const b = await g.addNode({ type: 'device', data: { type: 'b' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: a.id, data: { since: 1 } });
	const e = await g.addEdge({ rel: 'owns', src: p.id, dst: b.id, data: { since: 2 } });
	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await g.deleteEdge(e.id);

	const live = await g.neighborsPage(p.id, { limit: 10 });
	expect(live.rows.length).toBe(1);

	const first = await g.neighborsPage(p.id, { asOf: t0, limit: 1 });
	expect(first.rows.length).toBe(1);
	expect(first.nextCursor).not.toBeNull();
	const second = await g.neighborsPage(p.id, { asOf: t0, limit: 1, cursor: first.nextCursor! });
	expect(second.rows.length).toBe(1);
	expect([...first.rows, ...second.rows].map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test packages/core/test/p6-temporal.test.ts -t "neighbors"`
Expected: FAIL — `asOf` is not on `NeighborOpts`, so this is a type error first (`bun test` reports it at the call site) and a behavioural failure once typed.

- [ ] **Step 3: Add `asOf` to `NeighborOpts`**

In `packages/core/src/graph.ts:105`:

```ts
/** Traversal options for {@link Graph.neighbors}. */
export interface NeighborOpts {
	direction?: 'forward' | 'reverse' | 'both';
	rels?: string[];
	/** As-of epoch ms (D3 half-open read). Omit ⇒ current (live) edges and nodes. */
	asOf?: number;
	/** §19.2 per-call governance caps; `maxRows` bounds the result (default 10k). */
	limits?: Partial<QueryLimits>;
}
```

`NeighborPageOpts extends NeighborOpts`, so it inherits this with no further change.

- [ ] **Step 4: Make `neighborSubquery` temporal**

Replace `neighborSubquery` (`graph.ts:657`). The temporal predicate is appended *after* the rel clause on each side, so its two args follow that side's rel args:

```ts
	private neighborSubquery(
		id: string,
		opts: NeighborOpts,
	): { sql: string; args: (string | number)[] } {
		const direction = opts.direction ?? 'forward';
		const rels = opts.rels && opts.rels.length > 0 ? opts.rels : null;
		const relClause = rels ? ` AND e.rel IN (${rels.map(() => '?').join(',')})` : '';
		// Past reads walk the version table under the half-open predicate; live reads keep the
		// `edges` view (D3). The predicate's two binds follow that side's rel binds.
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const from = past ? 'edge_versions e' : 'edges e';
		const temporal = past ? ` AND ${asOfPredicate('e')}` : '';
		const side = (t: number | undefined) =>
			past ? [...(rels ?? []), t as number, t as number] : [...(rels ?? [])];
		const args: (string | number)[] = [];
		let sql: string;
		if (direction === 'forward') {
			sql = `SELECT e.dst AS nid FROM ${from} WHERE e.src = ?${relClause}${temporal}`;
			args.push(id, ...side(opts.asOf));
		} else if (direction === 'reverse') {
			sql = `SELECT e.src AS nid FROM ${from} WHERE e.dst = ?${relClause}${temporal}`;
			args.push(id, ...side(opts.asOf));
		} else {
			sql =
				`SELECT e.dst AS nid FROM ${from} WHERE e.src = ?${relClause}${temporal} ` +
				`UNION SELECT e.src AS nid FROM ${from} WHERE e.dst = ?${relClause}${temporal}`;
			args.push(id, ...side(opts.asOf), id, ...side(opts.asOf));
		}
		return { sql, args };
	}
```

- [ ] **Step 5: Make the node join in `neighbors` temporal**

Replace the body of `neighbors` (`graph.ts:687`), keeping its doc comment:

```ts
	async neighbors(id: string, opts: NeighborOpts = {}): Promise<AnyNode<S>[]> {
		const { sql: neighborSql, args } = this.neighborSubquery(id, opts);
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const join = past
			? `JOIN node_versions n ON n.id = nb.nid AND ${asOfPredicate('n')}`
			: 'JOIN nodes n ON n.id = nb.nid';
		const joinArgs = past ? [opts.asOf as number, opts.asOf as number] : [];
		const sql = applyLimit(
			`SELECT n.id AS id, n.type AS type, n.data AS data
			FROM (${neighborSql}) nb
			${join}
			ORDER BY n.id`,
			resolveLimits(opts.limits).maxRows,
		);
		const r = await this.raw.execute({ sql, args: [...args, ...joinArgs] });
		return r.rows.map((row) => this.rowToNode(row));
	}
```

- [ ] **Step 6: Make the node join in `neighborsPage` temporal**

In `neighborsPage` (`graph.ts:707`), the cursor clause is a `WHERE` that follows the join, so the join's binds must be pushed before the cursor's. Replace from `const pageArgs` through the `const sql` template:

```ts
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const join = past
			? `JOIN node_versions n ON n.id = nb.nid AND ${asOfPredicate('n')}`
			: 'JOIN nodes n ON n.id = nb.nid';
		const pageArgs: (string | number)[] = [...args];
		if (past) pageArgs.push(opts.asOf as number, opts.asOf as number);
		let cursorClause = '';
		if (opts.cursor) {
			const [lastId] = decodeCursor(opts.cursor);
			cursorClause = ' WHERE n.id > ?';
			pageArgs.push(lastId as string);
		}
		// Dedup by n.id so the keyset key is unique even when multiple edges reach the
		// same neighbor (a duplicate nid would otherwise break no-overlap/no-skip).
		const { select, group } = distinctSelect(
			dialectOf(this.raw),
			'n.id',
			'n.id AS id, n.type AS type, n.data AS data',
		);
		const sql = `${select}
			FROM (${neighborSql}) nb
			${join}${cursorClause}
			${group}
			ORDER BY n.id
			LIMIT ?`;
```

The rest of the method — the `pageArgs.push(pageSize + 1)` over-fetch and the paging return — is unchanged.

- [ ] **Step 7: Run the tests and verify they pass**

Run: `bun test packages/core/test/p6-temporal.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the neighbor and pagination suites for regressions**

Run: `bun test packages/core/test/p14-pagination.test.ts packages/core/test/p3-data.test.ts packages/core/test/p12-serve.test.ts`
Expected: PASS. These exercise the live paths through the same shared `neighborSubquery`.

- [ ] **Step 9: Run on Postgres**

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/p6-temporal.test.ts packages/core/test/p14-pagination.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/graph.ts packages/core/test/p6-temporal.test.ts
git commit -m "feat(core): traverse neighbors as of a past instant"
```

---

### Task 3: Core — routes accept `asOf` on the four reads

**Files:**
- Modify: `packages/core/src/serve.ts:258-269` (`neighborQuerySchema`), `:866-880` (get node), `:1072-1088` (node content), `:946-968` (neighbors), `:970-992` (neighborsPage)
- Test: `packages/core/test/p12-serve.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 and Task 2's method signatures.
- Produces: `GET /nodes/{id}`, `GET /nodes/{id}/content`, `GET /nodes/{id}/neighbors`, `GET /nodes/{id}/neighborsPage` all accept `?asOf=<epoch ms>`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/p12-serve.test.ts`:

```ts
test('P12 (serve): asOf reaches getNode, content and neighbors over HTTP', async () => {
	const control = makeTestDb().client;
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenant, role: 'editor' });
	const ns = `ns_${ulid().toLowerCase()}`;
	const project = await createProject(control, { tenantId: tenant, name: 'Alpha', dbNamespace: ns });

	const app = createApp({ control, schema: SCHEMA, authenticate });
	const hdr = { 'x-user': editor, 'x-tenant': tenant, 'content-type': 'application/json' };
	const base = `/t/${tenant}/p/${project}`;

	const mk = async (body: unknown) => {
		const res = await app.request(`${base}/nodes`, {
			method: 'POST',
			headers: hdr,
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as { id: string };
	};
	const a = await mk({ type: 'device', data: { name: 'a', criticality: 1 }, body: 'first' });
	const b = await mk({ type: 'device', data: { name: 'b', criticality: 1 } });
	const edgeRes = await app.request(`${base}/edges`, {
		method: 'POST',
		headers: hdr,
		body: JSON.stringify({ rel: 'links', src: a.id, dst: b.id }),
	});
	expect(edgeRes.status).toBe(201);
	const edge = (await edgeRes.json()) as { id: string };

	const t0 = Date.now();
	await new Promise((r) => setTimeout(r, 5));
	await app.request(`${base}/nodes/${a.id}`, {
		method: 'PATCH',
		headers: hdr,
		body: JSON.stringify({ data: { name: 'a2' }, body: 'second' }),
	});
	await app.request(`${base}/edges/${edge.id}`, { method: 'DELETE', headers: hdr });

	const get = async (path: string) => {
		const res = await app.request(`${base}${path}`, { headers: hdr });
		expect(res.status).toBe(200);
		return res.json();
	};

	expect((await get(`/nodes/${a.id}`)).data.name).toBe('a2');
	expect((await get(`/nodes/${a.id}?asOf=${t0}`)).data.name).toBe('a');
	expect((await get(`/nodes/${a.id}/content`)).body).toBe('second');
	expect((await get(`/nodes/${a.id}/content?asOf=${t0}`)).body).toBe('first');
	expect((await get(`/nodes/${a.id}/neighbors`)).length).toBe(0);
	expect((await get(`/nodes/${a.id}/neighbors?asOf=${t0}`)).map((n: any) => n.id)).toEqual([b.id]);
	expect((await get(`/nodes/${a.id}/neighborsPage?asOf=${t0}`)).rows.length).toBe(1);

	evict(ns);
	rmSync(`${ns}.db`, { force: true });
});
```

Note: `SCHEMA` in this file declares only a `device` node type and no edges. Extend the file's existing `SCHEMA` constant to carry a `links` relation:

```ts
const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({
			name: z.string(),
			criticality: z.number(),
			status: z.string().default('online'),
		}),
	},
	edges: { links: { from: 'device', to: 'device' } },
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test packages/core/test/p12-serve.test.ts -t "asOf reaches"`
Expected: FAIL — the as-of reads return the live values (`'a2'`, `'second'`, `[]`), because the routes drop the query parameter.

- [ ] **Step 3: Add `asOf` to the neighbor query schemas**

In `packages/core/src/serve.ts:258`:

```ts
/** GET /nodes/:id/neighbors query. */
const neighborQuerySchema = z.object({
	direction: directionSchema.optional(),
	rel: z.string().optional(),
	asOf: numQuery.optional(),
});
```

`neighborPageQuerySchema` extends it and needs no change.

- [ ] **Step 4: Add an as-of query schema for the two single-node reads**

Next to `neighborQuerySchema` in `serve.ts`:

```ts
/** GET /nodes/:id and GET /nodes/:id/content query — the as-of read instant. */
const asOfQuerySchema = z.object({ asOf: numQuery.optional() });
```

- [ ] **Step 5: Wire the four handlers**

`GET /nodes/{id}` (`serve.ts:873`) — change `request: { params: idParams }` to `request: { params: idParams, query: asOfQuerySchema }` and the handler to:

```ts
			async (c) => {
				const node = await c.get('graph').getNode(c.req.param('id'), c.req.valid('query'));
				if (!node) throw new HTTPException(404, { message: 'node not found' });
				return c.json(node as WireNode, 200);
			},
```

`GET /nodes/{id}/content` (`serve.ts:1079`) — same `request` change, and the handler's `getNodeContent` call takes `c.req.valid('query')` as its second argument.

`GET /nodes/{id}/neighbors` (`serve.ts:958`) — the handler destructures `asOf` too and passes it:

```ts
			async (c) => {
				const { direction, rel, asOf } = c.req.valid('query');
				const list = await c.get('graph').neighbors(c.req.param('id'), {
					direction,
					rels: rel ? [rel] : undefined,
					asOf,
					limits: cfg.limits,
				});
				return c.json(list as WireNode[], 200);
			},
```

`GET /nodes/{id}/neighborsPage` (`serve.ts:982`) — same shape, adding `asOf` to both the destructuring and the options object.

- [ ] **Step 6: Run the test and verify it passes**

Run: `bun test packages/core/test/p12-serve.test.ts`
Expected: PASS, including the file's pre-existing upcaster test.

- [ ] **Step 7: Run the HTTP suites for regressions**

Run: `bun test packages/core/test/p11-serving.test.ts packages/core/test/openapi.test.ts packages/core/test/serve-ops.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/serve.ts packages/core/test/p12-serve.test.ts
git commit -m "feat(core): accept asOf on the node, content and neighbor routes"
```

---

### Task 4: Core — the `timeline` aggregate

**Files:**
- Create: `packages/core/src/timeline.ts`
- Modify: `packages/core/src/index.ts:209-224` (export block)
- Test: `packages/core/test/timeline.test.ts`

**Interfaces:**
- Consumes: `DbClient` from `./dialect.ts`, `FOREVER` from `./db.ts`, `resolveLimits`/`QueryLimits` from `./governance.ts`.
- Produces:
  - `timeline(raw: DbClient, opts?: TimelineOpts): Promise<Timeline>`
  - `interface TimelineOpts { from?: number; to?: number; buckets?: number; limits?: Partial<QueryLimits> }`
  - `interface Timeline { min: number | null; max: number | null; total: number; from: number; to: number; buckets: number[]; ticks: number[]; ticksTruncated: boolean }`
  - `DEFAULT_TIMELINE_BUCKETS = 240`, `MAX_TIMELINE_BUCKETS = 1000`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/timeline.test.ts`:

```ts
import { afterAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { Graph } from '../src/graph.ts';
import { init } from '../src/schema.ts';
import { timeline } from '../src/timeline.ts';
import { insertOrIgnoreSql, makeTestDb } from './harness.ts';

// The timeline aggregate backs the admin explorer's scrubber: the extent of the graph's change
// points, a density histogram over a window, and the distinct instants to snap to. Change points
// are BOTH valid_from and non-FOREVER valid_to — a retraction moves only valid_to, so a
// valid_from-only timeline would hide every delete.

const SCHEMA = defineGraphSchema({
	nodes: { device: z.object({ type: z.string() }), person: z.object({ name: z.string() }) },
	edges: { owns: { from: 'person', to: 'device' } },
});

const DIM = 4;
const teardowns: Array<() => Promise<void>> = [];

async function freshGraph(): Promise<{ client: DbClient; g: Graph<typeof SCHEMA> }> {
	const { client, teardown } = makeTestDb({ file: true });
	teardowns.push(teardown);
	await init(client, DIM);
	return { client, g: new Graph(client, SCHEMA) };
}

afterAll(async () => {
	for (const teardown of teardowns) await teardown();
});

/**
 * Seed rows at exact instants, bypassing the Graph API so the test controls every timestamp.
 * `node_versions.id` carries a FK to `node_identity`, so the identity row comes first — without
 * it Postgres rejects the insert outright.
 */
async function seedNodeVersion(client: DbClient, id: string, from: number, to: number) {
	await client.execute({
		sql: insertOrIgnoreSql(client, 'node_identity', 'id', '?'),
		args: [id],
	});
	await client.execute({
		sql: `INSERT INTO node_versions (id, type, data, valid_from, valid_to) VALUES (?, 'device', '{"type":"r"}', ?, ?)`,
		args: [id, from, to],
	});
}

test('timeline: empty graph reports a null extent and a zero-filled histogram', async () => {
	const { client } = await freshGraph();
	const t = await timeline(client, { buckets: 4 });
	expect(t.min).toBeNull();
	expect(t.max).toBeNull();
	expect(t.total).toBe(0);
	expect(t.buckets).toEqual([0, 0, 0, 0]);
	expect(t.ticks).toEqual([]);
	expect(t.ticksTruncated).toBe(false);
});

test('timeline: extent spans both version tables', async () => {
	const { client, g } = await freshGraph();
	const p = await g.addNode({ type: 'person', data: { name: 'Ada' } });
	const d = await g.addNode({ type: 'device', data: { type: 'r' } });
	await g.addEdge({ rel: 'owns', src: p.id, dst: d.id });
	const t = await timeline(client);
	expect(t.min).not.toBeNull();
	expect(t.max).not.toBeNull();
	expect(t.total).toBeGreaterThanOrEqual(3);
	expect((t.max as number) >= (t.min as number)).toBe(true);
});

test('timeline: a non-FOREVER valid_to counts as its own change point', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 1000, 2000);
	const t = await timeline(client, { buckets: 2 });
	expect(t.min).toBe(1000);
	expect(t.max).toBe(2000);
	expect(t.total).toBe(2);
	expect(t.ticks).toEqual([1000, 2000]);
});

test('timeline: buckets sum to the windowed total and the closing edge lands in the last slot', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 0, 100);
	await seedNodeVersion(client, 'n2', 50, 100);
	const t = await timeline(client, { buckets: 4 });
	// Change points: 0, 50, 100, 100 → from=0, to=100, span=100, slot width 25.
	expect(t.from).toBe(0);
	expect(t.to).toBe(100);
	expect(t.buckets.length).toBe(4);
	expect(t.buckets.reduce((a, b) => a + b, 0)).toBe(4);
	expect(t.buckets[0]).toBe(1); // t=0
	expect(t.buckets[2]).toBe(1); // t=50
	expect(t.buckets[3]).toBe(2); // t=100, clamped into the last slot rather than overflowing
});

test('timeline: from/to narrows both the histogram and the ticks', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 0, 100);
	await seedNodeVersion(client, 'n2', 400, 500);
	const t = await timeline(client, { from: 300, to: 600, buckets: 3 });
	expect(t.min).toBe(0); // extent is unwindowed
	expect(t.max).toBe(500);
	expect(t.from).toBe(300);
	expect(t.to).toBe(600);
	expect(t.ticks).toEqual([400, 500]);
	expect(t.buckets.reduce((a, b) => a + b, 0)).toBe(2);
});

test('timeline: a single-instant graph does not divide by zero', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 7000, 7000);
	await seedNodeVersion(client, 'n2', 7000, 7000);
	const t = await timeline(client, { buckets: 3 });
	expect(t.min).toBe(7000);
	expect(t.max).toBe(7000);
	expect(t.ticks).toEqual([7000]);
	expect(t.buckets[0]).toBe(4);
	expect(t.buckets.reduce((a, b) => a + b, 0)).toBe(4);
});

test('timeline: the tick list is capped and flags truncation', async () => {
	const { client } = await freshGraph();
	for (let i = 0; i < 6; i++) await seedNodeVersion(client, `n${i}`, 1000 + i * 10, 9_000_000);
	const t = await timeline(client, { limits: { maxRows: 3 } });
	expect(t.ticks.length).toBe(3);
	expect(t.ticksTruncated).toBe(true);
	expect(t.ticks).toEqual([1000, 1010, 1020]);
});

test('timeline: buckets is clamped to the supported range', async () => {
	const { client } = await freshGraph();
	await seedNodeVersion(client, 'n1', 0, 100);
	expect((await timeline(client, { buckets: 0 })).buckets.length).toBe(1);
	expect((await timeline(client, { buckets: 99_999 })).buckets.length).toBe(1000);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test packages/core/test/timeline.test.ts`
Expected: FAIL — `Cannot find module '../src/timeline.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/timeline.ts`:

```ts
import { FOREVER } from './db.ts';
import type { DbClient } from './dialect.ts';
import { type QueryLimits, resolveLimits } from './governance.ts';

/**
 * The change-point timeline — the aggregate behind the admin explorer's scrubber.
 *
 * A change point is any instant at which the live graph changed: every `valid_from`, and every
 * `valid_to` that is not the FOREVER sentinel. The `valid_to` half is not optional. A retraction
 * (`deleteNode`/`deleteEdge`) and a single-valued edge supersession both move a `valid_to`
 * WITHOUT writing a new `valid_from` row, so a `valid_from`-only timeline — which is exactly what
 * {@link changeFeed} emits, by decision A.3 — would silently hide every delete.
 */

/** Histogram slots when the caller does not ask for a count. */
export const DEFAULT_TIMELINE_BUCKETS = 240;
/** Upper bound on `buckets`: a scrubber never needs more slots than a wide screen has pixels. */
export const MAX_TIMELINE_BUCKETS = 1000;

/** Options for {@link timeline}. */
export interface TimelineOpts {
	/** Window start, inclusive (epoch ms). Defaults to the graph's earliest change point. */
	from?: number;
	/** Window end, inclusive (epoch ms). Defaults to the graph's latest change point. */
	to?: number;
	/** Histogram slots over the window. Clamped to [1, {@link MAX_TIMELINE_BUCKETS}]. */
	buckets?: number;
	/** §19.2 governance caps; `maxRows` bounds the tick list (default 10k). */
	limits?: Partial<QueryLimits>;
}

/** The change-point extent, a density histogram over a window, and the instants to snap to. */
export interface Timeline {
	/** Earliest change point over ALL time, ignoring `from`/`to`. `null` on an empty graph. */
	min: number | null;
	/** Latest change point over ALL time, ignoring `from`/`to`. `null` on an empty graph. */
	max: number | null;
	/** Change-point count over the full extent. */
	total: number;
	/** The window actually bucketed — the resolved `from`/`to`. */
	from: number;
	to: number;
	/** Length is the resolved bucket count; each slot is a change-point count over the window. */
	buckets: number[];
	/** Distinct change instants in the window, ascending. Drives snap-to-change and step. */
	ticks: number[];
	/** True when `ticks` hit the row cap — narrow the window for an exact list. */
	ticksTruncated: boolean;
}

/** Every change point in the graph, as a single `t` column. */
const CHANGE_POINTS = `
	SELECT valid_from AS t FROM node_versions
	UNION ALL SELECT valid_to AS t FROM node_versions WHERE valid_to < ${FOREVER}
	UNION ALL SELECT valid_from AS t FROM edge_versions
	UNION ALL SELECT valid_to AS t FROM edge_versions WHERE valid_to < ${FOREVER}`;

/** Read one numeric column off the first row, treating a missing row or NULL as `null`. */
function num(row: Record<string, unknown> | undefined, key: string): number | null {
	const v = row?.[key];
	return v === undefined || v === null ? null : Number(v);
}

/**
 * Aggregate the graph's change points into an extent, a density histogram and a snap-tick list.
 *
 * Three queries: the unwindowed extent (so a caller always knows the full range it is scrubbing
 * within), the windowed ticks, and the windowed histogram.
 */
export async function timeline(raw: DbClient, opts: TimelineOpts = {}): Promise<Timeline> {
	const buckets = Math.min(
		Math.max(1, Math.trunc(opts.buckets ?? DEFAULT_TIMELINE_BUCKETS)),
		MAX_TIMELINE_BUCKETS,
	);
	const cap = resolveLimits(opts.limits).maxRows;

	const extent = await raw.execute({
		sql: `SELECT MIN(t) AS lo, MAX(t) AS hi, COUNT(*) AS n FROM (${CHANGE_POINTS}) cp`,
		args: [],
	});
	const head = extent.rows[0] as unknown as Record<string, unknown> | undefined;
	const lo = num(head, 'lo');
	const hi = num(head, 'hi');
	if (lo === null || hi === null) {
		return {
			min: null,
			max: null,
			total: 0,
			from: opts.from ?? 0,
			to: opts.to ?? 0,
			buckets: new Array<number>(buckets).fill(0),
			ticks: [],
			ticksTruncated: false,
		};
	}
	const total = num(head, 'n') ?? 0;
	const from = opts.from ?? lo;
	const to = opts.to ?? hi;

	// Over-fetch one past the cap to detect truncation without a second query (the `feedStream`
	// trick from temporal.ts).
	const tickRows = await raw.execute({
		sql: `SELECT DISTINCT t FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ? ORDER BY t LIMIT ?`,
		args: [from, to, cap + 1],
	});
	const found = (tickRows.rows as unknown as Array<Record<string, unknown>>).map((r) =>
		Number(r.t),
	);
	const ticksTruncated = found.length > cap;
	const ticks = ticksTruncated ? found.slice(0, cap) : found;

	const counts = new Array<number>(buckets).fill(0);
	const span = to - from;
	if (span <= 0) {
		// Every change point in the window shares one instant — there is nothing to spread, and
		// dividing by the span would be a divide-by-zero. One slot holds them all.
		const one = await raw.execute({
			sql: `SELECT COUNT(*) AS n FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ?`,
			args: [from, to],
		});
		counts[0] = num(one.rows[0] as unknown as Record<string, unknown>, 'n') ?? 0;
		return { min: lo, max: hi, total, from, to, buckets: counts, ticks, ticksTruncated };
	}

	// BIGINT, not INTEGER: `(t - from) * buckets` reaches ~1e14 at epoch-ms scale, far past
	// Postgres int4's 2.1e9. BIGINT is native on Postgres and carries INTEGER affinity on SQLite.
	const bucketRows = await raw.execute({
		sql: `SELECT CAST((t - ?) * ? / ? AS BIGINT) AS b, COUNT(*) AS n
			FROM (${CHANGE_POINTS}) cp WHERE t >= ? AND t <= ? GROUP BY b ORDER BY b`,
		args: [from, buckets, span, from, to],
	});
	for (const r of bucketRows.rows as unknown as Array<Record<string, unknown>>) {
		// t === to bins one past the end; clamp rather than branch in SQL.
		const idx = Math.min(buckets - 1, Math.max(0, Number(r.b)));
		counts[idx] += Number(r.n);
	}
	return { min: lo, max: hi, total, from, to, buckets: counts, ticks, ticksTruncated };
}
```

- [ ] **Step 4: Export from the package index**

In `packages/core/src/index.ts`, after the `./temporal.ts` export block (ends line 224), add:

```ts
// Change-point timeline — extent + density histogram + snap ticks (admin scrubber)
export {
	DEFAULT_TIMELINE_BUCKETS,
	MAX_TIMELINE_BUCKETS,
	type Timeline,
	timeline,
	type TimelineOpts,
} from './timeline.ts';
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `bun test packages/core/test/timeline.test.ts`
Expected: PASS, all eight tests.

- [ ] **Step 6: Run on Postgres**

Run: `GRAPHX_TEST_DRIVER=postgres bun test packages/core/test/timeline.test.ts`
Expected: PASS. This is the run that proves the `BIGINT` cast and the `GROUP BY` alias work on both dialects — if it fails, fix it in `packages/core/src/dialect-sql.ts` rather than branching inside `timeline.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/timeline.ts packages/core/src/index.ts packages/core/test/timeline.test.ts
git commit -m "feat(core): aggregate graph change points into a scrubber timeline"
```

---

### Task 5: Core — `GET /timeline`

**Files:**
- Modify: `packages/core/src/serve.ts` (imports, query + response schemas, one route next to `/diff` at `:1268`)
- Test: `packages/core/test/openapi.test.ts` (append), `packages/core/test/p12-serve.test.ts` (append)

**Interfaces:**
- Consumes: `timeline` from Task 4.
- Produces: `GET /t/{tenant}/p/{project}/timeline?from&to&buckets` → the `Timeline` JSON body.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/p12-serve.test.ts`:

```ts
test('P12 (serve): GET /timeline returns the extent, histogram and ticks', async () => {
	const control = makeTestDb().client;
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenant, role: 'editor' });
	const ns = `ns_${ulid().toLowerCase()}`;
	const project = await createProject(control, { tenantId: tenant, name: 'Alpha', dbNamespace: ns });

	const app = createApp({ control, schema: SCHEMA, authenticate });
	const hdr = { 'x-user': editor, 'x-tenant': tenant, 'content-type': 'application/json' };
	const base = `/t/${tenant}/p/${project}`;

	await app.request(`${base}/nodes`, {
		method: 'POST',
		headers: hdr,
		body: JSON.stringify({ type: 'device', data: { name: 'a', criticality: 1 } }),
	});

	const res = await app.request(`${base}/timeline?buckets=8`, { headers: hdr });
	expect(res.status).toBe(200);
	const t = (await res.json()) as {
		min: number | null;
		max: number | null;
		total: number;
		buckets: number[];
		ticks: number[];
		ticksTruncated: boolean;
	};
	expect(t.min).not.toBeNull();
	expect(t.buckets.length).toBe(8);
	expect(t.total).toBeGreaterThanOrEqual(1);
	expect(t.ticks.length).toBeGreaterThanOrEqual(1);
	expect(t.ticksTruncated).toBe(false);

	evict(ns);
	rmSync(`${ns}.db`, { force: true });
});
```

Append to `packages/core/test/openapi.test.ts`:

```ts
test('openapi: the timeline route is documented as a read', async () => {
	const d = await doc();
	const op = d.paths[`${TENANT}/timeline`].get;
	expect(op.operationId).toBe('timeline');
	expect(op.tags).toContain('read');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test packages/core/test/openapi.test.ts -t "timeline"`
Expected: FAIL — `TypeError: undefined is not an object` reading `.get` of an undefined path entry.

- [ ] **Step 3: Import the aggregate**

In `packages/core/src/serve.ts`, alongside the existing `./temporal.ts` import, add:

```ts
import { timeline } from './timeline.ts';
```

- [ ] **Step 4: Add the query and response schemas**

Next to `diffQuerySchema` (`serve.ts:412`):

```ts
/** GET /timeline query — the window to bucket and how many slots to bucket it into. */
const timelineQuerySchema = z.object({
	from: numQuery.optional(),
	to: numQuery.optional(),
	buckets: posIntQuery.optional(),
});

/** GET /timeline response — change-point extent, density histogram, snap ticks. */
const timelineSchema = z.object({
	min: z.number().nullable(),
	max: z.number().nullable(),
	total: z.number(),
	from: z.number(),
	to: z.number(),
	buckets: z.array(z.number()),
	ticks: z.array(z.number()),
	ticksTruncated: z.boolean(),
});
```

- [ ] **Step 5: Register the route**

Immediately after the `/diff` route's closing `)` (`serve.ts:1284`), add:

```ts
		// The change-point timeline behind the admin scrubber. Sibling of /diff and /changes, but
		// keyed on BOTH valid_from and non-FOREVER valid_to, so retractions are visible (A.3).
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/timeline',
				operationId: 'timeline',
				tags: ['read'],
				summary: 'Change-point timeline (extent, density, ticks)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: timelineQuerySchema },
				responses: { 200: json('OK', timelineSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const { from, to, buckets } = c.req.valid('query');
				const t = await timeline(c.get('graph').raw, { from, to, buckets, limits: cfg.limits });
				return c.json(t, 200);
			},
		)
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `bun test packages/core/test/openapi.test.ts packages/core/test/p12-serve.test.ts`
Expected: PASS. The OpenAPI document validator test also covers the new schemas.

- [ ] **Step 7: Run the whole core suite**

Run: `bun test packages/core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/serve.ts packages/core/test/openapi.test.ts packages/core/test/p12-serve.test.ts
git commit -m "feat(core): serve the change-point timeline at GET /timeline"
```

---

### Task 6: Admin — thread `asOf` through the client, keys and hooks

**Files:**
- Modify: `packages/admin/src/lib/types.ts` (append `Timeline`), `packages/admin/src/lib/api.ts:170-244`, `packages/admin/src/lib/query-keys.ts`, `packages/admin/src/hooks/use-graph.ts`
- Modify: `packages/admin/src/components/node-detail.tsx`, `node-detail-sheet.tsx`, `content-tab.tsx` (pass `asOf` through), `packages/admin/src/routes/explorer-page.tsx` (supply it)
- Test: `packages/admin/src/lib/api.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 3 and 5's HTTP surface.
- Produces:
  - `api.getNode(tenant, project, id, asOf?)`, `api.getNodeContent(tenant, project, id, asOf?)`, `api.neighbors(tenant, project, id, asOf?)`
  - `api.timeline(tenant, project, opts?: { from?: number; to?: number; buckets?: number }): Promise<Timeline>`
  - `qk.node`, `qk.nodeContent`, `qk.neighbors` gain a trailing `asOf?: number`
  - `qk.allNode(tenant, project, id)`, `qk.allNodeContent(...)`, `qk.allNeighbors(...)` — as-of-agnostic prefixes for write invalidation
  - `qk.timeline(tenant, project, window: { from?: number; to?: number })`
  - `useNode(tenant?, project?, id?, asOf?)`, `useNodeContent(tenant?, project?, id?, enabled?, asOf?)`, `useNeighbors(tenant?, project?, id?, asOf?)`, `useTimeline(tenant?, project?, window?)`
  - `NodeDetail` and `NodeDetailSheet` accept `asOf?: number`; `ContentTab` accepts `asOf?: number`

- [ ] **Step 1: Write the failing tests**

Append to `packages/admin/src/lib/api.test.ts`, inside the existing `describe("api transport", ...)` block:

```ts
  it("passes asOf to the single-node reads", async () => {
    fetchMock.mockResolvedValue(ok({ id: "n1", type: "device", data: {} }))
    await api.getNode("tA", "pA", "n1", 1234)
    expect(fetchMock.mock.calls[0][0]).toBe("/t/tA/p/pA/nodes/n1?asOf=1234")

    fetchMock.mockResolvedValue(ok({ body: null, uri: null, contentType: null, contentHash: null }))
    await api.getNodeContent("tA", "pA", "n1", 1234)
    expect(fetchMock.mock.calls[1][0]).toBe("/t/tA/p/pA/nodes/n1/content?asOf=1234")

    fetchMock.mockResolvedValue(ok([]))
    await api.neighbors("tA", "pA", "n1", 1234)
    expect(fetchMock.mock.calls[2][0]).toBe("/t/tA/p/pA/nodes/n1/neighbors?asOf=1234")
  })

  it("omits asOf from the single-node reads when live", async () => {
    fetchMock.mockResolvedValue(ok({ id: "n1", type: "device", data: {} }))
    await api.getNode("tA", "pA", "n1")
    expect(fetchMock.mock.calls[0][0]).toBe("/t/tA/p/pA/nodes/n1")
  })

  it("builds the timeline URL", async () => {
    fetchMock.mockResolvedValue(
      ok({
        min: 1,
        max: 2,
        total: 2,
        from: 1,
        to: 2,
        buckets: [1, 1],
        ticks: [1, 2],
        ticksTruncated: false,
      }),
    )
    await api.timeline("tA", "pA", { from: 1, to: 2, buckets: 2 })
    expect(fetchMock.mock.calls[0][0]).toBe("/t/tA/p/pA/timeline?from=1&to=2&buckets=2")
  })
```

Create the query-key test at `packages/admin/src/lib/query-keys.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { qk } from "./query-keys"

describe("query keys", () => {
  it("distinguishes a live read from an as-of read", () => {
    expect(qk.node("t", "p", "n")).not.toEqual(qk.node("t", "p", "n", 5))
    expect(qk.neighbors("t", "p", "n")).not.toEqual(qk.neighbors("t", "p", "n", 5))
    expect(qk.nodeContent("t", "p", "n")).not.toEqual(qk.nodeContent("t", "p", "n", 5))
  })

  it("exposes an asOf-agnostic prefix that every as-of key extends", () => {
    // A write must evict the live entry AND every as-of entry, so the mutations invalidate this
    // prefix rather than a leaf key. TanStack matches partial prefixes, so both are covered.
    const prefix = qk.allNode("t", "p", "n")
    for (const key of [qk.node("t", "p", "n"), qk.node("t", "p", "n", 5)]) {
      expect(key.slice(0, prefix.length)).toEqual([...prefix])
    }
    expect(qk.allNeighbors("t", "p", "n").length).toBe(4)
    expect(qk.allNodeContent("t", "p", "n").length).toBe(4)
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test packages/admin/src/lib/api.test.ts packages/admin/src/lib/query-keys.test.ts`
Expected: FAIL — `api.timeline is not a function`, and `api.getNode` takes three arguments so the URL carries no query string.

- [ ] **Step 3: Add the `Timeline` DTO**

Append to `packages/admin/src/lib/types.ts`:

```ts
/**
 * `GET /timeline` — the graph's change points, aggregated for the scrubber. A change point is any
 * `valid_from` plus any non-FOREVER `valid_to`, so retractions are represented.
 */
export interface Timeline {
  /** Extent over all time, ignoring the requested window. `null` on an empty graph. */
  min: number | null
  max: number | null
  /** Change-point count over the full extent. */
  total: number
  /** The window the server actually bucketed. */
  from: number
  to: number
  /** Change-point counts per equal-width slot over `[from, to]`. */
  buckets: number[]
  /** Distinct change instants in the window, ascending — what the handle snaps to. */
  ticks: number[]
  /** True when `ticks` hit the server row cap; narrow the window for an exact list. */
  ticksTruncated: boolean
}
```

- [ ] **Step 4: Extend the API client**

In `packages/admin/src/lib/api.ts`, add `Timeline` to the type import list, then replace the three read methods and add the timeline call:

```ts
  getNode: (tenant: string, project: string, id: string, asOf?: number) =>
    request<GraphNode>(`${tp(tenant, project)}/nodes/${id}${qs({ asOf })}`),
```

```ts
  getNodeContent: (tenant: string, project: string, id: string, asOf?: number) =>
    request<NodeContent>(`${tp(tenant, project)}/nodes/${id}/content${qs({ asOf })}`),
```

```ts
  neighbors: (tenant: string, project: string, id: string, asOf?: number) =>
    request<GraphNode[]>(`${tp(tenant, project)}/nodes/${id}/neighbors${qs({ asOf })}`),
```

```ts
  /** Change points for the scrubber: full extent, a density histogram, and the snap ticks. */
  timeline: (
    tenant: string,
    project: string,
    opts: { from?: number; to?: number; buckets?: number } = {},
  ) =>
    request<Timeline>(
      `${tp(tenant, project)}/timeline${qs({ from: opts.from, to: opts.to, buckets: opts.buckets })}`,
    ),
```

- [ ] **Step 5: Extend the query keys**

Replace the three keys in `packages/admin/src/lib/query-keys.ts` and add the timeline key:

```ts
  /**
   * The single-node reads are as-of-sensitive, so `asOf` is part of their identity, appended
   * last. A write must evict the live entry AND every as-of entry it may have cached, so the
   * mutations below invalidate the `all*` prefix rather than one of these leaves.
   */
  node: (tenant: string, project: string, id: string, asOf?: number) =>
    ["node", tenant, project, id, asOf ?? null] as const,
  nodeContent: (tenant: string, project: string, id: string, asOf?: number) =>
    ["node-content", tenant, project, id, asOf ?? null] as const,
  neighbors: (tenant: string, project: string, id: string, asOf?: number) =>
    ["neighbors", tenant, project, id, asOf ?? null] as const,
  /** As-of-agnostic prefixes — what a write invalidates. Mirrors `allNodes`/`allGraph` above. */
  allNode: (tenant: string, project: string, id: string) =>
    ["node", tenant, project, id] as const,
  allNodeContent: (tenant: string, project: string, id: string) =>
    ["node-content", tenant, project, id] as const,
  allNeighbors: (tenant: string, project: string, id: string) =>
    ["neighbors", tenant, project, id] as const,
```

`history` is deliberately left alone: the version trail is the whole trail whatever instant is being viewed, so keying it by `asOf` would refetch identical rows on every scrub.

```ts
  timeline: (tenant: string, project: string, window: { from?: number; to?: number } = {}) =>
    ["timeline", tenant, project, window.from ?? null, window.to ?? null] as const,
```

- [ ] **Step 6: Thread `asOf` through the hooks**

In `packages/admin/src/hooks/use-graph.ts`, replace `useNode`, `useNodeContent` and `useNeighbors`, and add `useTimeline`:

```ts
/** A single node (detail Sheet), at `asOf` when one is set. */
export function useNode(tenant?: string, project?: string, id?: string, asOf?: number) {
  return useQuery({
    queryKey: qk.node(tenant ?? "", project ?? "", id ?? "", asOf),
    queryFn: () => api.getNode(tenant as string, project as string, id as string, asOf),
    enabled: Boolean(tenant && project && id),
  })
}
```

```ts
export function useNodeContent(
  tenant?: string,
  project?: string,
  id?: string,
  enabled = true,
  asOf?: number,
) {
  return useQuery({
    queryKey: qk.nodeContent(tenant ?? "", project ?? "", id ?? "", asOf),
    queryFn: () => api.getNodeContent(tenant as string, project as string, id as string, asOf),
    enabled: Boolean(enabled && tenant && project && id),
  })
}
```

```ts
/** A node's neighbors (detail Sheet · Neighbors tab), at `asOf` when one is set. */
export function useNeighbors(tenant?: string, project?: string, id?: string, asOf?: number) {
  return useQuery({
    queryKey: qk.neighbors(tenant ?? "", project ?? "", id ?? "", asOf),
    queryFn: () => api.neighbors(tenant as string, project as string, id as string, asOf),
    enabled: Boolean(tenant && project && id),
  })
}
```

```ts
/**
 * The project's change-point timeline — what the scrubber draws and snaps to. Written to rarely
 * relative to how often it is read, so it is kept for a minute rather than refetched per scrub.
 */
export function useTimeline(
  tenant?: string,
  project?: string,
  window: { from?: number; to?: number } = {},
) {
  return useQuery({
    queryKey: qk.timeline(tenant ?? "", project ?? "", window),
    queryFn: () => api.timeline(tenant as string, project as string, window),
    enabled: Boolean(tenant && project),
    staleTime: 60_000,
  })
}
```

Finally, in the same file, point the four write invalidations at the as-of-agnostic prefixes — a leaf key would now evict only the live entry and leave stale as-of entries cached:

- `useUpdateNodeBody` → `qk.allNodeContent(tenant ?? "", project ?? "", id ?? "")`
- `useUpdateNode` → `qk.allNode(...)` and `qk.allNodeContent(...)` (its `qk.history(...)` call is unchanged)
- `useCreateEdge` and `useDeleteEdge` → `qk.allNeighbors(tenant ?? "", project ?? "", id)` for each endpoint

- [ ] **Step 7: Pass `asOf` down the inspector**

`packages/admin/src/components/node-detail.tsx` — add `asOf?: number` to the props type with the comment `/** Viewing instant; absent ⇒ live. */`, then use it in the three hook calls:

```ts
  const node = useNode(tenant, project, nodeId, asOf)
  const neighbors = useNeighbors(tenant, project, nodeId, asOf)
  const history = useHistory(tenant, project, nodeId)
```

and pass it to the content tab:

```tsx
          <ContentTab
            tenant={tenant}
            project={project}
            nodeId={nodeId}
            active={tab === "content"}
            asOf={asOf}
          />
```

`packages/admin/src/components/content-tab.tsx` — add `asOf?: number` to the props type and forward it:

```ts
  const content = useNodeContent(tenant, project, nodeId, active, asOf)
```

`packages/admin/src/components/node-detail-sheet.tsx` — add `asOf?: number` to the props type and pass it to `<NodeDetail>`.

- [ ] **Step 8: Supply it from the explorer**

In `packages/admin/src/routes/explorer-page.tsx`, pass `asOf={filters.asOf}` to the docked `<NodeDetail>` and to `<NodeDetailSheet>`.

- [ ] **Step 9: Run the tests and verify they pass**

Run: `bun test packages/admin`
Expected: PASS.

- [ ] **Step 10: Type-check**

Run: `bun run --filter '@graphx/admin' type-check`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/admin/src/lib packages/admin/src/hooks packages/admin/src/components/node-detail.tsx packages/admin/src/components/node-detail-sheet.tsx packages/admin/src/components/content-tab.tsx packages/admin/src/routes/explorer-page.tsx
git commit -m "fix(admin): make the inspector honour the as-of filter"
```

---

### Task 7: Admin — scrub math

**Files:**
- Create: `packages/admin/src/lib/timeline.ts`
- Test: `packages/admin/src/lib/timeline.test.ts`

**Interfaces:**
- Produces:
  - `nearestTick(ticks: number[], t: number): number | undefined`
  - `stepTick(ticks: number[], t: number, dir: -1 | 1): number | undefined`
  - `presetTime(preset: TimePreset, now: number): number`
  - `type TimePreset = "1h" | "1d" | "7d"`
  - `timeToX(t: number, from: number, to: number, width: number): number`
  - `xToTime(x: number, from: number, to: number, width: number): number`
  - `PRESETS: readonly TimePreset[]`

Pure functions, no React, no DOM — so the bar's arithmetic is testable without rendering anything.

- [ ] **Step 1: Write the failing tests**

Create `packages/admin/src/lib/timeline.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { nearestTick, presetTime, stepTick, timeToX, xToTime } from "./timeline"

const TICKS = [100, 200, 500, 900]

describe("nearestTick", () => {
  it("returns the closest tick on either side", () => {
    expect(nearestTick(TICKS, 180)).toBe(200)
    expect(nearestTick(TICKS, 120)).toBe(100)
    expect(nearestTick(TICKS, 500)).toBe(500)
  })
  it("clamps past both ends", () => {
    expect(nearestTick(TICKS, 0)).toBe(100)
    expect(nearestTick(TICKS, 10_000)).toBe(900)
  })
  it("breaks an exact tie toward the earlier tick", () => {
    expect(nearestTick([0, 100], 50)).toBe(0)
  })
  it("has nothing to return for an empty tick list", () => {
    expect(nearestTick([], 5)).toBeUndefined()
  })
})

describe("stepTick", () => {
  it("moves to the adjacent tick", () => {
    expect(stepTick(TICKS, 200, 1)).toBe(500)
    expect(stepTick(TICKS, 200, -1)).toBe(100)
  })
  it("steps from a time that is not itself a tick", () => {
    expect(stepTick(TICKS, 250, 1)).toBe(500)
    expect(stepTick(TICKS, 250, -1)).toBe(200)
  })
  it("returns undefined at the ends so the caller can stop", () => {
    expect(stepTick(TICKS, 900, 1)).toBeUndefined()
    expect(stepTick(TICKS, 100, -1)).toBeUndefined()
    expect(stepTick([], 5, 1)).toBeUndefined()
  })
})

describe("presetTime", () => {
  it("subtracts the preset window from now", () => {
    const now = 1_000_000_000_000
    expect(presetTime("1h", now)).toBe(now - 3_600_000)
    expect(presetTime("1d", now)).toBe(now - 86_400_000)
    expect(presetTime("7d", now)).toBe(now - 604_800_000)
  })
})

describe("time and pixel conversion", () => {
  it("round-trips a time through a pixel offset", () => {
    expect(timeToX(500, 0, 1000, 200)).toBe(100)
    expect(xToTime(100, 0, 1000, 200)).toBe(500)
  })
  it("clamps outside the window", () => {
    expect(timeToX(-50, 0, 1000, 200)).toBe(0)
    expect(timeToX(5000, 0, 1000, 200)).toBe(200)
    expect(xToTime(-10, 0, 1000, 200)).toBe(0)
    expect(xToTime(9999, 0, 1000, 200)).toBe(1000)
  })
  it("puts a zero-width window at the start rather than dividing by zero", () => {
    expect(timeToX(7, 7, 7, 200)).toBe(0)
    expect(xToTime(150, 7, 7, 200)).toBe(7)
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bun test packages/admin/src/lib/timeline.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/admin/src/lib/timeline.ts`:

```ts
/**
 * Scrub arithmetic for the timeline bar — snapping, stepping, presets, and the time↔pixel
 * mapping. Pure and DOM-free so the bar's maths is testable without rendering it.
 */

/** The relative windows the bar offers as one-click jumps. */
export type TimePreset = "1h" | "1d" | "7d"

export const PRESETS: readonly TimePreset[] = ["1h", "1d", "7d"]

const PRESET_MS: Record<TimePreset, number> = {
  "1h": 3_600_000,
  "1d": 86_400_000,
  "7d": 604_800_000,
}

/** The preset window's start, relative to `now`. */
export function presetTime(preset: TimePreset, now: number): number {
  return now - PRESET_MS[preset]
}

/**
 * The tick closest to `t`. Dragging is continuous but releasing snaps here, so the handle never
 * settles in a gap where nothing changed. Ties go to the earlier tick — a scrub that lands exactly
 * between two changes shows the state that had already happened.
 */
export function nearestTick(ticks: number[], t: number): number | undefined {
  if (ticks.length === 0) return undefined
  let best = ticks[0]
  let bestDist = Math.abs(t - best)
  for (const tick of ticks) {
    const dist = Math.abs(t - tick)
    if (dist < bestDist) {
      best = tick
      bestDist = dist
    }
  }
  return best
}

/**
 * The next tick strictly after `t` (`dir` 1) or strictly before it (`dir` -1). `undefined` at the
 * ends, which is how the caller knows to stop stepping — and how playback knows it has finished.
 */
export function stepTick(ticks: number[], t: number, dir: -1 | 1): number | undefined {
  if (dir === 1) return ticks.find((tick) => tick > t)
  for (let i = ticks.length - 1; i >= 0; i--) {
    if (ticks[i] < t) return ticks[i]
  }
  return undefined
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Pixel offset of `t` within a `width`-wide track spanning `[from, to]`. */
export function timeToX(t: number, from: number, to: number, width: number): number {
  const span = to - from
  if (span <= 0) return 0
  return clamp(((t - from) / span) * width, 0, width)
}

/** The time a pixel offset represents — the inverse of {@link timeToX}. */
export function xToTime(x: number, from: number, to: number, width: number): number {
  const span = to - from
  if (span <= 0 || width <= 0) return from
  return clamp(from + (x / width) * span, from, to)
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `bun test packages/admin/src/lib/timeline.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/lib/timeline.ts packages/admin/src/lib/timeline.test.ts
git commit -m "feat(admin): add scrub, snap and preset maths for the timeline"
```

---

### Task 8: Admin — the timeline track and bar

**Files:**
- Create: `packages/admin/src/components/timeline/timeline-track.tsx`
- Create: `packages/admin/src/components/timeline/timeline-bar.tsx`

**Interfaces:**
- Consumes: Task 6's `useTimeline`, Task 7's scrub maths, `fmtTime` from `@/lib/format`, `Button` from `@/components/ui/button`.
- Produces:
  - `<TimelineTrack ticks buckets from to value onChange onPreview />`
  - `<TimelineBar tenant project asOf onChange />` — reads `filters.asOf`, calls back with the new one; owns only `playing`.

The bar holds no time state. `asOf` lives in the URL, so a time-travelled view is shareable by link, and the browser Back button walks the scrub history.

- [ ] **Step 1: Write the track**

Create `packages/admin/src/components/timeline/timeline-track.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react"
import { nearestTick, timeToX, xToTime } from "@/lib/timeline"
import { cn } from "@/lib/utils"

/**
 * The scrub track: a change-density histogram with a draggable handle over it.
 *
 * Dragging is continuous — the handle follows the pointer and `onPreview` reports where it is —
 * but the committed value snaps to the nearest real change point on release, so you never land in
 * a gap where the graph did not change.
 */
export function TimelineTrack({
  buckets,
  ticks,
  from,
  to,
  value,
  onChange,
  onPreview,
  disabled,
}: {
  buckets: number[]
  ticks: number[]
  from: number
  to: number
  /** The committed time, or `undefined` when live (the handle parks at the right edge). */
  value?: number
  onChange: (t: number) => void
  /** Fires continuously while dragging so the readout can track the pointer. */
  onPreview?: (t: number | undefined) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState<number | undefined>(undefined)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return from
      return xToTime(clientX - rect.left, from, to, rect.width)
    },
    [from, to],
  )

  // Pointer capture keeps the drag alive when the pointer leaves the track, which it will —
  // the track is 32px tall and people drag horizontally past it.
  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = timeAt(e.clientX)
    setDragging(t)
    onPreview?.(t)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging === undefined) return
    const t = timeAt(e.clientX)
    setDragging(t)
    onPreview?.(t)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragging === undefined) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    const snapped = nearestTick(ticks, dragging)
    setDragging(undefined)
    onPreview?.(undefined)
    if (snapped !== undefined) onChange(snapped)
  }

  const peak = Math.max(1, ...buckets)
  const handleAt = dragging ?? value
  const handleX = handleAt === undefined ? width : timeToX(handleAt, from, to, width)

  return (
    <div
      ref={ref}
      className={cn(
        "relative h-8 flex-1 touch-none select-none",
        disabled ? "cursor-default opacity-50" : "cursor-pointer",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="slider"
      aria-label="As-of time"
      aria-valuemin={from}
      aria-valuemax={to}
      aria-valuenow={handleAt ?? to}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
    >
      {/* density */}
      <div className="absolute inset-x-0 bottom-2 flex h-6 items-end gap-px">
        {buckets.map((n, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-[1px] bg-muted-foreground/25"
            style={{ height: `${(n / peak) * 100}%` }}
          />
        ))}
      </div>
      {/* baseline */}
      <div className="absolute inset-x-0 bottom-2 h-px bg-border" />
      {/* handle */}
      {width > 0 && (
        <div
          className="pointer-events-none absolute bottom-0 w-px bg-primary"
          style={{ left: handleX, height: "100%" }}
        >
          <span className="absolute -top-0.5 -left-[3px] size-[7px] rounded-full bg-primary ring-2 ring-background" />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Write the bar**

Create `packages/admin/src/components/timeline/timeline-bar.tsx`:

```tsx
import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { NextIcon, PreviousIcon } from "@hugeicons/core-free-icons"
import { TimelineTrack } from "@/components/timeline/timeline-track"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { useTimeline } from "@/hooks/use-graph"
import { fmtTime } from "@/lib/format"
import { PRESETS, presetTime, stepTick } from "@/lib/timeline"

/**
 * The docked time-travel control. It owns no time state — `asOf` lives in the URL, so a
 * time-travelled view is shareable and the Back button walks the scrub history.
 */
export function TimelineBar({
  tenant,
  project,
  asOf,
  onChange,
}: {
  tenant: string
  project: string
  /** The current as-of instant; `undefined` ⇒ live. */
  asOf?: number
  onChange: (asOf: number | undefined) => void
}) {
  const timeline = useTimeline(tenant, project)
  const isMobile = useIsMobile()
  const [preview, setPreview] = useState<number | undefined>(undefined)

  const data = timeline.data
  const empty = !data || data.min === null || data.max === null
  const from = data?.from ?? 0
  const to = data?.to ?? 0
  const ticks = data?.ticks ?? []
  const current = asOf ?? to
  const shown = preview ?? asOf

  const go = (t: number | undefined) => onChange(t)
  const step = (dir: -1 | 1) => {
    const next = stepTick(ticks, current, dir)
    if (next !== undefined) go(next)
  }

  // A 32px scrub track on a phone is not usable and the canvas needs the height more, so the bar
  // collapses to what it is showing plus the way back to live.
  if (isMobile) {
    return (
      <div className="flex items-center gap-2 border-t bg-background px-3 py-1.5 text-xs">
        <span className="tabular-nums text-muted-foreground">
          {empty ? "No history" : asOf === undefined ? "Now" : fmtTime(asOf)}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={asOf === undefined}
          onClick={() => go(undefined)}
        >
          Now
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 border-t bg-background px-3 py-1.5">
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous change"
          disabled={empty || stepTick(ticks, current, -1) === undefined}
          onClick={() => step(-1)}
        >
          <HugeiconsIcon icon={PreviousIcon} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next change"
          disabled={empty || stepTick(ticks, current, 1) === undefined}
          onClick={() => step(1)}
        >
          <HugeiconsIcon icon={NextIcon} strokeWidth={2} />
        </Button>
      </div>

      <TimelineTrack
        buckets={data?.buckets ?? []}
        ticks={ticks}
        from={from}
        to={to}
        value={asOf}
        onChange={go}
        onPreview={setPreview}
        disabled={empty}
      />

      <span className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {empty ? "No history" : shown === undefined ? "Now" : fmtTime(shown)}
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        {PRESETS.map((p) => (
          <Button
            key={p}
            variant="ghost"
            size="xs"
            disabled={empty}
            onClick={() => go(presetTime(p, Date.now()))}
          >
            {p}
          </Button>
        ))}
        <Button variant="ghost" size="xs" disabled={asOf === undefined} onClick={() => go(undefined)}>
          Now
        </Button>
      </div>
    </div>
  )
}
```

Playback's icons and state arrive in Task 11 — importing them now would leave unused bindings and fail lint.

- [ ] **Step 3: Verify the icon names exist**

Run: `grep -oE "(Previous|Next|Play|Pause)[A-Za-z0-9]*Icon" node_modules/@hugeicons/core-free-icons/index.d.ts | sort -u | head -20`
Expected: the exact exported names, including the `PlayIcon`/`PauseIcon` that Task 11 needs. If `PreviousIcon`/`NextIcon` are not among them, substitute the closest exported transport icons and keep the `aria-label`s as written.

- [ ] **Step 4: Type-check**

Run: `bun run --filter '@graphx/admin' type-check`
Expected: exit 0. Nothing renders the bar yet — that is Task 9.

- [ ] **Step 5: Lint**

Run: `bun run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/admin/src/components/timeline
git commit -m "feat(admin): add the timeline track and bar"
```

---

### Task 9: Admin — mount the bar, retire the sidebar picker

**Files:**
- Modify: `packages/admin/src/components/graph-shell.tsx` (props + layout)
- Modify: `packages/admin/src/routes/explorer-page.tsx` (pass the bar's props)
- Modify: `packages/admin/src/components/app-sidebar.tsx` (drop `AsOfPicker`)
- Delete: `packages/admin/src/components/filters/as-of-picker.tsx`

**Interfaces:**
- Consumes: Task 8's `<TimelineBar>`.
- Produces: `GraphShell` accepts `timeline?: React.ReactNode`, rendered under the canvas.

`GraphShell` returns early for the loading and empty states, so the bar cannot go inside its main return alone — it would vanish exactly when you scrub into a period with no nodes, which is when you most need it to scrub back out. Wrap all three branches instead.

- [ ] **Step 1: Add the slot to `GraphShell`**

In `packages/admin/src/components/graph-shell.tsx`, add to the props type:

```ts
  /**
   * The time-travel bar, docked under the canvas. Passed as a node rather than built here so the
   * shell stays a pure canvas frame with no data dependencies of its own.
   */
  timeline?: React.ReactNode
```

Then wrap each of the three returns so the bar survives the loading and empty states. Replace the loading return:

```tsx
  if (isLoading) {
    return (
      <div className="flex h-full w-full flex-col">
        <div className={cn("min-h-0 flex-1", backdrop)}>
          <EmptyState icon={ChartRelationshipIcon} title="Loading graph…" className="animate-pulse" />
        </div>
        {timeline}
      </div>
    )
  }
```

the empty return:

```tsx
  if (!slice || slice.nodes.length === 0) {
    return (
      <div className="flex h-full w-full flex-col">
        <div className={cn("min-h-0 flex-1", backdrop)}>
          <EmptyState
            icon={ChartRelationshipIcon}
            title="No graph for these filters"
            hint="Broaden the NodeType or search filters to see connected nodes."
          />
        </div>
        {timeline}
      </div>
    )
  }
```

and the main return — rename the existing outer `<div ref={containerRef} …>` to be nested inside a new flex column, so fullscreen still targets the canvas container:

```tsx
  return (
    <div className="flex h-full w-full flex-col">
      <div
        ref={containerRef}
        className={cn("relative min-h-0 w-full flex-1", isCosmograph && "dark text-foreground")}
        style={isCosmograph ? { background: CANVAS_BG } : undefined}
      >
        {/*
          Every existing child moves across verbatim, in order and unedited: the <ErrorBoundary>
          wrapping GraphCanvas/FlowCanvas, the vignette div, the stats pill, <GraphToolbar>, and
          the legend block. Only the wrapper above them changes.
        */}
      </div>
      {timeline}
    </div>
  )
```

- [ ] **Step 2: Pass the bar from the explorer**

In `packages/admin/src/routes/explorer-page.tsx`, add to the `<GraphShell …>` element:

```tsx
              timeline={
                <TimelineBar
                  tenant={tenant}
                  project={project}
                  asOf={filters.asOf}
                  onChange={(asOf) => setSearch({ asOf })}
                />
              }
```

and import it:

```ts
import { TimelineBar } from "@/components/timeline/timeline-bar"
```

- [ ] **Step 3: Retire the sidebar picker**

In `packages/admin/src/components/app-sidebar.tsx`, remove the `AsOfPicker` import and its `<AsOfPicker … />` line. Leave the as-of `FilterChip` and the `asOf: undefined` entries in `hasFilters` and "Clear all" — the chip still reports and clears the filter, and the bar is now the way to set it.

- [ ] **Step 4: Delete the picker**

```bash
git rm packages/admin/src/components/filters/as-of-picker.tsx
```

- [ ] **Step 5: Verify nothing else referenced it**

Run: `grep -rn "as-of-picker\|AsOfPicker" packages/admin/src`
Expected: no output.

- [ ] **Step 6: Type-check and lint**

Run: `bun run --filter '@graphx/admin' type-check && bun run lint`
Expected: exit 0 for both.

- [ ] **Step 7: Verify in the running app**

Run: `bun run dev:admin`
Check: the bar is docked under the canvas; the histogram draws; dragging the handle changes the URL's `asOf`; the node list and canvas change with it; **Now** clears it. Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add packages/admin/src/components/graph-shell.tsx packages/admin/src/routes/explorer-page.tsx packages/admin/src/components/app-sidebar.tsx
git commit -m "feat(admin): dock the timeline bar and retire the as-of picker"
```

---

### Task 10: Admin — read-only while viewing the past

**Files:**
- Create: `packages/admin/src/components/time-travel-banner.tsx`
- Modify: `packages/admin/src/routes/explorer-page.tsx`
- Modify: `packages/admin/src/components/node-detail.tsx`, `node-detail-sheet.tsx`, `content-tab.tsx`

**Interfaces:**
- Consumes: `filters.asOf`.
- Produces: `<TimeTravelBanner asOf onReturn />`; `ContentTab` accepts `readOnly?: boolean`.

A write issued from a historical view lands on the **live** version, not the one on screen. That is a silent footgun, so the past is read-only.

- [ ] **Step 1: Write the banner**

Create `packages/admin/src/components/time-travel-banner.tsx`, matching `results-banner.tsx`'s amber treatment:

```tsx
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon } from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { fmtTime } from "@/lib/format"

/**
 * Shown whenever the explorer is pinned to a past instant. Editing is disabled there because a
 * write applies to the LIVE version, not the one on screen — so the banner says which instant is
 * being viewed and offers the way back.
 */
export function TimeTravelBanner({ asOf, onReturn }: { asOf: number; onReturn: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-3.5 shrink-0" />
      <span>
        Viewing <span className="font-medium tabular-nums">{fmtTime(asOf)}</span> — read-only,
        because an edit would apply to the live version rather than this one.
      </span>
      <Button
        variant="link"
        size="xs"
        className="ml-auto h-auto p-0 text-amber-700 dark:text-amber-400"
        onClick={onReturn}
      >
        Return to now
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Gate the explorer's write entry points**

In `packages/admin/src/routes/explorer-page.tsx`, derive the flag next to the other derived values:

```ts
  // A write from a historical view would land on the live version, not the one on screen.
  const readOnly = filters.asOf !== undefined
```

Render the banner directly under the existing truncation banner:

```tsx
        {filters.asOf !== undefined && (
          <TimeTravelBanner asOf={filters.asOf} onReturn={() => setSearch({ asOf: undefined })} />
        )}
```

`GraphShell` already documents that absent write handlers mean a read-only explorer, so the canvas half is subtractive — make each of the five handlers conditional:

```tsx
              onCreateNode={readOnly ? undefined : () => setEditorFor(null)}
              onEditNode={readOnly ? undefined : (id) => setEditorFor(id)}
              onDeleteNode={readOnly ? undefined : (id) => setDeleteFor(id)}
              onDrawEdge={readOnly ? undefined : (edge) => setDrawnEdge(edge)}
              onDeleteEdge={readOnly ? undefined : (edge) => setEdgeToRemove(edge)}
```

Do the same for `onEdit`/`onDelete` on both the docked `<NodeDetail>` and `<NodeDetailSheet>`, and pass `readOnly={readOnly}` to each.

- [ ] **Step 3: Gate the content editor**

`packages/admin/src/components/node-detail.tsx` — add `readOnly?: boolean` to the props type and forward it to `<ContentTab readOnly={readOnly} />`.

`packages/admin/src/components/node-detail-sheet.tsx` — add `readOnly?: boolean` and forward it to `<NodeDetail>`.

`packages/admin/src/components/content-tab.tsx` — add `readOnly?: boolean` to the props type, then make `edit` refuse to open a draft and `commit` refuse to fire:

```ts
  function edit(next: string | null) {
    if (readOnly && next !== null) return
    if (next === null) drafts.delete(nodeId)
    else drafts.set(nodeId, next)
    setDraft(next)
  }

  function commit() {
    if (readOnly || draft === null || save.isPending) return
```

Two controls open the editor, and both need `disabled={readOnly}`: the **Add content** button in the no-body `EmptyState`'s `action` prop (`onClick={() => edit("")}`), and the outlined **Edit** button in the view-mode header (`onClick={() => edit(body)}`).

- [ ] **Step 4: Type-check and lint**

Run: `bun run --filter '@graphx/admin' type-check && bun run lint`
Expected: exit 0 for both.

- [ ] **Step 5: Verify in the running app**

Run: `bun run dev:admin`
Check: scrub into the past → the amber banner appears; the toolbar's create button, the flow canvas's right-click menu, and the inspector's edit/delete controls are gone or disabled; the Content tab cannot be edited; **Return to now** restores all of them. Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add packages/admin/src/components/time-travel-banner.tsx packages/admin/src/routes/explorer-page.tsx packages/admin/src/components/node-detail.tsx packages/admin/src/components/node-detail-sheet.tsx packages/admin/src/components/content-tab.tsx
git commit -m "feat(admin): lock the explorer read-only while viewing the past"
```

---

### Task 11: Admin — playback

**Files:**
- Modify: `packages/admin/src/components/timeline/timeline-bar.tsx`
- Modify: `packages/admin/src/components/graph-shell.tsx` (pin the simulation while playing)
- Modify: `packages/admin/src/routes/explorer-page.tsx` (thread the playing flag)

**Interfaces:**
- Consumes: Task 7's `stepTick`, Task 8's bar.
- Produces: `TimelineBar` accepts `onPlayingChange?: (playing: boolean) => void`; `GraphShell` accepts `pinSimulation?: boolean`.

- [ ] **Step 1: Add playback to the bar**

In `packages/admin/src/components/timeline/timeline-bar.tsx`, add the imports:

```ts
import { useEffect, useRef, useState } from "react"
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"
```

Add `onPlayingChange?: (playing: boolean) => void` to the props type, then the state and the timer:

```ts
  const [playing, setPlaying] = useState(false)

  // The timer reads its inputs through a ref rather than closing over them. `onChange` is an
  // inline arrow at the call site, so listing it as a dependency would tear the interval down and
  // rebuild it on every parent render — a 700ms timer that keeps restarting never fires.
  const latest = useRef({ ticks, current, onChange })
  latest.current = { ticks, current, onChange }

  // Advance tick-to-tick. Each step is a filter change, so every dependent query refetches; the
  // interval is slow enough that a step's fetches land before the next one starts on a local DB.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      const { ticks: ts, current: now, onChange: emit } = latest.current
      const next = stepTick(ts, now, 1)
      if (next === undefined) setPlaying(false)
      else emit(next)
    }, 700)
    return () => clearInterval(id)
  }, [playing])

  useEffect(() => {
    onPlayingChange?.(playing)
  }, [playing, onPlayingChange])
```

Any manual interaction pauses. Wrap the existing `go` so every scrub, step, preset and Now stops playback:

```ts
  const go = (t: number | undefined) => {
    setPlaying(false)
    onChange(t)
  }
```

The interval calls `onChange` directly rather than `go`, so it does not pause itself.

Add the transport button between the step buttons:

```tsx
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? "Pause playback" : "Play through changes"}
          disabled={empty || (!playing && stepTick(ticks, current, 1) === undefined)}
          onClick={() => setPlaying((p) => !p)}
        >
          <HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} strokeWidth={2} />
        </Button>
```

- [ ] **Step 2: Pin the simulation while playing**

In `packages/admin/src/components/graph-shell.tsx`, add to the props type:

```ts
  /**
   * Hold the force simulation still. A fresh slice every playback step would otherwise restart
   * the simulation and the graph would explode rather than evolve in place.
   */
  pinSimulation?: boolean
```

and feed it to the canvas alongside the user's own pause toggle:

```tsx
            paused={paused || Boolean(pinSimulation)}
```

- [ ] **Step 3: Thread the flag through the explorer**

In `packages/admin/src/routes/explorer-page.tsx`:

```ts
  const [playing, setPlaying] = useState(false)
```

pass `pinSimulation={playing}` to `<GraphShell>` and `onPlayingChange={setPlaying}` to `<TimelineBar>`.

- [ ] **Step 4: Type-check and lint**

Run: `bun run --filter '@graphx/admin' type-check && bun run lint`
Expected: exit 0 for both.

- [ ] **Step 5: Verify in the running app**

Run: `bun run dev:admin`
Check: press play → `asOf` advances change by change and the graph evolves in place rather than relaying out each step; playback stops at the last change point; dragging the handle, stepping, or pressing a preset pauses it. Stop the dev server when done.

- [ ] **Step 6: Run the full suite**

Run: `bun test --timeout 30000`
Expected: PASS, every package.

- [ ] **Step 7: Commit**

```bash
git add packages/admin/src/components/timeline/timeline-bar.tsx packages/admin/src/components/graph-shell.tsx packages/admin/src/routes/explorer-page.tsx
git commit -m "feat(admin): play through the graph's change points"
```

---

## Final Verification

- [ ] `bun test --timeout 30000` — full suite, libSQL
- [ ] `GRAPHX_TEST_DRIVER=postgres bun test --timeout 30000` — full suite, Postgres
- [ ] `bun run type-check` — all packages
- [ ] `bun run lint`
- [ ] `grep -rn "as-of-picker\|AsOfPicker" packages/admin/src` returns nothing
