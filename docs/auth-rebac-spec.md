# graphx-auth — Relationship-Based Access Control (ReBAC) on graphx

- **Status:** Draft design — 2026-06-12
- **Author:** Tim Mikeladze
- **Depends on:** `graphx-core` (Graph, pattern `match()`, temporal `asOf`, serve.ts, §19.2 governance)

## Summary

`graphx-auth` turns graphx into a self-hosted authorization engine in the Google
Zanzibar / OpenFGA mould. Applications store permission relationships ("tuples") and
ask graphx `check(object, relation, subject)`. Permissions _are_ graph edges; a check
is a reachability evaluation over a relationship-rewrite model.

graphx is a strong base: tuples map to edges, the rewrite model's recursive cases
(group nesting, folder hierarchy) ride the existing recursive pattern engine, and the
temporal valid-time on edges gives Zanzibar-style snapshot consistency ("who had
access as-of T") for free.

## Two permission layers — do not conflate

| Layer  | Module              | Governs                                                                                                 | Status            |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------- | ----------------- |
| **L1** | existing `authz.ts` | who may call the graphx API for a project — the _app's_ service credential. Coarse RBAC, control-plane. | exists, untouched |
| **L2** | new `graphx-auth`   | the ReBAC model the _app_ defines for _its own_ users/resources.                                        | this spec         |

The app authenticates to graphx (L1), then asks graphx ReBAC checks about its own
users and resources (L2). The app — never the end-user — calls `check`. Existing
tenant/project isolation is unchanged.

> Naming: the existing L1 module stays `authz.ts`. The new L2 package is `graphx-auth`.
> No symbol collision — different package, different layer.

## Goals

- Full Zanzibar expressiveness: direct tuples, computed usersets, tuple-to-userset
  (hierarchical inheritance), and union / intersection / exclusion.
- APIs: `write` / `delete` tuples, `check`, `expand`, `listObjects`.
- Snapshot consistency via temporal `asOf`.
- Reuse graphx primitives (edges, recursive `match().rel()`, governance caps, serve
  spine) rather than reimplementing a store.

## Non-goals

- Replacing L1 control-plane RBAC.
- Exposing the ReBAC API directly to end-users (the app is the caller).
- A bespoke text DSL on day one — the model is defined in TypeScript (see below).

## Section 1 — Authorization model (DSL) + tuple→edge mapping

### Model

Per-project, versioned. Object types and their relations expressed as rewrite
expressions in TypeScript (consistent with graphx's zod-schema convention):

```typescript
const model = defineAuthModel({
	user: {}, // subject type, no relations
	group: {
		member: rel(), // direct: user, or group#member
	},
	folder: {
		parent: rel(),
		editor: rel(),
		viewer: rel().self().or('editor'), // editor ⇒ viewer
	},
	doc: {
		parent: rel(), // tupleset → folder
		editor: rel(),
		banned: rel(),
		viewer: rel()
			.self() // direct tuples
			.or('editor') // computed userset (same object)
			.or(tupleToUserset('parent', 'viewer')) // inherit folder.viewer (recursive)
			.minus('banned'), // exclusion
	},
});
```

Rewrite grammar (the userset rewrite tree):

| Form                                | Meaning                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `.self()`                           | `_this` — direct tuples on (object, relation)                         |
| `.or('editor')`                     | computed userset — same object, other relation                        |
| `tupleToUserset('parent','viewer')` | follow `parent` edges → those objects' `viewer` (recursive hierarchy) |
| `.or` / `.and` / `.minus`           | union / intersection / exclusion                                      |

The model compiles to a graphx schema for the auth namespace: object-types become
node `kind`s, relations become edge `rel`s. Tuple writes are validated against it.

### Tuple → edge mapping

A tuple `⟨object, relation, subject⟩`:

- **object & subject = nodes.** Node id = Zanzibar ref `type:localId`; `kind` = type.
  - `{id:'doc:42', kind:'doc'}`, `{id:'user:alice', kind:'user'}`, `{id:'group:eng', kind:'group'}`
- **relation = edge `rel`, direction `subject → object`.**
  - `doc:42#editor@user:alice` → edge `{rel:'editor', src:'user:alice', dst:'doc:42'}`
- **userset subject** `doc:42#viewer@group:eng#member` → edge
  `{rel:'viewer', src:'group:eng', dst:'doc:42', props:{subjectRelation:'member'}}`.
  The evaluator, hitting this edge, recurses into `check(group:eng, member, user)`.

Temporal falls out free: edges carry valid-time, so tuple writes / revokes are
time-stamped and `asOf` yields consistent historical checks.

## Section 2 — Check evaluator

`check(object, relation, subject, asOf?) → bool`. Recursive descent over the
relation's rewrite tree, memoized + cycle-guarded, all sub-queries pinned to one
`asOf` snapshot.

### Evaluation rules (per rewrite-node type)

| Node                   | Evaluate                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `self`                 | direct edge `subject→object` with `rel`? **OR** any userset edge `X→object` (`props.subjectRelation=r`) where `check(X, r, subject)` — recurse |
| `computed(r2)`         | `check(object, r2, subject)`                                                                                                                   |
| `ttu(tsRel, cRel)`     | for each parent `Y` in `Y --tsRel--> object` (reverse edges into object): `check(Y, cRel, subject)`                                            |
| `union`                | any child true                                                                                                                                 |
| `intersection`         | all children true                                                                                                                              |
| `exclusion(base, sub)` | `base` true **and** `sub` false                                                                                                                |

### Core loop

```typescript
async function check(g, model, object, relation, subject, ctx) {
	const key = `${object}#${relation}@${subject}`;
	if (ctx.memo.has(key)) return ctx.memo.get(key);
	if (ctx.stack.has(key)) return false; // cycle on this path → not granted
	ctx.stack.add(key);
	const expr = model.rewrite(typeOf(object), relation);
	const ok = await evalExpr(g, object, relation, subject, expr, ctx); // rules above
	ctx.stack.delete(key);
	ctx.memo.set(key, ok); // snapshot-stable within one check
	return ok;
}
```

### Fast path — where graphx earns its keep

Pure-reachability sub-expressions (self ∪ computed ∪ ttu over a _single_ relation, no
∩/−) collapse into a **single recursive `match().rel()` query** instead of N
app-level round-trips. Deep group nesting and folder-parent chains resolve in one hop.

- `check(group:eng, member, user:alice)` through nested groups → one
  `.rel('member', {maxDepth})` reachability query.
- Set-ops (∩, −) always stay in the evaluator — graphx cannot express exclusion
  cleanly in a single query (the reason this design is the recursive-evaluator
  approach, not pure SQL compilation).

### Safety rails

- **Memoization** — `(object, relation, subject)` cache per check; deep diamonds collapse.
- **Cycle guard** — visited-set on the recursion stack (app level); `.rel()` is already
  cycle-safe in-SQL.
- **Consistency** — whole check at one `asOf` → no new-enemy problem; pass a token for
  repeatable reads.
- **Governance** — §19.2 caps (maxRows / fan-out / timeout) bound every underlying query,
  plus an evaluator step/depth budget. A hostile-deep model cannot hang.

## Section 3 — APIs

### Engine surface

```typescript
class Auth {
	constructor(g: Graph, model: AuthModel) {}

	write(tuples: Tuple[]): Promise<void>; // add → g.addEdge (valid-time stamped)
	delete(tuples: Tuple[]): Promise<void>; // revoke → close valid-time

	check(object, relation, subject, opts?: { asOf?: number }): Promise<boolean>;
	expand(object, relation, opts?: { asOf?: number }): Promise<UsersetTree>;
	listObjects(
		subject,
		relation,
		type,
		opts?: { asOf?: number; limit?: number; cursor?: string },
	): Promise<Page<string>>;
}

type Tuple = {
	object: string; // 'doc:42'
	relation: string; // 'viewer'
	subject: string; // 'user:alice' | 'group:eng'
	subjectRelation?: string; // 'member' for userset subjects
};
```

### Model management

```typescript
defineAuthModel(spec): AuthModel               // in code
writeModel(g, model): Promise<modelId>         // persist, versioned via §15 schema evolution
```

Checks pin a model version (Zanzibar config consistency).

### listObjects (the hard reverse query)

Reverse-expand from the subject — gather candidate objects of `type` via reverse
traversal (`.in()` / direction-reverse + recursive `.rel()`), then **verify each
candidate with `check`** (the OpenFGA approach: guarantees correctness rather than
relying on a hand-derived reverse compilation of the rewrite rules). Keyset-paginated
like `neighborsPage` / pattern `.page()`, bounded by §19.2 caps.

## Section 4 — HTTP routes

Mount on the existing `serve.ts` Hono spine, guarded by existing L1 (`requireGraph`).
Reuses `zValidator` for bodies and `onError` for error mapping. The `hc<AppType>` typed
client extends automatically.

```
POST /t/:tenant/p/:project/auth/model         writeModel    (op: write)
POST /t/:tenant/p/:project/auth/tuples        write/delete  (op: write)
POST /t/:tenant/p/:project/auth/check         check         (op: read)
POST /t/:tenant/p/:project/auth/expand        expand        (op: read)
POST /t/:tenant/p/:project/auth/list-objects  listObjects   (op: read)
```

## Section 5 — Packaging + isolation

- New package **`graphx-auth`**, depends on `graphx-core`. Exports `defineAuthModel`,
  `rel`, `tupleToUserset`, `Auth`, and `mountAuth(app, cfg)` which adds the routes to a
  core Hono app.
- The auth graph (tuples + model) lives in a **dedicated companion namespace per
  project** (`${project}__auth`) — a separate libSQL DB with the same isolation
  guarantees. Keeps permission tuples physically apart from the app's domain graph: no
  kind/rel collision with the app's own schema, and the auth namespace runs the
  model-derived schema.
- L1 is unchanged: only the app's service credential for that project reaches its auth
  namespace. End-users never touch it.

## Section 6 — Testing

graphx convention: phase-named test files against `freshGraph()`.

1. **Evaluator units** — per rewrite node: self (direct + userset subject), computed
   (`editor⇒viewer`), ttu (multi-level folder→doc), ∪/∩/− (banned), cycles (A∈B∈A
   terminates), diamonds (memo correctness).
2. **Conformance suite** — port OpenFGA's standard test cases (model + tuples + check
   assertions, JSON → fixtures). Strongest correctness signal: proven semantics.
3. **Temporal** — write@t1, revoke@t2; `check asOf t1`=true, `asOf t2`=false;
   concurrent revoke + snapshot-pinned check (new-enemy).
4. **listObjects ↔ check parity** — `listObjects(subj,rel,type)` set ==
   `{o : check(o,rel,subj)}` over a sampled space; cursor-stable pagination.
5. **Governance** — deep/wide model hits §19.2 caps gracefully (bounded, no hang).
6. **HTTP/serve** — L1 guards (wrong tenant→404, viewer writing tuples→403), body
   validation, `hc` typed-client roundtrip.
7. **Property test** — random model + tuples: evaluator vs a brute-force fixpoint
   reference oracle must agree.

## Phasing

A full Zanzibar is too large for one implementation pass. Build in phases; the Check
API and serve routes land incrementally per phase.

| Phase  | Scope                                                                    |
| ------ | ------------------------------------------------------------------------ |
| **P1** | model definition + tuple write/read + direct-tuple `check` (`self`)      |
| **P2** | computed userset (`editor⇒viewer`) + group usersets (recursive `member`) |
| **P3** | tuple-to-userset hierarchy (recursive) + set-ops (∪ ∩ −)                 |
| **P4** | `expand(object, relation)`                                               |
| **P5** | `listObjects` (reverse-expand + verify)                                  |
| **P6** | consistency tokens (`asOf`) + subproblem cache for deep sets             |

## Open questions / risks

- **Model DSL ergonomics** — TS builder (`rel().self().or(...)`) vs a parsed text DSL
  (OpenFGA-style). Start with the TS builder; a text DSL can compile to it later.
- **listObjects fan-out** — reverse-expand on a wide graph can generate large candidate
  sets; the §19.2 cap + pagination bound it, but very broad relations may need a
  materialized reverse index (Leopard-style) beyond P5.
- **subjectRelation on edges** — encoding userset subjects in edge props is simple; if
  query ergonomics suffer, revisit as a dedicated rel naming scheme.
- **Model version pinning vs live edits** — define how an in-flight check behaves when
  the model is rewritten mid-request (pin to the version read at check start).
