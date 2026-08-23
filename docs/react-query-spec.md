# `graphx-react` — React Query integration

> Status: **IMPLEMENTED** (`packages/react`, 2026-06-29). Net-new package layered over the existing
> SDK + Hono serving layer. Hooks for the whole HTTP surface (the "Everything" scope), CDC live-sync,
> infinite scroll, mutation invalidation. Tests run on both backends via the in-process app.
>
> Two deviations from the draft below, both deliberate: (1) the hook set is **single-factory** —
> every hook is defined inside `createGraphHooks<S>` (binds `S` cleanly) rather than split per-file;
> (2) the published `.d.ts` is emitted with bunup `dts.inferTypes` (tsc inference) because the
> generic factory return can't be expressed under isolated declarations — without it the type
> collapses to `{}`. CDC cursor advance also goes beyond the draft: it advances to the last row seen
> even when the feed reports `nextCursor: null`, so steady-state polling stays incremental.

## 1. Goal

Ship a thin, **inference-only** React Query (`@tanstack/react-query`) binding for graphx that gives
React apps typed hooks for every HTTP-exposed graph operation — query hooks, mutation hooks, keyset
infinite-scroll, and (the differentiator) **CDC-driven live cache invalidation** off the §19.10
change feed — with **no codegen** and types **inferred through the same zod** that validates writes
server-side.

### Non-goals

