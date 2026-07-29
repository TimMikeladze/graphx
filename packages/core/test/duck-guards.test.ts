import { describe, expect, test } from 'bun:test';
import { bulkLoad } from '../src/bulk.ts';
import { applyConnPragmas } from '../src/db.ts';
import type { DbClient } from '../src/dialect.ts';
import type { GraphSchema } from '../src/graph.ts';

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

	// journey.ts and pattern.ts got real duckdb arms in T11 (verified against a live engine
	// in duck-queries.test.ts). bulk.ts did NOT: its version-row INSERTs target
	// `node_versions`/`edge_versions`, which duckdbSchema (T9) makes UNION ALL VIEWS over
	// nv_live/nv_history — DuckDB refuses INSERT into those. Splitting bulk rows across the
	// two tables by `validTo` is a real fix, but it is a write-path design decision (how a
	// bulk row's identity/`ver` lands in nv_live vs nv_history) that intersects the same
	// live/history split Task 9 flagged "CARRY TO TASK 15/16" and every other write path in
	// the codebase (Graph.addNode/addEdge/etc.) also needs — escalated rather than guessed at
	// in T11. This guard is pinned so removing it without a real fix reads as a regression.
	test('bulkLoad still throws on duckdb — the write-path split is not yet decided (escalated out of T11)', async () => {
		const c = fakeClient('duckdb');
		await expect(bulkLoad(c, {} as GraphSchema, [])).rejects.toThrow(/duckdb not implemented yet/);
	});
});
