# GraphQL endpoint

`createApp({ graphql: true })` mounts `POST|GET /graphql` (GraphiQL on a browser `GET`).

## Approach

The GraphQL schema is **generated from the app's own OpenAPI document** with
[`openapi-x-graphql`](https://github.com/TimMikeladze/openapi-x-graphql), the same way MCP tools are
generated from the route registry. No second contract, no hand-written resolvers, no drift.

- Every route with an `operationId` becomes a field: `GET` → `Query`, everything else → `Mutation`.
  Field names are the camelCased `operationId` (`list_nodes` → `listNodes`). Routes without one
  (`/health`, `/ready`, the SSE `/events`) are left out — same rule MCP uses.
- Resolvers do not touch the graph directly. Each field builds the HTTP request it describes and
  dispatches it **in-process** to `app.fetch` (custom `fetch`, no socket). Validation, authn, authz,
  limits, guards and error mapping are therefore the REST route's, byte-for-byte.
- The incoming `/graphql` request's headers (minus body/hop headers) are copied onto every
  dispatched request, so `authenticate(c)` sees the caller's `authorization` / cookies / `x-*`.
- A non-2xx route answer becomes a GraphQL error with `extensions.status` and `extensions.body`.
- Schema is built lazily on the first `/graphql` request and cached for the app's lifetime.

## Packaging

`openapi-x-graphql` is an **optional peer dependency**, imported dynamically only when
`graphql` is enabled — apps that never turn it on don't pay for `graphql`. Enabling it without the
package installed answers 501 with an install hint.

## Surface

- `ServeConfig.graphql` / `DevServeConfig.graphql`: `boolean | { path?: string; graphiql?: boolean }`.
- `graphx serve --graphql`.
- CORS comes from the app's own `cors` middleware (the library's CORS is disabled).

## Not covered

- Subscriptions (the SSE `/events` route has no GraphQL counterpart).
- Named reusable object types: route schemas are inline, so types are named per operation
  (`GetNodeResponse`, `ListNodesResponseNodesItem`).
