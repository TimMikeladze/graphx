import { declareSingleValuedRel, declareUniqueNodeProp, parseIndexName } from './constraints.ts';
import { type DbClient, dialectOf } from './dialect.ts';
import { LIVE_SQL } from './dialect-sql.ts';
import { FOREVER } from './runtime.ts';
import {
	ensureColumn,
	readSchemaVersion,
	sqliteEdgeVersionsTable,
	sqliteNodeVersionsTable,
} from './schema.ts';

/**
 * Schema v1 → v2: recorded time (docs/bitemporal.md §3).
 *
 * v2 adds `recorded_from` / `recorded_to` to both version tables, an index that allows one
 * live row per id, and views and constraint indexes that read only current beliefs. `init`
 * runs this BEFORE the v2 DDL on an existing namespace, so the DDL's new indexes and views
 * never meet v1 tables. Every part is idempotent: an interrupted upgrade, or an unstamped
 * namespace that is already v2, re-runs it harmlessly.
 */

const VERSION_TABLES = ['node_versions', 'edge_versions'] as const;
type VersionTable = (typeof VERSION_TABLES)[number];

/** Indexes v2 replaces with `nv_bitemporal` / `ev_*_bitemporal` (same leading columns). */
const V1_INDEXES = ['nv_asof', 'ev_src_asof', 'ev_dst_asof'];

/** `graph_meta` key recording how many rows the upgrade backfilled, for `graphx doctor`. */
export const META_RECORDED_BACKFILL = 'recorded_backfill';

/**
 * The upgrade found ids with more than one current open version — damage from the bulk-load
 * overlap bug fixed in phase 0. The one-live index cannot be built over them, so the upgrade
 * stops with the namespace still at v1 (the new columns are in place) until
 * {@link repairOverlaps} (`graphx doctor --repair-overlaps`) settles them.
 */
export class OverlapError extends Error {
	constructor(
		readonly nodes: string[],
		readonly edges: string[],
	) {
		const list = (ids: string[]) =>
			ids.slice(0, 10).join(', ') + (ids.length > 10 ? `, … (${ids.length} total)` : '');
		const parts = [
			nodes.length > 0 ? `nodes ${list(nodes)}` : '',
			edges.length > 0 ? `edges ${list(edges)}` : '',
		].filter(Boolean);
		super(
			`graphx: cannot upgrade to schema v2 — these ids have more than one open version: ${parts.join('; ')}. ` +
				'Run `graphx doctor --repair-overlaps` (or repairOverlaps) to keep the version written last.',
		);
		this.name = 'OverlapError';
	}
}

/** Add the two recorded-time columns where they are missing. Plain `ALTER`, every dialect. */
export async function addRecordedColumns(client: DbClient): Promise<void> {
	const d = dialectOf(client);
	const type = d === 'postgres' || d === 'duckdb' ? 'BIGINT' : 'INTEGER';
	for (const table of VERSION_TABLES) {
		for (const [col, dflt] of [
			['recorded_from', '0'],
			['recorded_to', String(FOREVER)],
		] as const) {
			// DuckDB cannot add a column with a constraint; the default still fills every row.
			const notNull = d === 'duckdb' ? '' : ' NOT NULL';
			const ddl = `ALTER TABLE ${table} ADD COLUMN ${col} ${type}${notNull} DEFAULT ${dflt}`;
			if (d === 'postgres') {
				await client.execute(ddl.replace('ADD COLUMN', 'ADD COLUMN IF NOT EXISTS'));
			} else {
				await ensureColumn(client, table, col, ddl);
			}
		}
	}
}

/** Ids with more than one current open version, per table, sorted. */
export async function findOverlaps(
	client: DbClient,
): Promise<{ nodes: string[]; edges: string[] }> {
	const dupes = async (table: VersionTable) =>
		(
			await client.execute(
				`SELECT id FROM ${table} WHERE ${LIVE_SQL} GROUP BY id HAVING COUNT(*) > 1 ORDER BY id`,
			)
		).rows.map((r) => String(r.id));
	return { nodes: await dupes('node_versions'), edges: await dupes('edge_versions') };
}

/**
 * Settle every id with more than one current open version: all but the highest `ver` (the
 * row written last, which is what `updateNode` and reads after it saw) stop being current
 * beliefs (`recorded_to = now`). Nothing is deleted. Works on a v1 namespace too — it adds the
 * columns first — so it can run before the upgrade that refused the damage.
 */
export async function repairOverlaps(
	client: DbClient,
	now: number = Date.now(),
): Promise<{ nodes: number; edges: number }> {
	if ((await readSchemaVersion(client)) === null) return { nodes: 0, edges: 0 }; // nothing stored yet
	await addRecordedColumns(client);
	const settle = async (table: VersionTable) =>
		(
			await client.execute({
				sql: `UPDATE ${table} SET recorded_to = ?
				      WHERE ${LIVE_SQL} AND ver < (
				        SELECT MAX(o.ver) FROM ${table} o
				        WHERE o.id = ${table}.id AND o.valid_to = ${FOREVER} AND o.recorded_to = ${FOREVER})`,
				args: [now],
			})
		).rowsAffected;
	return { nodes: await settle('node_versions'), edges: await settle('edge_versions') };
}

