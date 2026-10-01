/**
 * Delete the scratch databases and DuckDB spill that test and dev runs leave behind.
 *
 * `bun test` already contains its own scratch (see `test-cleanup.ts`), and the pre-commit hook
 * runs this, so the repo stays clean without anyone thinking about it. This sweep catches the
 * rest: dev servers and scripts that open bare namespaces, runs that were killed, and strands
 * from before the per-run test directory existed. Every workspace (root, `packages/*`,
 * `examples/*`) is swept along with its `.graphx-data/`, plus `$GRAPHX_DATA_DIR` when set and
 * any `<tmp>/graphx-test-<pid>` left by a dead test run. All of it is gitignored, which is
 * exactly why it used to grow to gigabytes unnoticed. `bun run clean:db` from the repo root.
 *
 * Named dev databases (`dev_admin*`) are KEPT by default: they hold seeded admin-UI state
 * someone may still be working against. `--all` removes those too. Example demo databases
 * (`*_demo.db`) are never touched.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { duckDataDir } from '../packages/graphx/src/core/duck-pool.ts';
import { isScratch } from './scratch-db.ts';

const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');

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
		if (isScratch(name, { includeNamed: all })) remove(join(dir, name));
	}
}

const root = process.cwd();
/** The repo root and every workspace beneath it — anywhere a dev server or test may have run. */
const workspaces = [root];
for (const group of ['packages', 'examples']) {
	try {
		for (const name of readdirSync(join(root, group))) {
			const dir = join(root, group, name);
			if (statSync(dir).isDirectory()) workspaces.push(dir);
		}
	} catch {
		// No such group in this checkout.
	}
}
for (const dir of workspaces) {
	sweep(dir);
	sweep(join(dir, '.graphx-data'));
	// Spill from `:memory:` DuckDB databases, which have no database file to sit beside.
	if (!dryRun) rmSync(join(dir, '.graphx-data', 'tmp'), { force: true, recursive: true });
}
if (process.env.GRAPHX_DATA_DIR) sweep(duckDataDir());

// Per-run test directories (`test-cleanup.ts`) whose run died before removing its own.
for (const name of readdirSync(tmpdir())) {
	const pid = Number(name.startsWith('graphx-test-') ? name.slice('graphx-test-'.length) : NaN);
	if (Number.isInteger(pid) && !isRunning(pid)) remove(join(tmpdir(), name));
}

const mb = (bytes / 1024 / 1024).toFixed(1);
const verb = dryRun ? 'would remove' : 'removed';
console.log(
	`clean:db — ${verb} ${files} entr(ies), ${mb} MB${all ? '' : ' (dev_admin* kept; --all to include)'}`,
);
