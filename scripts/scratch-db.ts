/**
 * Which database files are scratch — created by tests and dev tooling, never anything a person
 * keeps. Shared by `clean-db.ts` (the manual and pre-commit sweep) and `test-cleanup.ts` (the
 * per-run sweep `bun test` preloads), so both agree on what is safe to delete.
 */

/** Prefixes of databases created by tests/dev tooling — always safe to remove. */
export const SCRATCH_PREFIXES = [
	'ns_',
	'mcp_test_',
	'mcp_mount_',
	'iot_test_',
	'test_',
	'dev_01',
	'evt_',
	'openapi_',
	'emb_http_',
];

export const SUFFIXES = ['.db', '.db-wal', '.db-shm', '.duckdb', '.duckdb.wal'];

/** True for a scratch database file name (or its `.tmp` spill directory). */
export function isScratch(name: string, prefixes: readonly string[] = SCRATCH_PREFIXES): boolean {
	const base = name.endsWith('.tmp') ? name.slice(0, -'.tmp'.length) : name;
	return SUFFIXES.some((s) => base.endsWith(s)) && prefixes.some((p) => base.startsWith(p));
}
