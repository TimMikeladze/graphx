import { describe, expect, test } from 'bun:test';
import { ftsArg, sanitizeMatch } from '../src/hybrid.ts';

describe('ftsArg', () => {
	test('libsql gets the FTS5 expression sanitizeMatch already produced', () => {
		expect(ftsArg('libsql', 'graph db')).toBe(sanitizeMatch('graph db'));
	});

	test('postgres gets the raw query — tsQueryOr parses it itself', () => {
		expect(ftsArg('postgres', 'graph db')).toBe('graph db');
	});

	test('duckdb gets a JSON array of tokens', () => {
		expect(ftsArg('duckdb', 'Graph DB')).toBe('["graph","db"]');
	});

	test('every dialect returns null for a query with no usable tokens', () => {
		// The caller skips the lexical leg entirely on null; returning "[]" instead would run a
		// scoring join guaranteed to match nothing.
		for (const d of ['libsql', 'postgres', 'duckdb'] as const) {
			expect(ftsArg(d, '   ')).toBeNull();
			expect(ftsArg(d, '!!! ---')).toBeNull();
		}
	});

	test('duckdb survives hostile input that would be FTS5 syntax', () => {
		// Operators are not escaped, they are tokenized away — there is no grammar to inject into.
		expect(ftsArg('duckdb', 'a" OR b NEAR(c)')).toBe('["a","or","b","near","c"]');
	});
});
