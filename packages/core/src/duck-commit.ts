import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FOREVER } from './db.ts';
import type { DbClient } from './dialect.ts';
import { SNAPSHOT_TABLES } from './duck-materialize.ts';
import type { FileCache } from './objstore/cache.ts';
import type { Manifest, TableRef } from './objstore/manifest.ts';
import type { SnapshotStore } from './objstore/snapshot.ts';

/**
 * Publishing a local DuckDB back to the snapshot chain.
 *
 * Only DIRTY tables are re-exported; everything else carries its file refs forward
 * unchanged. That is what keeps a commit proportional to what changed rather than to the
 * size of the graph.
 *
 * Every uploaded object is keyed by its content hash, which makes the upload half of a
 * commit idempotent: a retry, a duplicate, or a lost acknowledgement all converge on the
 * same key with the same bytes. Only the manifest PUT is a race, and it is settled by
 * create-if-absent.
 */

/**
 * The subset of {@link DbClient} the export path needs.
 *
 * Narrowed rather than taking a whole `DbClient` so a client that gates its public
 * `execute` behind a one-shot open can hand in an UNGATED facade of itself. Passing the
 * gated client from inside its own open/commit path would await a promise that only
 * resolves once that path finishes — the same class of self-deadlock the pool-reentrancy
 * fix in `duck-constraints.ts` was narrowed to avoid.
 */
export type ExportSource = Pick<DbClient, 'execute'>;

/**
 * Write one table to Parquet, upload it, and return its content key. Returns null for an
 * empty table so the manifest records absence rather than an empty file.
 */
export async function exportTable(
	client: ExportSource,
	table: string,
	cache: FileCache,
	tmpDir: string,
	where?: string,
	suffix?: string,
): Promise<string | null> {
	const filter = where ? ` WHERE ${where}` : '';
	const count = await client.execute(`SELECT count(*) AS n FROM ${table}${filter}`);
	if (Number(count.rows[0]?.n ?? 0) === 0) return null;
	const path = join(tmpDir, `${table}${suffix ? `.${suffix}` : ''}.parquet`);
	// zstd and a fixed row-group size so identical content yields identical bytes, which
	// is what makes the content hash stable across writers and runs.
	await client.execute(
		`COPY (SELECT * FROM ${table}${filter} ORDER BY ALL) TO '${path.replace(/'/g, "''")}'
		 (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880)`,
	);
	try {
		return await cache.putContent(new Uint8Array(await readFile(path)));
	} finally {
		await rm(path, { force: true });
	}
}

/**
 * Tables exported as two files — live rows and history rows — rather than one.
 *
 * This is where the live/history split lives. It was briefly a *local schema* split, with
 * `node_versions` as a view over two tables, and that broke every write path: DuckDB
 * rejects `INSERT` into a `UNION ALL` view while `graph.ts`, `bulk.ts`, and auth all write
 * to `node_versions` by name. As a storage layout it costs nothing and still buys what the
 * split was for — a reader that only needs current state fetches the live file alone, and
 * history partitions by close time for tiering.
 */
const SPLIT_TABLES: Record<string, string> = {
	node_versions: 'valid_to',
	edge_versions: 'valid_to',
};

/** The next manifest: dirty tables re-exported, clean tables carried forward. */
export async function buildManifest(
	client: ExportSource,
	base: Manifest | null,
	cache: FileCache,
	tmpDir: string,
	dirty: Set<string>,
): Promise<Manifest> {
	const tables: Record<string, TableRef> = {};
	for (const table of SNAPSHOT_TABLES) {
		const carried = base?.tables[table];
		if (!dirty.has(table) && carried) {
			tables[table] = carried;
			continue;
		}
		const splitOn = SPLIT_TABLES[table];
		if (splitOn) {
			// Live first, so a reader that wants only current state can take files[0].
			const live = await exportTable(
				client,
				table,
				cache,
				tmpDir,
				`${splitOn} = ${FOREVER}`,
				'live',
			);
			const history = await exportTable(
				client,
				table,
				cache,
				tmpDir,
				`${splitOn} <> ${FOREVER}`,
				'history',
			);
			const files = [live, history].filter((k): k is string => k !== null);
			if (files.length > 0) tables[table] = { files };
			continue;
		}
		const key = await exportTable(client, table, cache, tmpDir);
		if (key) tables[table] = { files: [key] };
	}
	const high = await client.execute(
		`SELECT
		   coalesce((SELECT max(ver) FROM node_versions), 0) AS nv,
		   coalesce((SELECT max(ver) FROM edge_versions), 0) AS ev,
		   coalesce((SELECT max(seq) FROM graph_outbox), 0) AS sq`,
	);
	const row = high.rows[0] ?? {};
	const dim = await client.execute(`SELECT value FROM graph_meta WHERE key = 'emb_dim'`);
	return {
		v: 1,
		snapshot: base === null ? 0 : base.snapshot + 1,
		parent: base === null ? null : base.snapshot,
		committedAt: Date.now(),
		embDim: Number(dim.rows[0]?.value ?? 768),
		schemaHash: base?.schemaHash ?? '',
		verHigh: Math.max(Number(row.nv ?? 0), Number(row.ev ?? 0)),
		seqHigh: Number(row.sq ?? 0),
		tables,
		indexes: base?.indexes ?? {},
	};
}

/**
 * Export, upload, and claim the next snapshot number. On a lost race the whole build
 * re-runs against the winner — including the exports, which is cheap because the uploads
 * deduplicate on content.
 */
export async function commitSnapshot(
	client: ExportSource,
	snapshots: SnapshotStore,
	cache: FileCache,
	tmpDir: string,
	base: Manifest | null,
	dirty: Set<string>,
): Promise<Manifest> {
	return snapshots.commit(base, (b) => buildManifest(client, b, cache, tmpDir, dirty));
}
