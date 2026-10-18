# Better Auth integration

Better Auth owns users, credentials, sessions, organizations, memberships, invitations,
teams, organization roles, administrator accounts, and API keys. Graphx stores projects
and graph data. Organization IDs are tenant IDs. There is no mirrored membership,
user, tenant, or API-key table in the integration's registry.

## Public API

`graphx/better-auth` exports `createGraphxAuth(options, pluginOptions?)` and
`createBetterAuthApp({ auth, control, schema, ...serveOptions })`. The auth helper
configures Better Auth's organization, admin, bearer, and organization-owned API-key
plugins. Consumers supply Better Auth's database, providers, secrets, email delivery,
and any additional plugins. The organization preset includes teams and dynamic roles.
Graph permissions are Better Auth access-control statements: `graph: read`, `write`,
and `manage`. Owners/admins manage projects, members read/write, viewers read.

The app mounts Better Auth at its configured base path and Graphx's existing graph
routes. Sessions are verified with cookie caching disabled; membership permissions
are checked by Better Auth for each request, scoped to the URL's organization.
Session active organization is not authority for URL access. API keys are verified by
Better Auth once per request, scoped to the `graphx` organization-key configuration;
their permissions are evaluated by Better Auth's access-control implementation.
Keys can be sent as `x-api-key` or `Authorization: Bearer`. A supplied invalid key
cannot fall back to a valid session. Neither organization admins nor global admins
bypass project-to-organization isolation.

The Graphx registry initializer creates only `projects`, without a foreign key to
Graphx's legacy tenants table. It does not migrate or remove existing data. Existing
control-plane APIs remain available for applications using the standalone server.
The integration does not mount the legacy admin CRUD endpoints. Better Auth's
endpoints handle identity administration. Graphx adds project creation under
`POST /t/:tenant/projects`, gated by `graph: manage`.

React transport gets an explicit `credentials` option propagated through normal
requests, bootstrap, and event streams. The server uses credentialed CORS restricted
to Better Auth's trusted origins. Development mode reflects origins and configures
Better Auth to trust the request origin; production retains explicit origin checks.
OpenAPI describes both cookie sessions and API-key authentication in this mode.

## Implementation

- [x] Add a tenant-authorization hook to the existing authorization path, preserving
      the project ownership check and covering project listing.
- [x] Add Better Auth presets and the app integration as an optional package export;
      test real signup, organization creation, memberships, role changes, keys, revocation,
      project access, custom auth paths, and CORS using an isolated auth database.
- [x] Add credential support to React transport and event requests; exercise cookies
      through the HTTP transport and stream paths.
- [x] Document setup and verify focused tests, the repository suite, type checking,
      lint, package build, and an HTTP smoke test.

## Review focus

Cross-organization project requests return 404 even for administrators. Revoked
memberships/keys stop authorizing requests. Keys without explicit graph permissions
cannot read or write. An invalid explicit credential never falls back to another
credential. Graphx registry initialization never creates identity tables.

## Verification

`bun run test`: 1,641 passed, 11 skipped, 0 failed on the default backend.
`bun run type-check`, `bun run lint`, and `bun run build` passed. Published consumer
types preserve additional plugins and user fields. An HTTP smoke test against a
server on an assigned port passed signup, organization/project creation, graph
write/read, API-key read, and session revocation. Independent review findings have
regression tests and were fixed before the final suite run.
