/**
 * The snapshot manifest — the only mutable-by-appending thing in the bucket, and it is
 * mutable only in the sense that each commit writes a NEW numbered manifest. Every
 * manifest is immutable once written, which is what lets readers pin one and lets the
 * local file cache skip invalidation entirely.
 */

/** One logical table's physical files. `files` is a list so live can be base + deltas. */
export interface TableRef {
	/** Content-addressed object keys, e.g. `data/<sha256>.parquet`. Read as one relation. */
	files: string[];
	/** Optional key of a Parquet file of ids removed from `files` (live-table deletes). */
	tombstones?: string;
	/** Hive partition column for history tables, e.g. `vt_month`. */
	partition?: string;
}

export interface Manifest {
	v: 1;
	/** Monotonic snapshot number. The object key is derived from it, not stored beside it. */
	snapshot: number;
	parent: number | null;
	committedAt: number;
	/** Embedding width baked into `emb`. Read by `readEmbDim` instead of probing the catalog. */
	embDim: number;
	/**
	 * Covers the embedding dimension and every declared constraint. A writer whose in-memory
	 * schema hashes differently refuses to commit, which catches two application versions with
	 * different `defineGraphSchema` output writing to one bucket.
	 */
	schemaHash: string;
	/** Allocation high-water marks. The writer allocates from these, never from a live
	 *  sequence — DuckDB sequences are non-transactional, so an aborted commit would burn
	 *  values and reorder them, and `seq` order IS commit order in this design. */
	verHigh: number;
	seqHigh: number;
	tables: Record<string, TableRef>;
	/** `fts_live`, `fts_history`, `ann_live` → their component file lists. */
	indexes: Record<string, Record<string, string[]>>;
}

/** Where `_head` lives. A hint only — `resolveHead` probes forward past a stale value. */
export const HEAD_KEY = '_head';

/** Zero-padded so a lexicographic `list()` is also numeric order. */
export function snapshotKey(n: number): string {
	return `snapshots/${String(n).padStart(8, '0')}.json`;
}

export function serializeManifest(m: Manifest): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(m));
}

export function parseManifest(bytes: Uint8Array): Manifest {
	const m = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
	if (m.v !== 1) throw new Error(`manifest: unsupported version ${m.v}`);
	return m;
}

/** The starting point for a brand-new namespace: no tables, no indexes, nothing allocated. */
export function emptyManifest(embDim: number, schemaHash: string): Manifest {
	return {
		v: 1,
		snapshot: 0,
		parent: null,
		committedAt: 0,
		embDim,
		schemaHash,
		verHigh: 0,
		seqHigh: 0,
		tables: {},
		indexes: {},
	};
}
