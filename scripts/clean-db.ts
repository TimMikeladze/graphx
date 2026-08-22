/**
 * Delete the scratch databases and DuckDB spill that test and dev runs leave behind.
 *
 * Two locations are swept. `.graphx-data/` (or `$GRAPHX_DATA_DIR`) is where everything lands
 * today — see `duckDataDir()` in `packages/core/src/duck-pool.ts`. The repo root is swept too
 * because runs from before that change resolved bare paths against the process cwd, so older
 * checkouts and worktrees still carry a strand there. Both are gitignored, which is exactly
 * why they grow to gigabytes unnoticed. `bun run clean:db` from the repo root.
 *
 * Named dev databases (`dev_admin*`) are KEPT by default: they hold seeded admin-UI state
 * someone may still be working against. `--all` removes those too.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { duckDataDir } from '../packages/core/src/duck-pool.ts';

/** Prefixes of databases created by tests/dev tooling — always safe to remove. */
const SCRATCH_PREFIXES = [
	'ns_',
	'mcp_test_',
	'mcp_mount_',
	'iot_test_',
	'test_',
	'dev_01',
	'evt_',
	'openapi_',
];
/** Named dev databases — removed only with `--all`. */
const NAMED_PREFIXES = ['dev_admin'];

const SUFFIXES = ['.db', '.db-wal', '.db-shm', '.duckdb', '.duckdb.wal'];

const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');
const prefixes = all ? [...SCRATCH_PREFIXES, ...NAMED_PREFIXES] : SCRATCH_PREFIXES;

let files = 0;
let bytes = 0;

/** Recursive size of a file or directory; 0 for anything that vanished mid-sweep. */
function sizeOf(path: string): number {
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(path);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.size;
	let total = 0;
	try {
		for (const name of readdirSync(path)) total += sizeOf(join(path, name));
	} catch {
		// Raced with a concurrent run removing it; the partial total is only for the report.
	}
	return total;
}

/** Remove `path`, counting it toward the report. Directories (spill, run dirs) included. */
function remove(path: string): void {
	const size = sizeOf(path);
	if (!dryRun) rmSync(path, { force: true, recursive: true });
	files += 1;
	bytes += size;
}

/** True while a process with this PID exists — `kill(pid, 0)` signals nothing, it only probes. */
function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function sweep(dir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // Directory does not exist — nothing stranded there.
	}
	for (const name of entries) {
		// `run_<pid>/` holds one test process's scratch. A live PID means a CONCURRENT suite
		// owns those files, so removing them would break a run in progress.
		if (name.startsWith('run_')) {
			const pid = Number(name.slice(4));
			if (Number.isInteger(pid) && !isRunning(pid)) remove(join(dir, name));
			continue;
		}
		// DuckDB spill directories sit beside their database as `<db>.tmp` and hold the
		// multi-gigabyte `duckdb_temp_storage_*.tmp` files a killed query leaves behind.
		const base = name.endsWith('.tmp') ? name.slice(0, -'.tmp'.length) : name;
		if (!SUFFIXES.some((s) => base.endsWith(s))) continue;
		if (!prefixes.some((p) => base.startsWith(p))) continue;
		remove(join(dir, name));
	}
}

const dataDir = duckDataDir();
sweep(dataDir);
// The pre-`duckDataDir()` strand, and `tmp/` — spill from `:memory:` databases, which have no
// database file to sit beside.
sweep(process.cwd());
if (!dryRun) rmSync(join(dataDir, 'tmp'), { force: true, recursive: true });

const mb = (bytes / 1024 / 1024).toFixed(1);
const verb = dryRun ? 'would remove' : 'removed';
console.log(
	`clean:db — ${verb} ${files} entr(ies), ${mb} MB${all ? '' : ' (dev_admin* kept; --all to include)'}`,
);
