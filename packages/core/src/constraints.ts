import { FOREVER } from './db.ts';
import { type DbClient, dialectOf } from './dialect.ts';
import type { GraphSchema } from './graph.ts';
import { ensureColumn } from './schema.ts';

/**
 * P14 — constraints (§19.5). Two declarative guards, both expressed as **partial
 * indexes over LIVE rows only** (`WHERE valid_to = FOREVER`) so the immutable history
 * (closed versions) can never collide with itself:
 *
 *  - **Uniqueness** ({@link declareUniqueNodeProp}): a prop is made unique among the
 *    live versions of one kind. Implemented as a VIRTUAL generated column extracting
 *    the prop + a partial UNIQUE index over it (kind-scoped). The §4.1 `ensureColumn`
 *    guard was built for exactly this (it reads `table_xinfo`, which sees generated
 *    columns) so re-declaring is idempotent.
 *  - **Edge cardinality** ({@link declareSingleValuedRel}): a rel is single-valued —
 *    at most one live `(src, rel)` edge — via a partial UNIQUE index on
 *    `edge_versions(src)` filtered to that rel. `Graph.addEdge` additionally closes any
 *    existing live `(src, rel)` in the same write (the conditional-close pattern), so
 *    the normal path upserts (last write wins) while the index hard-guarantees the
 *    invariant under concurrency. {@link materializeConstraints} creates these from a
 *    schema's `single: true` rels.
 *
 * Identifiers are inlined into DDL (SQLite can't bind them), so they are validated to a
 * safe `[A-Za-z0-9_]` charset to keep the surface injection-free.
 */

/** Reject anything that isn't a bare SQL identifier (DDL inlines these). */
function safeIdent(s: string, what: string): string {
	if (!/^[A-Za-z0-9_]+$/.test(s)) {
		throw new Error(`constraints: unsafe ${what} '${s}' (expected [A-Za-z0-9_]+)`);
	}
	return s;
}

/** A string literal safe to inline into DDL (single-quoted, doubling embedded quotes). */
function sqlLiteral(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Make `prop` unique among the LIVE versions of node `kind` (§19.5). Adds a VIRTUAL
 * generated column `gp_<prop>` extracting `json_extract(props,'$.<prop>')` (shared
 * across kinds that name the same prop) and a partial UNIQUE index
 * `ux_<kind.length>_<kind>_<prop>` over it, scoped to live rows of that kind (the kind
 * length-prefix keeps distinct (kind,prop) pairs from colliding into one index name).
 * NULLs (the prop absent) are distinct, so nodes lacking the prop never collide.
 * Idempotent.
 */
export async function declareUniqueNodeProp(
	client: DbClient,
	opts: { kind: string; prop: string },
): Promise<void> {
	const kind = safeIdent(opts.kind, 'kind');
	const prop = safeIdent(opts.prop, 'prop');
	// Length-prefix the kind so distinct (kind, prop) pairs can't collapse to the same
	// index name — `_`-joining alone is ambiguous (user_account+id vs user+account_id
	// both → ux_user_account_id), which would make the 2nd CREATE IF NOT EXISTS a silent
	// no-op and leave its uniqueness unenforced.
	const idx = `ux_${kind.length}_${kind}_${prop}`;
	const pred = `WHERE valid_to = ${FOREVER} AND kind = ${sqlLiteral(kind)}`;
	if (dialectOf(client) === 'postgres') {
		// Postgres has no VIRTUAL generated columns — use a partial UNIQUE EXPRESSION index
		// over `props::jsonb ->> 'prop'` directly. NULLs (prop absent) are distinct, so nodes
		// lacking the prop never collide, matching the libSQL generated-column behavior.
		await client.execute(
			`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON node_versions ((props::jsonb ->> '${prop}')) ${pred}`,
		);
		return;
	}
	// libSQL: a VIRTUAL generated column `gp_<prop>` + a partial UNIQUE index over it.
	const col = `gp_${prop}`;
	await ensureColumn(
		client,
		'node_versions',
		col,
		`ALTER TABLE node_versions ADD COLUMN ${col} TEXT GENERATED ALWAYS AS (json_extract(props, '$.${prop}')) VIRTUAL`,
	);
	await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON node_versions(${col}) ${pred}`);
}

/**
 * Make `rel` single-valued (§19.5): a partial UNIQUE index on `edge_versions(src)`
 * over the live rows of that rel, so at most one live `(src, rel)` edge can exist.
 * Pairs with `Graph.addEdge`'s conditional-close for the upsert path. Idempotent.
 */
export async function declareSingleValuedRel(client: DbClient, rel: string): Promise<void> {
	const safe = safeIdent(rel, 'rel');
	await client.execute(
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_single_${safe} ON edge_versions(src) WHERE valid_to = ${FOREVER} AND rel = ${sqlLiteral(safe)}`,
	);
}

/**
 * Materialize every constraint a schema declares: a partial unique index for each rel
 * marked `single: true`. Call once after {@link init}. Node-prop uniqueness is declared
 * imperatively via {@link declareUniqueNodeProp} (it isn't expressible in the Zod node
 * schema). Idempotent.
 *
 * DEFERRED (§19.5 third bullet): required-relationship validation ("a node of kind K
 * must have an outgoing R") is NOT implemented — it's a deferred-cardinality constraint
 * that can't be enforced at `addNode` time (the edges don't exist yet) without a
 * separate validation pass, and it has no P14 acceptance criterion. The endpoint
 * kind + FK checks on `addEdge` are the write-path validation that IS in place.
 */
export async function materializeConstraints(client: DbClient, schema: GraphSchema): Promise<void> {
	for (const [rel, def] of Object.entries(schema.edges)) {
		if ((def as { single?: boolean } | undefined)?.single) {
			await declareSingleValuedRel(client, rel);
		}
	}
}
