import { duckdbSchema } from './dialect-sql.ts';
import type { DbClient } from './dialect.ts';
import type { FileCache } from './objstore/cache.ts';
import type { Manifest } from './objstore/manifest.ts';

/**
 * Loading a snapshot into a local DuckDB.
 *
 * The local database is a materialization of one immutable snapshot — never the source of
 * truth. That is what lets a reader treat it as disposable and a writer treat a commit as
 * "publish this materialization".
 *
 * Files load into real TABLES rather than views over `read_parquet`, for two reasons. The
 * writer must mutate them, and a view cannot be inserted into — DuckDB rejects INSERT
 * against a UNION ALL view, which is what broke the write path when the live/history
 * split lived in the local schema instead of the Parquet layout.
 */

/**
 * Every table a manifest can carry. Order matters in both directions: the load loop walks
 * it forward, so identity tables land before their referents; the drop loop walks it
 * reversed, so children drop before parents. A reorder has to satisfy both at once.
 */
export const SNAPSHOT_TABLES = [
	'node_identity',
	'edge_identity',
	'node_versions',
	'edge_versions',
	'graph_outbox',
	'node_analytics',
	'trigger_cursors',
	'trigger_dead_letters',
	'archival_state',
	'graph_meta',
] as const;

/**
 * Reader-side DuckDB settings.
 *
 * `NO_VALIDATION` is the one that matters: it takes a warm repeat query from one HEAD
 * request to zero requests and zero bytes. It is dangerous in general — it will serve
 * stale bytes when a URL's content changes — and it is sound here for exactly one reason:
 * every data object is content-addressed, so a key's bytes never change.
 */
export async function applyReaderSettings(client: DbClient): Promise<void> {
	await client.execute(`SET validate_external_file_cache = 'NO_VALIDATION'`);
	await client.execute('SET enable_http_metadata_cache = true');
	await client.execute('SET parquet_metadata_cache = true');
}

/** SQL-literal-safe path list for `read_parquet([...])`. */
function pathList(paths: string[]): string {
	return `[${paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ')}]`;
}

/**
 * Load `manifest` into `client`, replacing whatever was there. A null manifest yields an
 * empty schema — a brand-new namespace.
 */
export async function materialize(
	client: DbClient,
	manifest: Manifest | null,
	cache: FileCache,
): Promise<void> {
	const dim = manifest?.embDim ?? 768;
	// Drop first: materialize is a load, not a merge. A stale row surviving a snapshot
	// swap would be invisible corruption.
	for (const t of [...SNAPSHOT_TABLES].reverse()) {
		await client.execute(`DROP TABLE IF EXISTS ${t}`);
	}
	await client.executeMultiple(duckdbSchema(dim));
	await applyReaderSettings(client);
	if (manifest === null) return;

	for (const table of SNAPSHOT_TABLES) {
		const ref = manifest.tables[table];
		if (!ref || ref.files.length === 0) continue;
		const paths = await cache.resolve(ref.files);
		// Column-name matching rather than positional, so a manifest written by an older
		// build with fewer columns still loads. OR REPLACE, not a bare INSERT:
		// `duckdbSchema` seeds `graph_meta` with the `emb_dim` row, so a manifest that also
		// carries `graph_meta` — and every manifest does, since Task 12 keeps the
		// unique-prop and single-rel declarations there — collides on its primary key. The
		// snapshot is authoritative, so it wins.
		await client.execute(
			`INSERT OR REPLACE INTO ${table} BY NAME SELECT * FROM read_parquet(${pathList(paths)}, union_by_name = true)`,
		);
		if (ref.tombstones) {
			const [tomb] = await cache.resolve([ref.tombstones]);
			await client.execute(
				`DELETE FROM ${table} WHERE id IN (SELECT id FROM read_parquet('${tomb}'))`,
			);
		}
	}
	// graph_meta carries emb_dim; the manifest is authoritative, so restate it after load.
	await client.execute({
		sql: `INSERT INTO graph_meta (key, value) VALUES ('emb_dim', ?)
		      ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		args: [String(dim)],
	});
}
