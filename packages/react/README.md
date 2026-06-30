# @graphx/react

Inference-only [React Query](https://tanstack.com/query) hooks for [graphx](../core) — typed query,
mutation, and infinite-scroll hooks plus **CDC-driven live cache sync**, with **no codegen**. Types
are inferred from the same `defineGraphSchema(...)` that validates writes server-side.

## Install

```sh
bun add @graphx/react @tanstack/react-query react
```

`@tanstack/react-query`, `react`, and `@graphx/core` are peer dependencies.

## Quickstart

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createGraphHooks, GraphProvider } from '@graphx/react';
import { defineGraphSchema } from '@graphx/core';
import { z } from 'zod';

const schema = defineGraphSchema({
  nodes: { person: z.object({ name: z.string() }) },
  edges: { knows: { from: 'person', to: 'person' } },
});

// Call once at module scope. `g` carries the per-schema types.
export const g = createGraphHooks(schema);

const queryClient = new QueryClient();

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <GraphProvider
        baseUrl="https://api.example.com"
        tenant="acme"
        project="alpha"
        headers={() => ({ authorization: `Bearer ${token}` })}
      >
        <App />
      </GraphProvider>
    </QueryClientProvider>
  );
}

function NodeCard({ id }: { id: string }) {
  const { data, isLoading } = g.useNode(id); // data: AnyNode<typeof schema> | null
  const update = g.useUpdateNode();
  if (isLoading) return <Spinner />;
  return <button onClick={() => update.mutate({ id, patch: { props: { name: 'Ada' } } })}>{data?.props.name}</button>;
}
```

`GraphProvider` config:

| Prop | Required | Notes |
|---|---|---|
| `baseUrl` | no (default `''`) | Origin the server is mounted at. `''` = same-origin / in-process. |
| `tenant`, `project` | yes | Routes are `/t/:tenant/p/:project/...`. |
| `headers` | no | `() => Record<string,string> \| Promise<...>` — re-read per request (refreshed tokens). |
| `fetch` | no (default global) | Inject for SSR or to point at an in-process Hono app (`app.request`). |

## Hooks

**Queries** (`useQuery`): `useNode(id)` → `AnyNode<S> | null` (→ `null` on 404); pass the expected
kind — `useNode(id, 'device')` → `NodeOf<S,'device'> | null` (narrowed, and runtime-checked: a
mismatched stored kind resolves to `null`, so no discriminating). `useHistory`, `useGraphSlice`, `useRetrieve`,
`useHybrid`, `useJourney`, `useMatch`, `useDiff`, `useShortestPath`, `useTopNodes`.

`useMatch` is fully typed per alias — pass the spec inline and each selected alias's row is
kind-narrowed from the pattern:
```ts
const m = g.useMatch({
  steps: [{ node: { alias: 'p', kind: 'person' } }, { edge: { rel: 'owns' } },
          { node: { alias: 'd', kind: 'device' } }],
  select: ['p', 'd'],
});
m.data?.rows[0]?.d.props.type;   // ^? typed NodeOf<S,'device'> — node.kind & rel are schema-checked
```

**Infinite** (`useInfiniteQuery`, keyset cursor): `useNeighbors(id, { limit })`,
`useListNodes({ limit })` — page via `fetchNextPage()` / `hasNextPage`. Both narrow when you scope
them: `useNeighbors(id, { rel: 'owns' })` → rows typed `NodeOf<S,'device'>[]` (the schema's
`owns.to` pins it; reverse hops use `from`); `useListNodes({ kind: 'device' })` → `NodeOf<S,'device'>[]`.
The server enforces the rel/kind filter, so the narrowing is server-backed, not a blind cast.

**Mutations** (`useMutation`, invalidate-on-settle): `useAddNode`, `useAddEdge`, `useUpdateNode`,
`useDeleteEdge`, `useDeleteNode`, `useBulkLoad`, and the persisted-analytics ops `usePagerank`,
`useCommunity`, `useCentrality`.

**Live sync:** `useChangeFeedSync({ intervalMs?, fromNow? })` — see below.

**Utilities:** `useKeys()` (the project-scoped query-key factory for manual invalidation/prefetch),
`graphKeys(project)` (standalone), `GraphError` (`{ status, message, issues? }`, the React Query
`error` for any non-2xx).

## CDC live sync

`useChangeFeedSync` tails `/changes` and invalidates **exactly** the affected query keys — `node(id)`
per changed node, `neighbors(src/dst)` per changed edge, plus the list/slice queries — instead of a
blind interval refetch. The `(valid_from, ver)` keyset advances incrementally so polling never skips
or double-counts.

```tsx
function LiveSync() {
  g.useChangeFeedSync({ intervalMs: 2000 }); // mount once near the root
  return null;
}
```

- `fromNow: true` skips the existing backlog on mount (positions the cursor at the tip) — avoids a
  mount-time invalidation storm over a large graph.
- The feed is `valid_from`-only: it carries inserts and update-successors, **not** pure closes
  (`deleteEdge`, single-valued supersession). Edge/node *removals* are reconciled by the mutation
  hooks' `onSettled`, so drive deletes through `useDeleteEdge` / `useDeleteNode`.

## Optimistic updates

The hooks default to **invalidate-on-settle**, not optimistic, for writes that gain server-derived
fields (the server mints the ULID, applies zod defaults, stamps the P12 `_v` — none of which the
client can predict). Add your own optimistic `onMutate`/rollback for simple toggles if needed.

## A note on published types

Because the generic `createGraphHooks` return can't be expressed under TypeScript isolated
declarations, this package is built with bunup `dts.inferTypes` (tsc inference) so the published
`.d.ts` carries full per-hook types. (`core`'s `AppType` has the inverse limitation — consume its
source for precise route types.)

## Testing

Hooks are tested with `@testing-library/react` + `happy-dom`, rendering against an **in-process**
`createApp(...)` (`fetch` pointed at `app.request`) — real routes, real zod validation, real CDC
keyset, on both libSQL and Postgres. See `test/` for the harness.
