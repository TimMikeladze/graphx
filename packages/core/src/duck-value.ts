import type { SqlRow } from './dialect.ts';

/**
 * DuckDB returns every BIGINT as a JS `bigint`, even for small values, and graphx's
 * temporal columns (`valid_from`, `valid_to`, `ver`, `seq`) are all BIGINT because
 * DuckDB's INTEGER is 32-bit and the FOREVER sentinel (8.64e15) overflows it. Callers
 * compare these against plain numbers, so narrow them here — the same normalization
 * Postgres already needed for its bigint-as-string returns.
 *
 * Values beyond Number.MAX_SAFE_INTEGER stay `bigint`: silently rounding them would be
 * worse than a type surprise. FOREVER itself is 8.64e15, comfortably inside the safe
 * range (2^53-1 ≈ 9.007e15).
 */
export function normalizeRow(row: Record<string, unknown>): SqlRow {
	const out: SqlRow = {};
	for (const [k, v] of Object.entries(row)) {
		out[k] =
			typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
				? Number(v)
				: v;
	}
	return out;
}

/**
 * Bind an embedding as a JSON array string, to be parsed by `from_json(?, '["FLOAT"]')`
 * or cast with `?::FLOAT[dim]`.
 *
 * NOT `listValue(vec)`: that infers the list's element type from the FIRST element alone
 * via `Number.isInteger`, so a normalized vector whose first component is exactly 0.0 or
 * 1.0 becomes INTEGER[] and every fractional component truncates to 0 — no error, just
 * destroyed data. The JSON path is structurally immune because DuckDB parses the whole
 * list, and it is bit-exact: JSON.stringify prints the shortest double that re-parses,
 * and re-narrowing to float32 recovers the original bits.
 */
export function embParam(vec: number[] | Float32Array): string {
	return JSON.stringify(Array.from(vec));
}
