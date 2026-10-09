import { type DbClient, dialectOf } from './dialect.ts';
import { LIVE_SQL } from './dialect-sql.ts';
import { declareDuckUniqueProp } from './duck-constraints.ts';
import type { GraphSchema } from './graph.ts';
import { ensureColumn } from './schema.ts';

/**
 * P14 — constraints (§19.5). Two declarative guards, both scoped to LIVE rows only
 * (`WHERE valid_to = FOREVER AND recorded_to = FOREVER`) so history (closed or superseded
 * versions) can never collide with itself:
 *
 *  - **Uniqueness** ({@link declareUniqueNodeProp}): a prop is made unique among the
 *    live versions of one type. On libSQL a VIRTUAL generated column extracting the
 *    prop + a partial UNIQUE index over it (type-scoped); the §4.1 `ensureColumn` guard
 *    was built for exactly this (it reads `table_xinfo`, which sees generated columns)
 *    so re-declaring is idempotent. On Postgres a partial UNIQUE expression index. On
 *    DuckDB neither is possible (no partial indexes, no index over a JSON extraction),
 *    so {@link declareDuckUniqueProp}/`assertUniqueProps` (duck-constraints.ts) enforce
 *    it in application code instead — exact, not best-effort, because the writer is
 *    serialized (see duck-constraints.ts's doc comment).
 *  - **Edge cardinality** ({@link declareSingleValuedRel}): a rel is single-valued —
 *    at most one live `(src, rel)` edge — via a partial UNIQUE index on
 *    `edge_versions(src)` filtered to that rel, on libSQL and Postgres.
 *    `Graph.addEdge` additionally closes any existing live `(src, rel)` in the same
 *    write (the conditional-close pattern) from the schema's `single: true` flag, so the
 *    normal path upserts (last write wins) while the index hard-guarantees the
 *    invariant under concurrency. {@link materializeConstraints} creates these from a
 *    schema's `single: true` rels. DuckDB gets no index (same partial-index gap); the
 *    conditional-close path alone upholds the invariant there, so the duckdb arm only
 *    records the declaration for durability.
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
 * Make `prop` unique among the LIVE versions of node `type` (§19.5). Adds a VIRTUAL
 * generated column `gp_<prop>` extracting `json_extract(data,'$.<prop>')` (shared
 * across types that name the same prop) and a partial UNIQUE index
 * `ux_<type.length>_<type>_<prop>` over it, scoped to live rows of that type (the type
 * length-prefix keeps distinct (type,prop) pairs from colliding into one index name).
 * NULLs (the prop absent) are distinct, so nodes lacking the prop never collide.
 * Idempotent.
 */
export async function declareUniqueNodeProp(
	client: DbClient,
	opts: { type: string; prop: string },
): Promise<void> {
	const type = safeIdent(opts.type, 'type');
	const prop = safeIdent(opts.prop, 'prop');
	// Length-prefix the type so distinct (type, prop) pairs can't collapse to the same
	// index name — `_`-joining alone is ambiguous (user_account+id vs user+account_id
	// both → ux_user_account_id), which would make the 2nd CREATE IF NOT EXISTS a silent
	// no-op and leave its uniqueness unenforced.
	const idx = `ux_${type.length}_${type}_${prop}`;
	const pred = `WHERE ${LIVE_SQL} AND type = ${sqlLiteral(type)}`;
	switch (dialectOf(client)) {
		case 'postgres':
			// Postgres has no VIRTUAL generated columns — use a partial UNIQUE EXPRESSION index
			// over `data::jsonb ->> 'prop'` directly. NULLs (prop absent) are distinct, so nodes
			// lacking the prop never collide, matching the libSQL generated-column behavior.
			await client.execute(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON node_versions ((data::jsonb ->> '${prop}')) ${pred}`,
			);
			return;
		case 'duckdb':
			await declareDuckUniqueProp(client, type, prop);
			return;
		default: {
			// libSQL: a VIRTUAL generated column `gp_<prop>` + a partial UNIQUE index over it.
			const col = `gp_${prop}`;
			await ensureColumn(
				client,
				'node_versions',
				col,
				`ALTER TABLE node_versions ADD COLUMN ${col} TEXT GENERATED ALWAYS AS (json_extract(data, '$.${prop}')) VIRTUAL`,
			);
			await client.execute(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON node_versions(${col}) ${pred}`,
			);
			return;
		}
	}
}

