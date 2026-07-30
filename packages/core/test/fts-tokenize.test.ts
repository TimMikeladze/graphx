import { describe, expect, test } from 'bun:test';
import truth from './fixtures/fts-ground-truth.json';
import { tokenize } from '../src/fts/tokenize.ts';

describe('tokenize', () => {
  test('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Graph-Database, v2!')).toEqual(['graph', 'database', 'v2']);
  });

  test('keeps duplicates in document order — the caller counts them', () => {
    expect(tokenize('graph graph node')).toEqual(['graph', 'graph', 'node']);
  });

  test('yields nothing for text with no usable characters', () => {
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('!!! ??? ---')).toEqual([]);
  });

  test('does not stem — v1 matches libSQL unicode61, which does not either', () => {
    expect(tokenize('running runs')).toEqual(['running', 'runs']);
  });

  test('agrees with DuckDB on every document length in the ground truth', () => {
    // avgdl and len come straight from token counts, so a tokenizer that disagrees
    // silently shifts every BM25 score. This pins it against a measured reference.
    const lenByVer = new Map(truth.duckdb.docs.map((d) => [d.ver, d.len]));
    for (const doc of truth.corpus) {
      expect(tokenize(doc.body).length).toBe(lenByVer.get(doc.ver) as number);
    }
  });

  test('agrees with DuckDB on the exact vocabulary', () => {
    const ours = new Set(truth.corpus.flatMap((d) => tokenize(d.body)));
    const theirs = new Set(truth.duckdb.dict.map((d) => d.term));
    expect([...ours].sort()).toEqual([...theirs].sort());
  });
});
