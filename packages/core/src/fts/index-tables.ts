/**
 * The local shape of the full-text index, and the BM25 join that reads it.
 *
 * Four ordinary tables, materialized from Parquet like any other. Readers need no `fts`
 * extension, no `ATTACH`, and no `USE <catalog>` — the extension route forces all three, and
 * its `match_bm25` macro references `fts_main_<table>` unqualified, so it cannot be queried
 * across catalogs at all.
 */

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
