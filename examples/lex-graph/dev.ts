/**
 * Run Podcast Atlas: the API (`server.ts`) and the app's Vite dev server (`web/`), one Ctrl-C for both.
 *
 *   bun run dev              # from this directory
 *   bun run dev:lex          # from the repo root
 *
 * Ports default to 8790 (API) and 5180 (app). A taken port means another app is running there, and
 * it is left alone: each one moves to the next free port instead.
 */
import { join } from 'node:path';
import process from 'node:process';

/** The first port from `start` up that nothing is listening on. */
function freePort(start: number): number {
	// Vite listens on `localhost`, which is often only `::1`: a port is free when every address is.
	const free = (port: number) =>
		['0.0.0.0', '127.0.0.1', '::1'].every((hostname) => {
			try {
				Bun.serve({ port, hostname, fetch: () => new Response() }).stop(true);
				return true;
			} catch {
				return false;
			}
		});
	for (let port = start; port < start + 100; port++) if (free(port)) return port;
	throw new Error(`no free port in ${start}–${start + 99}`);
}

const apiPort = freePort(Number(process.env.PORT ?? 8790));
const webPort = freePort(Number(process.env.WEB_PORT ?? 5180));
const root = join(import.meta.dir, '..', '..');

const procs = [
	Bun.spawn({
		cmd: ['bun', 'run', 'server.ts'],
		cwd: import.meta.dir,
		env: { ...process.env, PORT: String(apiPort) },
		stdout: 'inherit',
		stderr: 'inherit',
	}),
	Bun.spawn({
		// Vite's binary directly, so killing this pid frees the port.
		cmd: [join(root, 'node_modules/.bin/vite'), '--port', String(webPort), '--strictPort'],
		cwd: join(import.meta.dir, 'web'),
		env: { ...process.env, VITE_API_TARGET: `http://localhost:${apiPort}` },
		stdout: 'inherit',
		stderr: 'inherit',
	}),
];
console.log(`[podcasts] Atlas on http://localhost:${webPort}  (API :${apiPort})`);

let down = false;
function shutdown(code = 0) {
	if (down) return;
	down = true;
	for (const p of procs) p.kill('SIGTERM');
	setTimeout(() => {
		for (const p of procs) p.kill('SIGKILL');
		process.exit(code);
	}, 1200);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => shutdown(0));
void Promise.race(procs.map((p) => p.exited)).then(() => shutdown(0));
