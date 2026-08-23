# IoT fleet example — Vite + Bun + SQLite + React

A tiny IoT fleet graph (sites / gateways / devices / alerts) on `graphx` (libSQL/SQLite,
served by Bun) with a `graphx/react` frontend (Vite). It shows the end-to-end typed surface: typed
nodes, rel/kind-narrowed neighbors, per-alias `useMatch`, mutations, and CDC live-sync — **no
codegen**.

## Run

Two shells (from this directory):

```sh
bun run server.ts   # graphx API on :8899 (SQLite file iot_demo.db, seeded each start)
bun run dev         # Vite on :5173, proxies /t + /demo + /openapi.json -> :8899
```

Open the Vite URL. The client uses `<GraphProvider bootstrap="/demo">` — it fetches the seeded
tenant/project/user ids itself (no hardcoded ids). Interactive API docs (Scalar) are at
[`/docs`](http://localhost:5173/docs); the raw contract is at `GET /openapi.json`.

## Test it (no server, no port)

```sh
bun test   # runs app.test.tsx
```

`app.test.tsx` renders the UI against an **in-process** `createApp` via `fetch={appFetch(app)}` — real
routes, real Zod validation, real CDC keyset, no listener. It also turns on `{ validate: true }`
(runtime response validation) since the schema value is already in scope there.

## DX helpers shown here

- **`bootstrap="/demo"`** — `src/main.tsx`: id-less provider setup.
- **`hashEmbed()` + `cors: true`** — `server.ts`: model-free embedder (auto-dim) + no dev proxy needed.
- **Fluent `useMatch`** — `src/App.tsx`: `q => q.node('d','device').in('raised').node('a','alert').select('d','a')`.
- **`GraphError.code`** — `src/App.tsx`: the ack button surfaces a typed error `code` (e.g. `forbidden`).
- **`appFetch` + `validate`** — `app.test.tsx`: in-process testing + runtime validation.

## The graph

```
gateway --deployedAt--> site
device  --connectedTo-> gateway   (data: { rssi })
alert   --raised------> device
```

## How the typing works

- `schema.ts` defines the graph once. The **server** imports the value (`schema`) to seed + serve;
  the **client** imports only the type (`import type { Schema }`) and calls
  `createGraphHooks<Schema>()` — so the browser bundle carries **no `graphx`/SDK runtime**, just
  `graphx/react` + your schema's type.
- The hooks are typed from `Schema`:
  - `g.useNode(id, 'gateway')` → `NodeOf<Schema,'gateway'> | null`
  - `g.useNeighbors(id, { rel: 'deployedAt' })` → `site[]` (from `deployedAt.to`);
    `{ rel: 'connectedTo', direction: 'reverse' }` → `device[]` (from `connectedTo.from`)
  - `g.useListNodes({ type: 'alert' })` → `alert[]`
  - `g.useMatch(q => q.node('d','device').in('raised').node('a','alert').select('d','a'))` → rows
    typed per alias (`{ d: device; a: alert }`); the object form (`{ steps, select }`) works too
- `g.useChangeFeedSync()` tails `/changes` and invalidates exactly the affected query keys — ack an
  alert (or run the server's seed again) and the live feed updates.

Edit a field in `schema.ts` and the client, server, and `/openapi.json` all move together.
