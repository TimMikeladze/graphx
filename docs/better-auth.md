# Better Auth

```sh
bun add graphx better-auth @better-auth/api-key @better-auth/core @libsql/client
```

`graphx/better-auth` configures Better Auth's organization, admin, bearer, and API-key plugins.
Better Auth stores users, credentials, sessions, organizations, memberships, invitations,
teams, roles, admin accounts, and API keys. Graphx stores projects, project grants, and graph data. The
integration uses organization IDs as tenant IDs and does not copy identity records into
Graphx tables. Better Auth, its core package, and its API-key plugin are optional peers, required only for
this import.

## Configure authentication

Create `auth.ts`:

```ts
import { Database } from 'bun:sqlite';
import { createGraphxAuth } from 'graphx/better-auth';

export const auth = createGraphxAuth({
	database: new Database('./auth.db'),
	baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:8899',
	secret: process.env.BETTER_AUTH_SECRET,
	emailAndPassword: { enabled: true },
	trustedOrigins: ['http://localhost:3000'],
});
```

Set `BETTER_AUTH_SECRET` to a generated secret with at least 32 characters. Apply the
Better Auth schema with its [CLI](https://better-auth.com/docs/concepts/cli):

```sh
bunx --bun auth@latest migrate --config ./auth.ts
```

Database setup, password hashing, login providers, verification emails, password reset,
session rotation, and identity migrations use Better Auth. The first argument accepts
Better Auth options, including its PostgreSQL and ORM adapters. Additional plugins such
as two-factor auth go in `plugins`. Configure the included plugins through the second
argument; do not register them again:

```ts
const auth = createGraphxAuth(options, {
	organization: { sendInvitationEmail: async (invitation) => sendInvitation(invitation) },
	admin: { adminUserIds: ['your-admin-user-id'] },
	apiKey: { rateLimit: { enabled: true, maxRequests: 100, timeWindow: 60_000 } },
});
```

The invitation callback supplies your mail delivery. The admin plugin handles global user
administration. Organization admins do not automatically become global admins. Teams
and dynamic organization roles are enabled by the preset.

## Serve graph projects

Create `server.ts` alongside `auth.ts` and your graph schema:

```ts
import { createClient } from '@libsql/client';
import { createBetterAuthApp } from 'graphx/better-auth';
import { auth } from './auth.ts';
import { schema } from './schema.ts';

const control = createClient({ url: 'file:./graphx-registry.db' });
const app = await createBetterAuthApp({ auth, control, schema });

Bun.serve({ port: Number(process.env.PORT ?? 8899), fetch: app.fetch });
```

```sh
NODE_ENV=development bun server.ts
```

Development mode trusts request origins for authentication and credentialed CORS, so
changing the frontend port does not require another auth configuration. Both helpers
also accept an explicit `development` option. In production, set `NODE_ENV=production`,
configure `baseURL` and `trustedOrigins`, and use cookies appropriate to your deployment.

The app mounts Better Auth at `/api/auth/*`, or at `basePath` from the auth options.
Graph routes remain `/t/:organizationId/p/:projectId/...`. Other Graphx serving options,
including embeddings, events, limits, GraphQL, and readiness, pass through to the graph
server. The legacy `/admin` identity CRUD app is not mounted.

## Sign in and create a project

Use Better Auth's React client:

```ts
import { createAuthClient } from 'better-auth/react';
import { adminClient, organizationClient } from 'better-auth/client/plugins';
import { apiKeyClient } from '@better-auth/api-key/client';

export const authClient = createAuthClient({
	baseURL: 'http://localhost:8899',
	plugins: [
		adminClient(),
		organizationClient({ teams: { enabled: true }, dynamicAccessControl: { enabled: true } }),
		apiKeyClient(),
	],
});

await authClient.signUp.email({
	name: 'Alice',
	email: 'alice@example.com',
	password: 'your-password',
});
const { data: org, error } = await authClient.organization.create({ name: 'Notes', slug: 'notes' });
if (error || !org) throw new Error(error?.message ?? 'Organization creation failed');

const response = await fetch(`http://localhost:8899/t/${org.id}/projects`, {
	method: 'POST',
	credentials: 'include',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ name: 'My notes' }),
});
if (!response.ok) throw new Error(`Project creation failed: ${response.status}`);
const { id: project } = await response.json();
```

`POST /t/:organizationId/projects` returns `{ id }` and requires `graph: manage`.
`GET /t/:organizationId/projects` lists the caller's projects and requires `graph: read`.
Graphx generates the database namespace; the browser never receives a database credential.

| Organization role | Graph permissions   |
| ----------------- | ------------------- |
| owner, admin      | read, write, manage |
| member            | read, write         |
| viewer            | read                |

Custom roles use Better Auth's dynamic access control with the `graph` resource and
`read`, `write`, and `manage` actions. Better Auth owns the role records and evaluates
session permissions. The URL determines the requested organization; switching active
organizations in another tab does not change which organization a request checks.

## Restrict project access

```ts
const app = await createBetterAuthApp({ auth, control, schema, projectAccess: true });
```

`projectAccess` defaults to `false`, preserving organization-wide graph access. When
it is enabled, users with organization `graph: manage` keep access to their projects.
Other members need a direct user grant or a grant to a team they currently belong to.
A reader grant allows reads; an editor grant allows reads and writes. Organization
permissions cap both roles, so a viewer with an editor grant still cannot write.
Global admin status does not bypass organization or project checks.

```ts
const base = `http://localhost:8899/t/${organizationId}/p/${projectId}`;
const response = await fetch(`${base}/access`, {
	method: 'POST',
	credentials: 'include',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ subjectType: 'team', subjectId: teamId, role: 'editor' }),
});
if (!response.ok) throw new Error(`Project grant failed: ${response.status}`);
const { grants } = await response.json();
```

Graphx stores only `project_grants(project_id, subject_type, subject_id, role)`.
Better Auth's adapter validates each user’s current organization membership and each
team’s organization. Requests check current organization permissions and team membership;
removing either membership takes effect on the next request. No identity tables are copied.
Project ownership and authorization run before opening the project database, including
GraphQL dispatch, searches, bulk operations, and feeds. Project lists omit inaccessible
projects and never expose database namespaces. Event streams reauthenticate and check
project access before each outbox poll; a failed check closes the connection.

| Route below `/t/:organizationId/p/:projectId` | Returns                   | Permission                   |
| --------------------------------------------- | ------------------------- | ---------------------------- |
| `GET /permissions`                            | `{ read, write, manage }` | Authenticated caller         |
| `GET /access`                                 | `{ grants }`              | Organization `graph: manage` |
| `POST /access`                                | `{ grants }`              | Organization `graph: manage` |
| `DELETE /access/:subjectType/:subjectId`      | `{ grants }`              | Organization `graph: manage` |

Each grant is `{ subjectType: 'user' | 'team', subjectId, role: 'reader' | 'editor' }`.
Posting the same subject updates its role. Delete revokes that subject’s grant and is
idempotent. Invalid subjects return 400; unauthenticated requests return 401; denied
access returns 403. Unknown projects and projects outside the URL organization return
404 before consulting grants. Cookie grant mutations require the same trusted origin
as graph writes. These routes are described in `/openapi.json`.

`GET /auth-config` is public and returns `{ mode: 'better-auth', basePath, projectAccess }`.
`basePath` reflects the configured Better Auth path. The admin uses this to select its
login flow and project controls.

## Connect React hooks

```tsx
<GraphProvider
	baseUrl="http://localhost:8899"
	tenant={org.id}
	project={project}
	credentials="include"