/**
 * Make `rel` single-valued (§19.5): a partial UNIQUE index on `edge_versions(src)`
 * over the live rows of that rel, so at most one live `(src, rel)` edge can exist.
 * Pairs with `Graph.addEdge`'s conditional-close for the upsert path. Idempotent.
 *
 * DuckDB has no partial indexes, and an unconditional `UNIQUE(src, rel)` would be
 * wrong — it would make every rel single-valued, not just the declared one. `addEdge`
 * decides which rels are single-valued from the in-memory `defineGraphSchema` output
 * (`def.single`), never from the database, so the duckdb arm only records the
 * declaration for durability across restarts, the way the index does on the other two
 * backends — nothing reads it back.
 *
 * This makes the duckdb arm's failure mode asymmetric with the other two: on libSQL and
 * Postgres, calling this WITHOUT also marking the rel `single: true` in the schema still
 * fails loudly the moment a second live `(src, rel)` edge is written, because the index
 * enforces it regardless of what `addEdge` believes. On DuckDB there is no index, so the
 * same mismatch enforces nothing — the declaration is silently inert unless the schema
 * agrees. Always declare via {@link materializeConstraints} (which derives both from the
 * same schema) rather than calling this directly, unless you have deliberately checked
 * the schema already marks the rel `single: true`.
 */
export async function declareSingleValuedRel(client: DbClient, rel: string): Promise<void> {
	const safe = safeIdent(rel, 'rel');
	if (dialectOf(client) === 'duckdb') {
		await client.execute({
			sql: `INSERT OR IGNORE INTO graph_meta (key, value) VALUES (?, ?)`,
			args: [`single_rel:${safe}`, '1'],
		});
		return;
	}
	await client.execute(
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_single_${safe} ON edge_versions(src) WHERE ${LIVE_SQL} AND rel = ${sqlLiteral(safe)}`,
	);
}

/**
 * Materialize every constraint a schema declares: a partial unique index for each rel
 * marked `single: true`. Call once after {@link init}. Node-prop uniqueness is declared
 * imperatively via {@link declareUniqueNodeProp} (it isn't expressible in the Zod node
 * schema). Idempotent.
 *
 * DEFERRED (§19.5 third bullet): required-relationship validation ("a node of type K
 * must have an outgoing R") is NOT implemented — it's a deferred-cardinality constraint
 * that can't be enforced at `addNode` time (the edges don't exist yet) without a
 * separate validation pass, and it has no P14 acceptance criterion. The endpoint
 * type + FK checks on `addEdge` are the write-path validation that IS in place.
 */
export async function materializeConstraints(client: DbClient, schema: GraphSchema): Promise<void> {
	for (const [rel, def] of Object.entries(schema.edges)) {
		if ((def as { single?: boolean } | undefined)?.single) {
			await declareSingleValuedRel(client, rel);
		}
	}
}

/** A declared constraint, independent of how a backend stores it. */
export type Constraint =
	| { kind: 'unique'; type: string; prop: string }
	| { kind: 'single'; rel: string };

/** Parse a libSQL/Postgres constraint index name (`ux_*`) back into its declaration. */
export function parseIndexName(name: string): Constraint | null {
	if (name.startsWith('ux_single_')) return { kind: 'single', rel: name.slice(10) };
	const m = /^ux_(\d+)_(.+)$/.exec(name);
	if (!m) return null;
	const n = Number(m[1]);
	const rest = m[2]!;
	if (rest[n] !== '_') return null;
	return { kind: 'unique', type: rest.slice(0, n), prop: rest.slice(n + 1) };
}
