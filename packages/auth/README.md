# @graphx/auth

Relationship-based access control (ReBAC) on [graphx](../core), in the Google Zanzibar / OpenFGA
mould. Permissions **are** graph edges: a tuple `⟨object, relation, subject⟩` is stored as an edge,
and `check` is a reachability evaluation over a relation-rewrite model.

Because tuples are ordinary graphx edges, they inherit the bitemporal store for free — every grant
and revocation is a version with `valid_from`/`valid_to`, so `check(..., { asOf })` answers _who
had access at time T_, which is Zanzibar's snapshot consistency without a zookie protocol.

## Two permission layers — do not conflate

| Layer  | Module                      | Governs                                                                                                         |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **L1** | `@graphx/core`'s `authz.ts` | who may call the graphx API for a project — the _app's_ service credential. Coarse RBAC over the control plane. |
| **L2** | **this package**            | the ReBAC model the _app_ defines over its own users and resources.                                             |

The app authenticates to graphx (L1), then asks graphx ReBAC questions about its own users and
resources (L2). The app — never the end user — calls `check`. Tenant/project isolation is unchanged.

See [`docs/auth-rebac-spec.md`](../../docs/auth-rebac-spec.md) for the full design.

## Install

```sh
bun add @graphx/auth @graphx/core
```

## Usage

Declare the model, hand it a `Graph`, then write tuples and ask questions.

```ts
import { Graph, getDb, init } from '@graphx/core';
import { Auth, defineAuthModel, rel, tupleToUserset } from '@graphx/auth';

const model = defineAuthModel({
	user: {},
	group: { member: rel() },
	folder: { viewer: rel() },
	doc: {
		parent: rel(),
		editor: rel(),
		// viewer = direct tuples ∪ editor ∪ (viewer on the parent folder)
		viewer: rel().or('editor').or(tupleToUserset('parent', 'viewer')),
	},
});

const db = getDb('acme__alpha');
await init(db, 768);
const auth = new Auth(new Graph(db, model.schema), model);

await auth.write([
	{ object: 'doc:42', relation: 'editor', subject: 'user:alice' },
	{ object: 'group:eng', relation: 'member', subject: 'user:bob' },
	// a userset subject — everyone who is `member` of `group:eng`
	{ object: 'doc:42', relation: 'viewer', subject: 'group:eng', subjectRelation: 'member' },
]);

await auth.check('doc:42', 'viewer', 'user:alice'); // true — editor ⊂ viewer
await auth.check('doc:42', 'viewer', 'user:bob'); // true — via group:eng#member
await auth.check('doc:42', 'viewer', 'user:carol'); // false
```

Refs are `type:id`, split on the **first** colon, so `doc:acme:42` is type `doc`, id `acme:42`.
`defineAuthModel` compiles the spec into a `GraphSchema` (`model.schema`) and validates every
same-type reference at definition time — a relation naming a relation that does not exist throws
there, not at check time.

### The rewrite language

`rel()` alone means _direct tuples only_ (Zanzibar's `self`). Chain operators to combine:

| Builder                              | Meaning                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `rel()`                              | direct tuples on `(object, relation)`                                                                                    |
| `.or(term)`                          | union — also holders of `term`                                                                                           |
| `.and(term)`                         | intersection — must ALSO satisfy `term`                                                                                  |
| `.minus(term)`                       | exclusion — must NOT satisfy `term`                                                                                      |
| `tupleToUserset(tupleset, computed)` | follow `tupleset` edges to parent objects, then evaluate `computed` on each — this is how folder/org hierarchies inherit |

A `term` is either a relation name on the same object (a computed userset) or a
`tupleToUserset(...)`. Operators compose with fixed precedence: `(self ∪ or) ∩ and − minus`.
Direct tuples are always a positive term — a relation that excludes its own direct grants is not
expressible, by design.

### Other operations

```ts
await auth.delete([{ object: 'doc:42', relation: 'editor', subject: 'user:alice' }]);

// Zanzibar Expand — the userset tree for (object, relation). Leaf usersets are
// references (`group:eng#member`), not recursively resolved.
await auth.expand('doc:42', 'viewer');

// Reverse index: which objects of a type does this subject hold a relation on?
// Candidates come from reachability and are confirmed with `check`, so results are exact.
// Keyset-paginated.
const page = await auth.listObjects('user:bob', 'viewer', 'doc', { limit: 50 });
// Keep paging until `nextCursor` is null — a page whose candidates were all ungranted
// comes back with `objects: []` AND a cursor, so an empty page is not the end.

// Every read takes `asOf` (epoch ms) for a point-in-time answer.
await auth.check('doc:42', 'viewer', 'user:bob', { asOf: Date.parse('2026-01-01') });
```

## Serving

`createAuthApp` mounts the four operations as a Hono sub-app. You supply L1 authentication and the
resolution from a request to the `Auth` engine it should run against — that is where tenant/project
→ namespace mapping and operator-level write gating live.

```ts
import { createAuthApp } from '@graphx/auth';
import { Hono } from 'hono';

const api = new Hono();
api.route(
	'/auth',
	createAuthApp({
		// L1: verify the caller. Throwing here is a 401.
		authenticate: (c) => verifyServiceCredential(c.req.header('authorization')),
		// Resolve the engine for this request and op. Throw an HTTPException for a precise
		// status; any other error is a 403.
		resolveAuth: (c, principal, op) => engineFor(principal, op),
	}),
);
```

| Route                | Op    | Body                                                                              |
| -------------------- | ----- | --------------------------------------------------------------------------------- |
| `POST /check`        | read  | `{ object, relation, subject, asOf? }` → `{ allowed }`                            |
| `POST /tuples`       | write | `{ writes: Tuple[], deletes: Tuple[] }`                                           |
| `POST /expand`       | read  | `{ object, relation, asOf? }` → `UsersetTree`                                     |
| `POST /list-objects` | read  | `{ subject, relation, type, asOf?, limit?, cursor? }` → `{ objects, nextCursor }` |

`resolveAuth` receives the op class (`'read'` / `'write'`), so a read-only credential can be
rejected before the handler runs.

## Storage

Tuples live in the graph as edges under the schema `defineAuthModel` compiles, so the natural
deployment is a **dedicated namespace** for authorization data (e.g. `${project}__auth`) rather
than mixing tuples into the application graph. Both libSQL and Postgres backends are supported —
the package writes portable SQL through core's dialect fragments and has no backend of its own.

## License

MIT
