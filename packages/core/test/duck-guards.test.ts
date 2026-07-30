import { describe, expect, test } from 'bun:test';
import { applyConnPragmas } from '../src/db.ts';
import type { DbClient } from '../src/dialect.ts';

/** A DbClient that records statements and never touches a real database. */
function fakeClient(dialect: 'libsql' | 'postgres' | 'duckdb'): DbClient & { seen: string[] } {
	const seen: string[] = [];
	return {
		dialect,
		seen,
		execute: async (stmt) => {
			seen.push(typeof stmt === 'string' ? stmt : stmt.sql);
			return { rows: [], rowsAffected: 0 };
		},
		batch: async () => [],
		transaction: async () => {
			throw new Error('unused');
		},
		executeMultiple: async () => {},
		close: () => {},
	};
}

describe('inline dialect guards', () => {
	test('applyConnPragmas issues PRAGMAs on libsql', async () => {
		const c = fakeClient('libsql');
		await applyConnPragmas(c);
		expect(c.seen).toEqual(['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000']);
	});

	test('applyConnPragmas is a no-op on postgres', async () => {
		const c = fakeClient('postgres');
		await applyConnPragmas(c);
		expect(c.seen).toEqual([]);
	});

	test('applyConnPragmas is a no-op on duckdb — it must not issue PRAGMAs', async () => {
		const c = fakeClient('duckdb');
		await applyConnPragmas(c);
		expect(c.seen).toEqual([]);
	});
});