>
	<App />
</GraphProvider>
```

Mount this inside your `QueryClientProvider`. `credentials="include"` sends cookies on
graph requests, bootstrap requests, and event streams. Same-origin applications can
use the browser's default credential mode. Cookie-authenticated mutations require a
trusted `Origin` or `Referer`, checked by Better Auth's origin middleware. Server callers
using cookie headers must supply the trusted origin too, or use an API key.

## Use organization API keys

Issue keys through Better Auth. For example, from a server function after verifying
the caller's session:

```ts
const issued = await auth.api.createApiKey({
	body: {
		configId: 'graphx',
		organizationId,
		userId: session.user.id,
		name: 'Graph reader',
		permissions: { graph: ['read'] },
	},
});
```

Setting explicit key permissions is a server-only Better Auth operation. Owners and
organization admins have permission to manage organization keys; members and viewers
do not. Keys without graph permissions cannot access graph data. Use `graph: write`
for mutations and `graph: manage` for project creation.

With `projectAccess: true`, keys also require `project: [projectId]` for each project
they read, write, or manage, including the grant routes. For example:

```ts
permissions: { graph: ['read', 'write'], project: [projectId] }
```

A key with `graph: manage` still needs that project scope to manage its grants.
Creating a new project requires only the organization `graph: manage` scope.

```sh
curl -H "Authorization: Bearer $GRAPHX_API_KEY" \
  "http://localhost:8899/t/$ORGANIZATION_ID/p/$PROJECT_ID/nodes"
```

`x-api-key` is also accepted. Better Auth verifies expiration, revocation, and rate limits
once per request. An established event stream reads the live Better Auth key record
before each poll without consuming more quota. Disabled, expired, deleted, or newly
restricted keys stop authorizing the stream. This supports the preset’s database,
secondary-storage, custom-storage, and database-fallback configurations. Key streams
return 501 before streaming when the auth instance was not created by `createGraphxAuth`
or uses `customAPIKeyValidator`; session streams still work in those configurations.
Its access-control evaluator checks the key permissions. A key can
access only its own organization, and keys stop authorizing requests when that
organization is deleted. An invalid explicit key or bearer token cannot fall back to a
cookie session. Bearer session tokens are also supported through Better Auth's bearer plugin.

## Existing applications

Use a fresh project registry with this integration. Existing `initControl()` registries
include Graphx identity tables and a project foreign key to the legacy `tenants` table;
`createBetterAuthApp` does not rewrite that schema or migrate identities. Importing
existing projects requires mapping their tenant IDs to Better Auth organization IDs
in a new registry. Existing databases and graph data are not deleted.

The standalone `createApp({ authenticate })` and its control-plane APIs still work for
applications using another provider. `graphx/auth` remains the separate relationship
permission engine for resource-specific graph relationships; it is not automatically
applied to graph data routes by the Better Auth integration.
