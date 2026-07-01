# IoT fleet example — Vite + Bun + SQLite + React

A tiny IoT fleet graph (sites / gateways / devices / alerts) on `@graphx/core` (libSQL/SQLite,
served by Bun) with a `@graphx/react` frontend (Vite). It shows the end-to-end typed surface: typed
nodes, rel/kind-narrowed neighbors, per-alias `useMatch`, mutations, and CDC live-sync — **no
codegen**.

## Run

Two shells (from this directory):

```sh
bun run server.ts   # graphx API on :8899 (SQLite file iot_demo.db, seeded each start)
bun run dev         # Vite on :5173, proxies /t + /demo + /openapi.json -> :8899
```

Open the Vite URL. `GET /demo` hands the client the seeded tenant/project/user ids; the API contract
is at `GET /openapi.json`.

## The graph

```
gateway --deployedAt--> site
device  --connectedTo-> gateway   (props: { rssi })
alert   --raised------> device
```

## How the typing works

- `schema.ts` defines the graph once. The **server** imports the value (`schema`) to seed + serve;
  the **client** imports only the type (`import type { Schema }`) and calls
  `createGraphHooks<Schema>()` — so the browser bundle carries **no `@graphx/core`/SDK runtime**, just
  `@graphx/react` + your schema's type.
- The hooks are typed from `Schema`:
  - `g.useNode(id, 'gateway')` → `NodeOf<Schema,'gateway'> | null`
  - `g.useNeighbors(id, { rel: 'deployedAt' })` → `site[]` (from `deployedAt.to`);
    `{ rel: 'connectedTo', direction: 'reverse' }` → `device[]` (from `connectedTo.from`)
  - `g.useListNodes({ kind: 'alert' })` → `alert[]`
  - `g.useMatch({ steps: [...], select: ['d','a'] })` → rows typed per alias (`{ d: device; a: alert }`)
- `g.useChangeFeedSync()` tails `/changes` and invalidates exactly the affected query keys — ack an
  alert (or run the server's seed again) and the live feed updates.

Edit a field in `schema.ts` and the client, server, and `/openapi.json` all move together.
