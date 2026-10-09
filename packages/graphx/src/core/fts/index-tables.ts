/**
 * The local shape of the full-text index, and the BM25 join that reads it.
 *
 * Four ordinary tables, materialized from Parquet like any other. Readers need no `fts`
 * extension, no `ATTACH`, and no `USE <catalog>` — the extension route forces all three, and
 * its `match_bm25` macro references `fts_main_<table>` unqualified, so it cannot be queried
 * across catalogs at all.
 */

import type { DbClient } from '../dialect.ts';
import { buildIndex } from './build.ts';
import { FOREVER } from '../runtime.ts';

/** Every table the index occupies. Load order is irrelevant — no foreign keys between them. */
export const FTS_TABLES = ['fts_dict', 'fts_docs', 'fts_terms', 'fts_stats'] as const;

/**
 * BM25 saturation and length-normalization constants. These are DuckDB's `match_bm25`
 * defaults, pinned by the ground-truth comparison in fts-bm25.test.ts rather than by faith.
 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * `live` is denormalized onto both `fts_docs` and `fts_terms` so a live-only query never
 * joins the two just to filter, and so the export can split each into live and history file
 * sets without a second pass.
 */
/**
 * `fts_stats` holds one row. Its primary key is a boolean pinned to `true` rather than an
 * aggregate over a query, so a stray second row fails loudly on insert instead of silently
 * doubling every score via `CROSS JOIN fts_stats` in bm25Cte.
 */
export const FTS_DDL = `
CREATE TABLE IF NOT EXISTS fts_dict (term VARCHAR PRIMARY KEY, df BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS fts_docs (ver BIGINT PRIMARY KEY, len BIGINT NOT NULL, live BOOLEAN NOT NULL);
CREATE TABLE IF NOT EXISTS fts_terms (ver BIGINT NOT NULL, term VARCHAR NOT NULL, tf BIGINT NOT NULL, live BOOLEAN NOT NULL);
CREATE INDEX IF NOT EXISTS fts_terms_term ON fts_terms(term);
CREATE TABLE IF NOT EXISTS fts_stats (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  num_docs BIGINT NOT NULL,
  avgdl DOUBLE NOT NULL
);
`;

/**
 * A `scored(ver, score)` CTE body. Consumes ONE bound arg: a JSON array of query terms.
 *
 * The terms arrive as JSON rather than as N placeholders because every caller binds
 * positionally from one code path shared with libSQL and Postgres, and those two spend
 * exactly one argument on the query. A variable placeholder count here would force every
 * caller to branch on dialect just to count arguments.
 *
 * `scope` picks the document set: `live` for current-time queries, `all` for as-of ones.
 * There is no separate as-of scope because there is nothing for it to do here — the index
 * covers every version, so restricting it by time is the caller's temporal predicate against
 * `node_versions`, applied outside this CTE.
 *
 * Any `LIMIT` on a query built from this CTE must stay OUTSIDE it, applied after the join
 * back to `node_versions`. The corpus signature (`duck.ts`'s `ftsCorpusSignature`) does not
 * track the index's `live` flags, so a stale flag can only over-produce rows here — the
 * outer temporal predicate and `LIMIT` are what keep that harmless. Limiting inside this CTE
 * would let a stale `live` flag silently drop rows the outer query should have seen.
 */
export function bm25Cte(scope: 'live' | 'all'): string {
	const liveFilter = scope === 'live' ? 'AND t.live AND d.live' : '';
	return `
  SELECT t.ver AS ver,
         sum(
           log(((s.num_docs - dc.df + 0.5) / (dc.df + 0.5)) + 1)
           * (t.tf * (${BM25_K1} + 1))
           / (t.tf + ${BM25_K1} * (1 - ${BM25_B} + ${BM25_B} * d.len / s.avgdl))
         ) AS score
  FROM (SELECT unnest(from_json(?, '["VARCHAR"]')) AS term) q
  JOIN fts_terms t ON t.term = q.term
  JOIN fts_dict dc ON dc.term = q.term
  JOIN fts_docs d ON d.ver = t.ver
  CROSS JOIN fts_stats s
  WHERE TRUE ${liveFilter}
  GROUP BY t.ver`;
}

