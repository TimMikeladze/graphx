import { FOREVER } from './db.ts';
import type { DbClient } from './dialect.ts';

/**
 * Unique-prop enforcement for DuckDB.
 *
 * libSQL backs `declareUniqueNodeProp` with a partial unique index over a VIRTUAL
 * generated column; Postgres with a partial unique expression index. DuckDB can express
 * neither — it has no partial indexes at all, and no index over a JSON extraction whether
 * written directly or through a generated column (verified on 1.4.4 and 1.5.5). So the
 * check lives here.
 *
 * This is exact rather than best-effort because the writer is serialized: a single
 * in-process mutex owns all writes for a namespace (see graph.ts), so a read-then-write
 * check cannot be raced by another writer in the same process, and a writer in a
 * different process cannot commit without winning the manifest CAS. What it does NOT
 * cover is something writing to the bucket outside graphx — `graphx verify` exists for
 * that, and it is stage 7.
 */

const DECL_PREFIX = 'unique_prop:';

/** Reject anything that isn't a bare SQL identifier — `prop` is inlined into a JSON path. */
function safeIdent(s: string, what: string): string {
	if (!/^[A-Za-z0-9_]+$/.test(s)) {
		throw new Error(`duck-constraints: unsafe ${what} '${s}' (expected [A-Za-z0-9_]+)`);
	}
	return s;
}

/**
 * Record that (`type`, `prop`) must be unique across live nodes. Idempotent. Re-checks
 * the existing data so a declaration over already-duplicated rows fails loudly, the way
 * creating a unique index over duplicates would on the other backends.
 */
export async function declareDuckUniqueProp(
	client: DbClient,
	type: string,
	prop: string,
): Promise<void> {
	const safeProp = safeIdent(prop, 'prop');
	await client.execute({
		sql: `INSERT OR IGNORE INTO graph_meta (key, value) VALUES (?, ?)`,
		args: [`${DECL_PREFIX}${type}:${safeProp}`, '1'],
	});
	const dupes = await client.execute({
		sql: `SELECT json_extract_string(data, '$.${safeProp}') AS v, count(*) AS n
		      FROM node_versions
		      WHERE valid_to = ${FOREVER} AND type = ? AND json_extract_string(data, '$.${safeProp}') IS NOT NULL
		      GROUP BY 1 HAVING count(*) > 1 LIMIT 1`,
		args: [type],
	});
	if (dupes.rows.length > 0) {
		throw new Error(
			`constraint violation: cannot declare ${type}.${prop} unique — value ${JSON.stringify(dupes.rows[0]?.v)} already appears on ${dupes.rows[0]?.n} live nodes`,
		);
	}
}

/** Every prop declared unique for `type`. */
async function declaredProps(client: DbClient, type: string): Promise<string[]> {
	const prefix = `${DECL_PREFIX}${type}:`;
	const r = await client.execute({
		sql: `SELECT key FROM graph_meta WHERE key LIKE ?`,
		args: [`${prefix}%`],
	});
	return r.rows.map((row) => String(row.key).slice(prefix.length));
}

/**
 * Throw if writing `data` for a node of `type` would duplicate a declared-unique prop
 * among live rows. `excludeId` is the node being updated, whose own current row must not
 * count against it.
 */
export async function assertUniqueProps(
	client: DbClient,
	type: string,
	data: Record<string, unknown>,
	excludeId?: string,
): Promise<void> {
	for (const prop of await declaredProps(client, type)) {
		const value = data[prop];
		if (value === undefined || value === null) continue;
		const safeProp = safeIdent(prop, 'prop');
		const r = await client.execute({
			sql: `SELECT id FROM node_versions
			      WHERE type = ? AND valid_to = ${FOREVER} AND json_extract_string(data, '$.${safeProp}') = ?
			        ${excludeId ? 'AND id <> ?' : ''}
			      LIMIT 1`,
			args: excludeId ? [type, String(value), excludeId] : [type, String(value)],
		});
		if (r.rows.length > 0) {
			throw new Error(
				`constraint violation: ${type}.${prop} = ${JSON.stringify(value)} is already held by node ${r.rows[0]?.id}`,
			);
		}
	}
}
