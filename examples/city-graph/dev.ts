/**
 * One command for the whole app: the API on the first free port from 8899, then Vite on the
 * first free port from 5173, proxying to it. Nothing already running is stopped.
 *
 *   bun dev.ts
 */

import { freePort } from './server.ts';

const apiPort = await freePort(Number(process.env.PORT ?? 8899));
const api = Bun.spawn(['bun', 'server.ts'], {
	cwd: import.meta.dir,
	env: { ...process.env, PORT: String(apiPort) },
	stdout: 'inherit',
	stderr: 'inherit',
});
// Wait for the API to answer before starting the page.
for (let i = 0; i < 600; i++) {
	try {
		if ((await fetch(`http://localhost:${apiPort}/city/meta`)).ok) break;
	} catch {}
	await Bun.sleep(250);
}
const webPort = await freePort(Number(process.env.WEB_PORT ?? 5173));
const web = Bun.spawn(['bunx', 'vite', '--port', String(webPort), '--strictPort'], {
	cwd: import.meta.dir,
	env: { ...process.env, CITY_API: `http://localhost:${apiPort}` },
	stdout: 'inherit',
	stderr: 'inherit',
});
console.log(
	`\n  city-graph   http://localhost:${webPort}\n  API          http://localhost:${apiPort}/docs\n`,
);
const stop = () => {
	web.kill();
	api.kill();
	process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.race([api.exited, web.exited]);
stop();