/**
 * The subset of {@link DbClient} a rebuild needs: read access to `node_versions`, plus the
 * ability to open an interactive transaction to swap the index tables atomically. Narrowed
 * for the same reason as `duck-commit.ts`'s `ExportSource` — so a client that gates its
 * public methods behind a one-shot open can hand in an ungated facade of itself.
 */
export type IndexRebuildTarget = Pick<DbClient, 'execute' | 'transaction'>;

/**
 * Rebuild the whole index from the local `node_versions`.
 *
 * A full rebuild, not an incremental update. The index is a derived artifact republished on
 * every commit that touches `node_versions`, so an incremental path would buy nothing but a
 * second code path that can disagree with the first — and the disagreement would surface as
 * silently missing search results. When corpus size makes this cost real, the fix is a
 * per-file delta in the manifest (`TableRef.files` is already a list), not incremental
 * mutation of a local table.
 *
 * The swap itself — the four `DELETE FROM`s and the chunked inserts that follow — runs
 * inside ONE interactive transaction, committed here before this function returns (or rolled
 * back on error, leaving the previous index intact). This is deliberately owned by
 * `rebuildIndex` rather than by each caller: the bug this closes was exactly a caller
 * forgetting to wrap its own call, and there are two call sites (`duck.ts`'s freshness check
 * and `duck-commit.ts`'s commit-time rebuild) that would each need to remember it separately.
 * Readers never join the write chain, so without this a query could land between the
 * DELETEs and the INSERTs and see the index emptied — silently zero results, not an error.
 * DuckDB's MVCC keeps every write inside the transaction invisible to other connections
 * until it commits, so a concurrent reader sees either the full old index or the full new
 * one, never a partial one.
 */
export async function rebuildIndex(client: IndexRebuildTarget): Promise<void> {
	const r = await client.execute(
		`SELECT ver, body, valid_to, recorded_to FROM node_versions WHERE body IS NOT NULL`,
	);
	const ix = buildIndex(
		r.rows.map((row) => ({
			ver: Number(row.ver),
			body: row.body === null ? null : String(row.body),
			live: Number(row.valid_to) === FOREVER && Number(row.recorded_to) === FOREVER,
		})),
	);

	// Chunked multi-row inserts: a statement per posting is thousands of round trips on a
	// corpus of any size.
	const chunk = <T>(xs: T[], n: number): T[][] =>
		Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

	const tx = await client.transaction();
	try {
		for (const t of FTS_TABLES) await tx.execute(`DELETE FROM ${t}`);
		if (ix.docs.length === 0) {
			await tx.commit(); // nothing indexable; leave the tables empty
			return;
		}
		for (const part of chunk(ix.docs, 500)) {
			await tx.execute({
				sql: `INSERT INTO fts_docs (ver, len, live) VALUES ${part.map(() => '(?,?,?)').join(',')}`,
				args: part.flatMap((d) => [d.ver, d.len, d.live]),
			});
		}
		for (const part of chunk(ix.terms, 500)) {
			await tx.execute({
				sql: `INSERT INTO fts_terms (ver, term, tf, live) VALUES ${part.map(() => '(?,?,?,?)').join(',')}`,
				args: part.flatMap((t) => [t.ver, t.term, t.tf, t.live]),
			});
		}
		for (const part of chunk(ix.dict, 500)) {
			await tx.execute({
				sql: `INSERT INTO fts_dict (term, df) VALUES ${part.map(() => '(?,?)').join(',')}`,
				args: part.flatMap((d) => [d.term, d.df]),
			});
		}
		await tx.execute({
			sql: `INSERT INTO fts_stats (num_docs, avgdl) VALUES (?,?)`,
			args: [ix.stats.num_docs, ix.stats.avgdl],
		});
		await tx.commit();
	} catch (e) {
		await tx.rollback().catch(() => {});
		throw e;
	}
}
