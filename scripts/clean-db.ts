/**
 * Delete the scratch SQLite files test and dev runs leave at the repo root (they open databases
 * relative to the cwd, so a full `bun test` can strand thousands of them — gitignored, but they
 * still eat gigabytes). `bun run clean:db` from the repo root.
 *
 * Named dev databases (`dev_admin*.db`) are KEPT by default: they hold seeded admin-UI state
 * someone may still be working against. `--all` removes those too.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** Prefixes of databases created by tests/dev tooling — always safe to remove. */
const SCRATCH_PREFIXES = ['ns_', 'mcp_test_', 'mcp_mount_', 'iot_test_', 'test_', 'dev_01'];
/** Named dev databases — removed only with `--all`. */
const NAMED_PREFIXES = ['dev_admin'];

const SUFFIXES = ['.db', '.db-wal', '.db-shm', '.duckdb', '.duckdb.wal'];

const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');
const root = process.cwd();
const prefixes = all ? [...SCRATCH_PREFIXES, ...NAMED_PREFIXES] : SCRATCH_PREFIXES;

let files = 0;
let bytes = 0;

for (const name of readdirSync(root)) {
	if (!SUFFIXES.some((s) => name.endsWith(s))) continue;
	if (!prefixes.some((p) => name.startsWith(p))) continue;
	const path = join(root, name);
	// A file can vanish between readdir and stat (a concurrent test run closing out) — size is only
	// for the report, so skip it rather than fail the whole sweep.
	try {
		bytes += statSync(path).size;
	} catch {
		continue;
	}
	if (!dryRun) rmSync(path, { force: true });
	files += 1;
}

const mb = (bytes / 1024 / 1024).toFixed(1);
const verb = dryRun ? 'would remove' : 'removed';
console.log(
	`clean:db — ${verb} ${files} file(s), ${mb} MB${all ? '' : ' (dev_admin* kept; --all to include)'}`,
);
