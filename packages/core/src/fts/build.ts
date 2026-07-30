import { tokenize } from './tokenize.ts';

/**
 * Building the inverted index from `node_versions` rows.
 *
 * Pure and database-free: the arithmetic that decides every search ranking is testable
 * without a DuckDB instance, and the writer path holds no SQL of its own.
 *
 * The index is keyed on `ver`, not `id`. One node has many versions and each is indexed
 * separately, which is what makes as-of lexical search exact rather than best-effort — the
 * property `ftsSeedAsOf` relies on.
 */

/** One indexed document. `live` drives the Parquet file split, not the scoring. */
export interface FtsDoc {
  ver: number;
  len: number;
  live: boolean;
}

/** One (document, term) posting. */
export interface FtsTerm {
  ver: number;
  term: string;
  tf: number;
  live: boolean;
}

/** Corpus-wide document frequency for a term. */
export interface FtsDictEntry {
  term: string;
  df: number;
}

/** Corpus-wide BM25 normalizers. */
export interface FtsStats {
  num_docs: number;
  avgdl: number;
}

export interface FtsIndex {
  docs: FtsDoc[];
  terms: FtsTerm[];
  dict: FtsDictEntry[];
  stats: FtsStats;
}

/**
 * Build the four index tables from every version that has indexable text.
 *
 * `dict` and `stats` are computed over live and history TOGETHER. A per-scope `avgdl` would
 * make one document score differently depending on whether the caller asked for live-only or
 * as-of results, which is not a property any caller wants and would break the golden rankings
 * the moment history grew.
 */
export function buildIndex(
  rows: { ver: number; body: string | null; live: boolean }[],
): FtsIndex {
  const docs: FtsDoc[] = [];
  const terms: FtsTerm[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const row of rows) {
    if (row.body === null) continue;
    const tokens = tokenize(row.body);
    if (tokens.length === 0) continue; // nothing to match; not a document

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    docs.push({ ver: row.ver, len: tokens.length, live: row.live });
    totalLen += tokens.length;
    for (const [term, n] of tf) {
      terms.push({ ver: row.ver, term, tf: n, live: row.live });
      // Once per document, not once per occurrence — df counts documents.
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const dict = [...df.entries()]
    .map(([term, n]) => ({ term, df: n }))
    .sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

  return {
    docs,
    terms,
    dict,
    // Guard the empty corpus: 0/0 is NaN, and a NaN score sorts unpredictably instead of
    // erroring, so it would surface as a silently wrong ranking rather than a failure.
    stats: { num_docs: docs.length, avgdl: docs.length === 0 ? 0 : totalLen / docs.length },
  };
}
