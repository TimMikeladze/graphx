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
	'dev_',
	'evt_',
	'openapi_',
	'emb_http_',
	'acme__',
];

/** Named dev databases inside a scratch prefix — kept unless the caller opts in (`--all`). */
export const NAMED_PREFIXES = ['dev_admin'];

export const SUFFIXES = ['.db', '.db-wal', '.db-shm', '.duckdb', '.duckdb.wal'];

/** True for a scratch database file name (or its `.tmp` spill directory). */
export function isScratch(name: string, { includeNamed = false } = {}): boolean {
	const base = name.endsWith('.tmp') ? name.slice(0, -'.tmp'.length) : name;
	if (!SUFFIXES.some((s) => base.endsWith(s))) return false;
	if (!includeNamed && NAMED_PREFIXES.some((p) => base.startsWith(p))) return false;
	return SCRATCH_PREFIXES.some((p) => base.startsWith(p));
}
