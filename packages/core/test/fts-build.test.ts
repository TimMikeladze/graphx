import { describe, expect, test } from 'bun:test';
import { buildIndex } from '../src/fts/build.ts';

const rows = [
	{ ver: 1, body: 'graph database', live: true },
	{ ver: 2, body: 'graph graph query', live: true },
	{ ver: 3, body: 'unrelated', live: false },
];

describe('buildIndex', () => {
	test('counts term frequency per version', () => {
		const ix = buildIndex(rows);
		const t = ix.terms.find((x) => x.ver === 2 && x.term === 'graph');
		expect(t?.tf).toBe(2);
	});

	test('document frequency counts versions, not occurrences', () => {
		const ix = buildIndex(rows);
		// 'graph' appears 3 times total but in 2 documents.
		expect(ix.dict.find((d) => d.term === 'graph')?.df).toBe(2);
	});

	test('document length is the token count, including duplicates', () => {
		const ix = buildIndex(rows);
		expect(ix.docs.find((d) => d.ver === 2)?.len).toBe(3);
	});

	test('stats cover live and history together', () => {
		const ix = buildIndex(rows);
		// A per-scope avgdl would make the same document score differently depending on
		// whether the query was live-only, which is not a property anyone wants.
		expect(ix.stats.num_docs).toBe(3);
		expect(ix.stats.avgdl).toBeCloseTo((2 + 3 + 1) / 3, 10);
	});

	test('carries the live flag through, so the export can split the files', () => {
		const ix = buildIndex(rows);
		expect(ix.docs.find((d) => d.ver === 3)?.live).toBe(false);
		expect(ix.terms.filter((t) => !t.live).map((t) => t.term)).toEqual(['unrelated']);
	});

	test('skips a null body without counting it as a document', () => {
		const ix = buildIndex([{ ver: 9, body: null, live: true }, ...rows]);
		expect(ix.stats.num_docs).toBe(3);
		expect(ix.docs.some((d) => d.ver === 9)).toBe(false);
	});

	test('skips a body with no usable tokens', () => {
		const ix = buildIndex([{ ver: 9, body: '!!!', live: true }, ...rows]);
		expect(ix.stats.num_docs).toBe(3);
	});

	test('an empty corpus yields avgdl 0 rather than NaN', () => {
		// A division by zero here propagates NaN into every BM25 score, and NaN sorts
		// unpredictably rather than erroring — a silent wrong answer.
		const ix = buildIndex([]);
		expect(ix.stats).toEqual({ num_docs: 0, avgdl: 0 });
	});
});
