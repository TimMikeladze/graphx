# Admin authentication and project access

Finish the Better Auth admin experience, then add optional project grants. Stop after
browser-verified signup/login, organization selection/creation, membership/invitation
and team management, and user/team reader/editor project grants. Per-node policies
remain deferred. Existing graph databases and legacy identities are not migrated.

## Authentication and admin

The default admin development API uses persistent Better Auth and project-registry
databases with names separate from the legacy control plane. Its seeded development
account owns the demo organizations. Better Auth remains the authority for users,
sessions, organizations, memberships, teams, invitations, and roles. Development
invitation links are printed locally; no email is sent without a configured sender.

The SPA discovers `GET /auth-config`, returning `{ mode: 'better-auth', basePath,
projectAccess }`. Missing discovery on legacy servers keeps their operator-token
workflow. A failed discovery request must show a retry state, not silently choose
the legacy realm. Better Auth mode uses cookie credentials and ignores stored
operator tokens. Login/signup and session expiration gate all protected routes.
Signing out clears cached graph data. Organization and project lists use Better
Auth and tenant-scoped Graphx routes. The admin page manages the selected
organization through Better Auth, rather than the legacy identity CRUD API.

## Project grants

`createBetterAuthApp({ projectAccess: true, ... })` enables restricted project access;
the default remains organization-wide for compatibility. Graphx stores only
`project_grants(project_id, subject_type, subject_id, role)`, with user/team subjects
and reader/editor roles. Subject membership/ownership comes from Better Auth.

Organization `graph: manage` users retain access to their organization's projects.
Other members need a direct grant or a grant through a currently joined team.
Organization read/write permissions remain an upper bound. Removed organization
members or team memberships stop authorizing immediately. Project ownership is
checked before grants and no global-admin bypass is added.

Organization API keys require both graph scopes and a `project: [projectId]` scope
when restricted access is enabled. API keys remain owned and verified by Better
Auth. There are no mirrored users, memberships, teams, or key tables.

Project authorization runs before opening a project database and applies to every
existing data route, including GraphQL dispatch, searches, bulk operations, and feeds.
Project listing excludes inaccessible projects. Read-only callers can browse;
write operations remain denied by the server.

## HTTP contract

- `GET /auth-config`: public discovery; custom Better Auth base paths are respected.
- `GET /t/:tenant/p/:project/permissions`: `{ read, write, manage }` for the caller.
- `GET /t/:tenant/p/:project/access`: manager-only `{ grants }`.
- `POST /t/:tenant/p/:project/access`: manager-only `{ subjectType: 'user'|'team',
subjectId, role: 'reader'|'editor' }`, upserts a grant after validating its subject.
- `DELETE /t/:tenant/p/:project/access/:subjectType/:subjectId`: manager-only revoke.

Unknown/cross-organization projects return 404, missing project access returns 403,
and authentication failures return 401. Cookie mutations keep the existing origin
checks. OpenAPI documents the added routes.

## Work and verification

- [x] Connect the admin client, login/session gate, organization UI, and persistent
      development API. Keep legacy example servers usable.
- [x] Implement and test project authorization and grant management, including
      direct/team grants, revocation, list filtering, keys, and cross-tenant denial.
- [x] Connect project access controls in the UI. Test transports and session handling;
      verify a reader cannot edit and that switching accounts clears cached data.
- [x] Run package builds, the repository tests, type checks, lint, and a browser flow
      against the running admin app. Record the stopping point and remaining limits.

## Verified stopping point

The repository suite passes 1,674 tests with 11 optional skips and no failures.
Graphx and admin builds, workspace type checks, root lint, and scoped admin lint
pass. The admin's full ESLint command reports the same 19 errors as the baseline;
these are existing hook/refresh findings outside this change.

Local Chrome verified login, signup, organization/project creation, invitation
acceptance, team creation/join/membership, a team reader grant, and logout/account
switching. Before the grant, the invited member's project list was empty and direct
access returned 403. With team access, the reader opened the explorer with
`{ read: true, write: false, manage: false }`; a write returned 403 and edit controls
were absent. The owner also loaded a populated demo graph. Restarting the API
preserved identities, organizations, projects, memberships, and grants.

Live streams recheck credentials and project access before every poll. Tests cover
session/grant/key revocation and key scope/expiry/enabled changes, while preserving
one quota charge per API-key stream request across supported storage backends.
API-key streams with custom validators or auth instances outside the preset return
501 before streaming; ordinary requests and session streams remain available.

Stop here: Better Auth owns identity and organization authority; Graphx stores
project metadata and user/team reader/editor grants. Per-node relationship policy
enforcement remains deferred until a concrete product requirement needs it.
