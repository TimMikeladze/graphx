/**
 * Preloaded by `bun test` (see bunfig.toml): every run gets its own scratch directory, and the
 * directory goes when the run does.
 *
 * libSQL opens a bare namespace as `<name>.db` in the process cwd, and DuckDB keeps its files in
 * `<cwd>/.graphx-data` — so tests that pass `db: 'ns_…'` used to strand hundreds of gitignored
 * files in the repo. Moving the cwd into `<tmp>/graphx-test-<pid>` contains all of them in one
 * place. Test modules resolve imports and fixtures from `import.meta.dir`, not the cwd, so
 * nothing else moves.
 *
 * Removal is layered: `afterAll` on a normal finish (passing or failing), `exit`/signal hooks for
 * Ctrl-C, and a start-of-run sweep for runs that were SIGKILLed — a dead PID's directory is
 * reclaimed by the next run. A live PID's directory belongs to a concurrent suite and is kept.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll } from 'bun:test';

const PREFIX = 'graphx-test-';
const RUN_DIR = join(tmpdir(), `${PREFIX}${process.pid}`);

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

for (const name of readdirSync(tmpdir())) {
	if (!name.startsWith(PREFIX)) continue;
	const pid = Number(name.slice(PREFIX.length));
	if (Number.isInteger(pid) && pid !== process.pid && !isRunning(pid)) {
		rmSync(join(tmpdir(), name), { force: true, recursive: true });
	}
}

mkdirSync(RUN_DIR, { recursive: true });
process.chdir(RUN_DIR);

let removed = false;
function removeRunDir(): void {
	if (removed) return;
	removed = true;
	try {
		rmSync(RUN_DIR, { force: true, recursive: true });
	} catch {
		// Best-effort; the next run's start-of-run sweep reclaims it.
	}
}

afterAll(removeRunDir);
process.once('exit', removeRunDir);