/** Constraint indexes (`ux_*`) on the version tables, by name. libSQL/SQLite and Postgres. */
async function constraintIndexNames(client: DbClient): Promise<string[]> {
	const sql =
		dialectOf(client) === 'postgres'
			? "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'ux!_%' ESCAPE '!'"
			: "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ux!_%' ESCAPE '!'";
	return (await client.execute(sql)).rows.map((r) => String(r.name));
}

/** Re-create constraint indexes from their names, which gives them the v2 live predicate. */
async function redeclareConstraints(client: DbClient, names: string[]): Promise<void> {
	for (const name of names) {
		const c = parseIndexName(name);
		if (!c) continue;
		if (c.kind === 'single') await declareSingleValuedRel(client, c.rel);
		else await declareUniqueNodeProp(client, { type: c.type, prop: c.prop });
	}
}

/** True when `table`'s stored definition already uses `AUTOINCREMENT`. */
async function hasAutoincrement(client: DbClient, table: VersionTable): Promise<boolean> {
	const r = await client.execute({
		sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
		args: [table],
	});
	return /AUTOINCREMENT/i.test(String(r.rows[0]?.sql ?? ''));
}

const NODE_COPY_COLS =
	'ver, id, type, body, uri, content_hash, content_type, data, valid_from, valid_to, recorded_from, recorded_to';
const EDGE_COPY_COLS =
	'ver, id, src, dst, rel, weight, data, source, valid_from, valid_to, recorded_from, recorded_to';

/**
 * SQLite/libSQL: rebuild the version tables with `AUTOINCREMENT` (a rowid table hands a purged
 * row's `ver` out again, and the change feed pages by `ver`). The copy keeps every `ver`, so
 * the external-content FTS index (keyed by `ver`) stays valid. The views, the FTS trigger and
 * the constraint indexes go with the old tables; the DDL after this step recreates the first
 * two, and the constraints are re-declared here. Generated `gp_*` columns are not copied —
 * re-declaring a unique prop adds its column back.
 */
async function rebuildSqliteTables(client: DbClient): Promise<void> {
	const rebuild: VersionTable[] = [];
	for (const table of VERSION_TABLES) {
		if (!(await hasAutoincrement(client, table))) rebuild.push(table);
	}
	if (rebuild.length === 0) return;
	const constraints = await constraintIndexNames(client);
	const stmts: string[] = ['DROP VIEW IF EXISTS nodes', 'DROP VIEW IF EXISTS edges'];
	for (const table of rebuild) {
		const next = `${table}_v2`;
		const cols = table === 'node_versions' ? NODE_COPY_COLS : EDGE_COPY_COLS;
		stmts.push(
			`DROP TABLE IF EXISTS ${next}`,
			table === 'node_versions' ? sqliteNodeVersionsTable(next) : sqliteEdgeVersionsTable(next),
			`INSERT INTO ${next} (${cols}) SELECT ${cols} FROM ${table}`,
			`DROP TABLE ${table}`,
			`ALTER TABLE ${next} RENAME TO ${table}`,
		);
	}
	await client.batch(
		stmts.map((sql) => ({ sql, args: [] })),
		'write',
	);
	await redeclareConstraints(client, constraints);
}

/**
 * The v1 → v2 structure step. Adds and backfills recorded time, rebuilds SQLite tables with
 * `AUTOINCREMENT`, gives constraint indexes the v2 predicate, and refuses a namespace with
 * overlapping open versions ({@link OverlapError}).
 */
export async function upgradeToRecordedTime(client: DbClient): Promise<void> {
	const d = dialectOf(client);
	await addRecordedColumns(client);

	// A v1 row's valid time was its write time — except a bulk-loaded row's, whose true load
	// time is unknown. `recorded_from = 0` is the column default, so the update is idempotent.
	let backfilled = 0;
	for (const table of VERSION_TABLES) {
		backfilled += (
			await client.execute(`UPDATE ${table} SET recorded_from = valid_from WHERE recorded_from = 0`)
		).rowsAffected;
	}
	if (backfilled > 0) {
		await client.execute({
			sql: 'INSERT INTO graph_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
			args: [META_RECORDED_BACKFILL, String(backfilled)],
		});
	}

	const overlaps = await findOverlaps(client);
	if (overlaps.nodes.length > 0 || overlaps.edges.length > 0) {
		throw new OverlapError(overlaps.nodes, overlaps.edges);
	}

	if (d === 'libsql' || d === 'sqlite') {
		await rebuildSqliteTables(client);
		return;
	}
	for (const idx of V1_INDEXES) await client.execute(`DROP INDEX IF EXISTS ${idx}`);
	if (d === 'postgres') {
		// Same names, new predicate: drop and re-declare. DuckDB has no constraint indexes.
		const constraints = await constraintIndexNames(client);
		for (const name of constraints) await client.execute(`DROP INDEX IF EXISTS ${name}`);
		await redeclareConstraints(client, constraints);
	}
}
