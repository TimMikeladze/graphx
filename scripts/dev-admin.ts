/**
 * Run the admin stack concurrently: a dev API + the Vite UI dev server (packages/admin). One
 * Ctrl-C tears BOTH down. `bun run dev:admin` from the repo root.
 *
 * The API defaults to the generated demo estate (scripts/admin-api.ts) on :8787. Pass a script
 * path and its port to point the same UI at a different graph instead — that is what the
 * `dev:pantheon` / `dev:skills` scripts do:
 *
 *   bun scripts/dev-admin.ts examples/pantheon-graph/server.ts 8788
 *
 * The API script is spawned with its own directory as the working directory, because each one
 * keeps its database files (and seed cache) beside itself.
 *
 * Teardown is robust: vite is spawned as a single process (its binary directly, NOT via a
 * `bun run dev` wrapper that would orphan it), and every shutdown signal SIGTERMs both children
 * then SIGKILLs any survivor — so no server is left holding a port after Ctrl-C.
 */
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const apiScript = resolve(root, process.argv[2] ?? 'scripts/admin-api.ts');
const apiPort = process.argv[3] ?? '8787';
const procs: Bun.Subprocess[] = [];

function run(cmd: string[], cwd: string): Bun.Subprocess {
	const p = Bun.spawn({ cmd, cwd, stdout: 'inherit', stderr: 'inherit', env: process.env });
	procs.push(p);
	return p;
}

let shuttingDown = false;
function shutdown(code = 0): void {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const p of procs) {
		try {
			p.kill('SIGTERM');
		} catch {
			// already gone
		}
	}
	// Escalate: SIGKILL anything that ignored SIGTERM (e.g. a dev server mid-startup).
	setTimeout(() => {
		for (const p of procs) {
			try {
				p.kill('SIGKILL');
			} catch {
				// already gone
			}
		}
		process.exit(code);
	}, 1200);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	process.on(sig, () => shutdown(0));
}

// Point the UI's dev proxy at whichever API this run started (an explicit override still wins).
process.env.VITE_API_TARGET ??= `http://localhost:${apiPort}`;

const api = run(['bun', apiScript], dirname(apiScript));
// Spawn vite's binary directly (not `bun run dev`) so killing this pid frees port 5173.
const ui = run([`${root}/node_modules/.bin/vite`], `${root}/packages/admin`);

// If either process exits on its own, bring the whole stack down.
void Promise.race([api.exited, ui.exited]).then(() => shutdown(0));
