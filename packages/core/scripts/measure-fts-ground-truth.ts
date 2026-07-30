import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { createDuckClient } from '../src/duck.ts';

/**
 * Regenerate test/fixtures/fts-ground-truth.json.
 *
 * Run by hand (`bun packages/core/scripts/measure-fts-ground-truth.ts`), never by CI: it
 * needs DuckDB's `fts` extension, which downloads on first use. The whole point of
 * committing the output is that the suite needs neither extension.
 */

const CORPUS = [
  { ver: 1, body: 'graph database with temporal edges' },
  { ver: 2, body: 'temporal graph query language' },
  { ver: 3, body: 'vector search over a graph' },
  { ver: 4, body: 'full text search with bm25 ranking' },
  { ver: 5, body: 'graph graph graph repeated term document' },
  { ver: 6, body: 'a document about storage and object storage' },
  { ver: 7, body: 'edges connect nodes in a graph database' },
  { ver: 8, body: 'nothing in common here' },
];

const QUERIES = ['graph', 'graph database', 'temporal search', 'storage', 'missing'];

async function duckdbTruth() {
  const c = createDuckClient();
  await c.execute('INSTALL fts');
  await c.execute('LOAD fts');
  await c.execute('CREATE TABLE docs (ver BIGINT, body VARCHAR)');
  for (const d of CORPUS) {
    await c.execute({ sql: 'INSERT INTO docs VALUES (?, ?)', args: [d.ver, d.body] });
  }
  // stemmer = 'none' isolates the arithmetic from the stemmer, matching our v1 tokenizer.
  // Named-parameter syntax must use `=`, not `:=`: on this DuckDB build (v1.5.5), `:=`
  // inside PRAGMA create_fts_index(...) is mis-parsed and DuckDB looks for a column
  // literally named "none" instead of treating it as the stemmer argument's value.
  await c.execute(`PRAGMA create_fts_index('docs', 'ver', 'body', stemmer = 'none')`);

  const rows = async (sql: string) => (await c.execute(sql)).rows;
  const dict = (await rows('SELECT term, df FROM fts_main_docs.dict ORDER BY term')).map((r) => ({
    term: String(r.term),
    df: Number(r.df),
  }));
  const docs = (await rows('SELECT docid, len FROM fts_main_docs.docs ORDER BY docid')).map((r) => ({
    docid: Number(r.docid),
    len: Number(r.len),
  }));
  const s = (await rows('SELECT num_docs, avgdl FROM fts_main_docs.stats'))[0];
  const stats = { num_docs: Number(s?.num_docs), avgdl: Number(s?.avgdl) };

  const bm25: Record<string, { ver: number; score: number }[]> = {};
  for (const q of QUERIES) {
    const r = await c.execute({
      sql: `SELECT ver, fts_main_docs.match_bm25(ver, ?) AS score
            FROM docs
            WHERE score IS NOT NULL
            ORDER BY score DESC, ver`,
      args: [q],
    });
    bm25[q] = r.rows.map((row) => ({ ver: Number(row.ver), score: Number(row.score) }));
  }
  await c.end();
  return { dict, docs, stats, bm25 };
}

async function libsqlTruth() {
  const c = createClient({ url: ':memory:' });
  await c.execute(`CREATE VIRTUAL TABLE d USING fts5(body)`);
  for (const doc of CORPUS) {
    await c.execute({ sql: 'INSERT INTO d(rowid, body) VALUES (?, ?)', args: [doc.ver, doc.body] });
  }
  const out: Record<string, number[]> = {};
  for (const q of QUERIES) {
    // The same OR-of-quoted-tokens shape sanitizeMatch produces.
    const match = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    const r = await c.execute({
      sql: `SELECT rowid FROM d WHERE d MATCH ? ORDER BY rank`,
      args: [match],
    });
    out[q] = r.rows.map((row) => Number(row.rowid));
  }
  return out;
}

const truth = { corpus: CORPUS, duckdb: await duckdbTruth(), libsql: await libsqlTruth() };
const path = join(import.meta.dir, '../test/fixtures/fts-ground-truth.json');
writeFileSync(path, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`wrote ${path}`);