- No GraphQL (the project is Hono REST by decision D2).
- No codegen / no build step (consistent with D2's "typed client, no codegen").
- No new query semantics — hooks are a transport + cache wrapper over the SDK's existing surface.
- No client-side governance overrides — `limits` are server-set and non-client-overridable (§19.2).

## 2. Design principles

1. **Reuse the SDK's zod-inferred types; do not regenerate them.** The precise, per-kind contracts
   already exist and are exported from `graph.ts`:
   - inputs: `AddNodeInput<S, K>`, `AddEdgeInput<S, R>`, `PropsInput<S, K>`, `EdgePropsInput<S, R>`
   - outputs: `NodeOf<S, K>`, `AnyNode<S>`, `EdgeRef`, `NeighborPage<S>`
   - read opts: `NeighborOpts`, `NeighborPageOpts`, `RetrieveOpts`, `JourneyOpts`, `RetrievedNode`,
     `JourneyRow`
     These are `z.input` / `z.infer` of the user's `defineGraphSchema(...)`. A hook's in/out types come
     straight from them.

2. **Generic factory parameterised by the user's schema `S`** (mirrors `createApp<S>`). Per-kind prop
   typing requires the user's `S`, because the _wire_ schemas are deliberately loose
   (`nodeInputSchema = { kind: z.string(), props: z.record(...) }`). So the public entry is
   `createGraphHooks(schema)`, not standalone hooks.

3. **Do NOT rely on `hc<AppType>` for types.** Known limitation (documented in `serve.ts`): under
   `isolatedDeclarations`, Hono's inferred per-route RPC schema cannot be emitted into `.d.ts`
   (probed TS9007/TS9010), so from the published package `hc` request bodies and `res.json()` resolve
   to `unknown`. **Decision:** type the hooks from `S` + the SDK domain types above; use `hc`/`fetch`
   purely as the runtime transport. This sidesteps the limitation entirely.

## 3. Current HTTP surface (what hooks can wrap today)

From `serve.ts`, the routes that exist:

| Method | Path                                             | SDK call                   | React hook                              |
| ------ | ------------------------------------------------ | -------------------------- | --------------------------------------- |
| POST   | `/t/:tenant/p/:project/nodes`                    | `addNode`                  | `useAddNode`                            |
| POST   | `/t/:tenant/p/:project/edges`                    | `addEdge`                  | `useAddEdge`                            |
| GET    | `/t/:tenant/p/:project/nodes/:id`                | `getNode`                  | `useNode`                               |
| PATCH  | `/t/:tenant/p/:project/nodes/:id`                | `updateNode`               | `useUpdateNode`                         |
| DELETE | `/t/:tenant/p/:project/edges/:id`                | `deleteEdge`               | `useDeleteEdge`                         |
| GET    | `/t/:tenant/p/:project/nodes/:id/neighbors`      | `neighbors` (unpaginated)  | `useNeighbors`                          |
| GET    | `/t/:tenant/p/:project/nodes/:id/neighborsPage`  | `neighborsPage` (keyset)   | `useNeighbors` (infinite)               |
| GET    | `/t/:tenant/p/:project/nodes/:id/history`        | `history`                  | `useHistory`                            |
| GET    | `/t/:tenant/p/:project/nodes`                    | `listNodes`                | —                                       |
| GET    | `/t/:tenant/p/:project/graph`                    | `graphSlice`               | —                                       |
| GET    | `/t/:tenant/p/:project/retrieve`                 | `retrieve`                 | `useRetrieve`                           |
| POST   | `/t/:tenant/p/:project/hybrid`                   | `hybridRetrieve`           | —                                       |
| POST   | `/t/:tenant/p/:project/journey`                  | `journey`                  | `useJourney`                            |
| POST   | `/t/:tenant/p/:project/match`                    | `match` / `PatternBuilder` | —                                       |
| POST   | `/t/:tenant/p/:project/bulk`                     | `bulkLoad`                 | —                                       |
| GET    | `/t/:tenant/p/:project/changes`                  | `changeFeed`               | `useChangeFeedSync` ← **CDC live-sync** |
| GET    | `/t/:tenant/p/:project/diff`                     | `diff`                     | reconciliation (close events)           |
| POST   | `/t/:tenant/p/:project/algorithms/shortest-path` | `shortestPath`             | —                                       |
| POST   | `/t/:tenant/p/:project/algorithms/pagerank`      | `pagerank`                 | —                                       |
| POST   | `/t/:tenant/p/:project/algorithms/community`     | `community`                | —                                       |
| POST   | `/t/:tenant/p/:project/algorithms/centrality`    | `centrality`               | —                                       |
| GET    | `/t/:tenant/p/:project/algorithms/top`           | `topNodes`                 | —                                       |
| GET    | `/health`, `/ready`                              | —                          | (ops, no hook)                          |

**Still SDK-only:** `buildCSR`/`snapshotCSR`/CSR `neighbors` and the `constraints` setup ops
(reasonably SDK-only). The whole R0 HTTP surface is now live.

## 4. Phase 0 — HTTP surface expansion (DONE)

The hooks we want (infinite scroll, mutations, live sync) needed routes that didn't exist. All of
these are now in `serve.ts`, each with a zod wire schema and `requireGraph(op)`:

| Method | Path                       | SDK call        | Op    | Backs                                             | Status |
| ------ | -------------------------- | --------------- | ----- | ------------------------------------------------- | ------ |
| GET    | `/nodes/:id/neighborsPage` | `neighborsPage` | read  | `useNeighbors` (infinite)                         | done   |
| PATCH  | `/nodes/:id`               | `updateNode`    | write | `useUpdateNode`                                   | done   |
| DELETE | `/edges/:id`               | `deleteEdge`    | write | `useDeleteEdge`                                   | done   |
| GET    | `/nodes/:id/history`       | `history`       | read  | `useHistory`                                      | done   |
| GET    | `/changes`                 | `changeFeed`    | read  | `useChangeFeedSync` ← **the CDC live-sync route** | done   |
| GET    | `/diff`                    | `diff`          | read  | reconciliation (close events)                     | done   |

Notes:

- `/changes` takes opaque per-stream cursors as query params: `?nodes=<cursor>&edges=<cursor>&limit=`.
  Returns the `ChangeFeedPage` shape verbatim (`{ nodes, edges, nextCursor: { nodes, edges } }`).
  changeFeed emits **raw stored bytes** (never upcast) — preserved over the wire.
- `match`/`hybridRetrieve`/algorithms were originally out of v1 scope but are now exposed too (see §3).
  `match` accepts a JSON-serialized PatternBuilder program; `hybrid`/`algorithms` omit their
  function-valued opts (`rerank`, shortest-path `heuristic`) since those aren't wire-serializable.
  pagerank/community/centrality require `write` (they persist to `node_analytics`).
- The `onError` mapping handles all of these (ZodError→400, AuthzError→403/404, SQLITE_CONSTRAINT/
  SQLSTATE-23→400, `invalid cursor`→400, `updateNode|deleteEdge: no live version`→404, and the
  `addNode|addEdge|bulkLoad|PatternBuilder:` client-input prefixes →400).

## 5. Package shape

```ts
// createGraphHooks — generic over the user's schema S (like createApp)
export function createGraphHooks<S extends GraphSchema>(schema: S) {
	// returns { useNode, useNeighbors, useRetrieve, useJourney, useHistory,
	//           useAddNode, useAddEdge, useUpdateNode, useDeleteEdge,
	//           useChangeFeedSync, keys }
}
```

- **Provider**: `<GraphProvider baseUrl tenant project headers>` supplies transport config via context
  (routes are `/t/:tenant/p/:project/...`; `headers` is a getter for auth — JWT/session/API key).
  Wrap in the app's `QueryClientProvider`.
- **Query keys**: a single `keys` factory, project-scoped, opaque-cursor-friendly:
  ```ts
  keys.node(id); // ['graphx', project, 'node', id]
  keys.neighbors(id, opts); // ['graphx', project, 'neighbors', id, opts]
  keys.retrieve(params); // ['graphx', project, 'retrieve', params]
  keys.journey(body);
  keys.history(id);
  keys.changes();
  ```

## 6. Hook catalog + inference contract

| Hook                     | RQ primitive             | Input type (inferred)               | Output type (inferred)  |
| ------------------------ | ------------------------ | ----------------------------------- | ----------------------- |
| `useNode(id)`            | `useQuery`               | `string`                            | `AnyNode<S> \| null`    |
| `useNeighbors(id, opts)` | `useInfiniteQuery`       | `NeighborPageOpts`                  | `NeighborPage<S>` pages |
| `useRetrieve(params)`    | `useQuery`               | `RetrieveOpts` (no `limits`)        | `RetrievedNode[]`       |
| `useJourney(body)`       | `useQuery`/`useMutation` | `JourneyOpts` (no `limits`)         | `JourneyRow[]`          |
| `useHistory(id)`         | `useQuery`               | `string`                            | raw version rows        |
| `useAddNode()`           | `useMutation`            | `AddNodeInput<S, Kind<S>>`          | `NodeOf<S, Kind<S>>`    |
| `useAddEdge()`           | `useMutation`            | `AddEdgeInput<S, Rel<S>>`           | `EdgeRef`               |
| `useUpdateNode()`        | `useMutation`            | `{ id: string; patch: Partial<…> }` | `void`                  |
| `useDeleteEdge()`        | `useMutation`            | `string`                            | `void`                  |
| `useChangeFeedSync()`    | `useQuery` (polling)     | —                                   | `ChangeFeedPage`        |

`limits` is intentionally absent from client input types — the server applies it (§19.2), not the
client.

### Infinite neighbors

The SDK's keyset pagination maps directly:

```ts
useInfiniteQuery({
	queryKey: keys.neighbors(id, opts),
	queryFn: ({ pageParam }) => getPage(`/nodes/${id}/neighborsPage`, { cursor: pageParam, ...opts }),
	initialPageParam: undefined as string | undefined,
	getNextPageParam: (last) => last.nextCursor ?? undefined, // null = last page → stops
});
```

`nextCursor` is opaque base64; thread it untouched.

## 7. CDC-driven live invalidation (the differentiator)

A single poller hook tails `/changes` and invalidates **exactly** the affected query keys instead of
blind interval refetch:

```ts
function useChangeFeedSync(intervalMs = 2000) {
	const cursor = useRef<{ nodes?: string; edges?: string }>({});
	return useQuery({
		queryKey: keys.changes(),
		refetchInterval: intervalMs,
		queryFn: async () => {
			const page = await getChanges(cursor.current); // GET /changes?nodes=&edges=
			for (const n of page.nodes) qc.invalidateQueries({ queryKey: keys.node(String(n.id)) });
			for (const e of page.edges) {
				qc.invalidateQueries({ queryKey: keys.neighbors(String(e.src)) });
				qc.invalidateQueries({ queryKey: keys.neighbors(String(e.dst)) });
			}
			cursor.current = {
				nodes: page.nextCursor.nodes ?? cursor.current.nodes, // null = caught up → keep last cursor
				edges: page.nextCursor.edges ?? cursor.current.edges,
			};
			return page;
		},
	});
}
```

The `(valid_from, ver)` keyset guarantees no skip / no overlap, so the poller never double-invalidates
or misses a version.

### Close/delete caveat (decision A.3)

The feed is **valid_from-only**: it surfaces INSERTs + UPDATE-successors, **not** pure closes
(`deleteEdge`, single-valued `addEdge` supersession move `valid_to` with no new row). So edge
_removals_ will not arrive via the feed. Handle them one of two ways:

- **(recommended for v1)** invalidate on the mutation's `onSettled` — the client already holds the
  affected ids for `useDeleteEdge`/single-valued `useAddEdge`.
- **(follow-up)** add the `valid_to`-keyed companion close-feed (documented §19.10 follow-up) and a
  matching `/changes` close cursor.

## 8. Mutations & cache invalidation

Invalidation matrix (on `onSettled`):

| Mutation        | Invalidate                                                     |
| --------------- | -------------------------------------------------------------- |
| `useAddNode`    | nothing required (new id; or `keys.node(newId)` to prime)      |
| `useAddEdge`    | `keys.neighbors(src)`, `keys.neighbors(dst)`, `keys.node(dst)` |
| `useUpdateNode` | `keys.node(id)`, `keys.history(id)`                            |
| `useDeleteEdge` | `keys.neighbors(src)`, `keys.neighbors(dst)`                   |

### Optimistic-update policy

**Default to invalidate-on-settle, not optimistic, for writes that gain server-derived fields.** The
server mints the ULID `id`, applies zod **defaults** (e.g. `crit: 1`), and stamps the P12 `_v` — none
of which the client can predict, so an optimistic cache entry won't byte-match the server response.
Optimistic updates are acceptable only for `useDeleteEdge` / simple toggles, with rollback in
`onError`.

## 9. Cross-cutting

- **Auth / tenant**: all data routes are `/t/:tenant/p/:project/...`; the provider injects
  `tenant`/`project` + auth `headers`. A 401 (unauthenticated) / 403 (role) / 404 (cross-tenant
  confused-deputy) surfaces as the React Query `error`.
- **Error mapping**: 4xx → typed error object (`{ status, message, issues? }` from `onError`); 5xx →
  generic. Map `invalid cursor` / validation issues for form display.
- **SSR / prefetch**: standard `queryClient.prefetchQuery` with the same `keys` factory; hooks are
  isomorphic (transport is `fetch`).
- **Optional runtime response validation**: if the wire zod schemas are exported from `serve.ts`
  (currently module-private), hooks can `schema.parse(res)` for a runtime guard. Decision: ship
  without it in v1 (trust the typed server), add behind a flag if needed.

## 10. Testing strategy (fully local)

- Unit: render hooks under a real `QueryClient` + a mocked `fetch`/`hc`; assert query keys,
  `getNextPageParam` cursor threading, and the invalidation matrix fire.
- Integration: run `createApp(cfg)` in-process (as the P11/P15 tests do) and point the transport at
  `app.request` / `Bun.serve` — exercises real routes, real zod validation, real CDC keyset.
- CDC sync: drive writes through the SDK, assert `useChangeFeedSync` invalidates the right keys and
  advances cursors with no skip/overlap (mirror the P15 CDC keyset tests).

No infra required — everything is local (libSQL `:memory:`/`file:` + in-process Hono).

## 11. Open decisions / forks

1. **`useJourney` as query vs mutation** — `journey` is a POST with a body but is read-only. Lean
   `useQuery` keyed on the body (cacheable), unless bodies are large/volatile → then `useMutation`.
2. **CDC cursor persistence** — in-memory ref (lost on remount) vs `localStorage` (survives reload,
   resumes the tail). v1: in-memory; flag for persistence.
3. **Polling vs SSE/WebSocket for CDC** — v1 polls `/changes` (no new infra). A push transport is a
   later optimisation; the cursor contract is unchanged.
4. **Package boundary** — `graphx-react` depends on `@tanstack/react-query` (peer) + the core types
   only (no runtime core import beyond types). Keep React out of `core`.

## 12. Out of scope (v1)

`match` / `hybridRetrieve` / algorithms hooks; the `valid_to` close-feed; optimistic writes for
server-derived shapes; SSE/WebSocket transport; GraphQL.

## 13. Build phases

- **R0** ✅ DONE — HTTP surface expansion (§4): `neighborsPage`, `updateNode`, `deleteEdge`,
  `history`, `changes`, `diff` (+ `hybrid`/`bulk`/`match`/`algorithms`) routes + wire schemas + tests.
- **R1** ✅ DONE — `graphx-react` package: provider, `keys`, query hooks, infinite neighbors,
  mutation hooks + invalidation matrix. TDD with the in-process app (real routes/zod/CDC keyset).
- **R2** ✅ DONE — `useChangeFeedSync` live invalidation + the close-handling policy (closes
  reconciled via mutation `onSettled`).
- **R3** — not yet: runtime response validation, cursor persistence, close-feed companion.
