import { describe, expect, test } from 'bun:test';
import type { Dialect } from '../src/dialect.ts';
import { assertNever } from '../src/dialect.ts';
import { epochIntType, jsonField, scalarMax } from '../src/dialect-sql.ts';

describe('dialect seam exhaustiveness', () => {
	test('duckdb is a member of the Dialect union', () => {
		const d: Dialect = 'duckdb';
		expect(d).toBe('duckdb');
	});

	test('libsql and postgres fragments are byte-stable', () => {
		expect(scalarMax('libsql', 'a', 'b')).toBe('MAX(a, b)');
		expect(scalarMax('postgres', 'a', 'b')).toBe('GREATEST(a, b)');
		expect(jsonField('libsql', 'data', 'k')).toBe("data ->> 'k'");
		expect(jsonField('postgres', 'data', 'k')).toBe("(data)::jsonb ->> 'k'");
		expect(epochIntType('libsql')).toBe('INTEGER');
		expect(epochIntType('postgres')).toBe('BIGINT');
	});

	test('an unimplemented duckdb fragment throws a named error', () => {
		expect(() => jsonField('duckdb', 'data', 'k')).toThrow(/jsonField\(duckdb\)/);
	});

	test('assertNever reports the offending value', () => {
		expect(() => assertNever('nope' as never, 'testCtx')).toThrow(/testCtx.*nope/);
	});
});
