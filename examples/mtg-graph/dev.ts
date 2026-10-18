import net from 'node:net';
const requested = Number(process.env.PORT ?? 8795);
let port = requested;
for (; port < requested + 100; port++) {
	const free = await new Promise<boolean>((resolve) => {
		const s = net.createServer();
		s.once('error', () => resolve(false));
		s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
	});
	if (free) break;
}
if (port === requested + 100) throw new Error('No available port');
const child = Bun.spawn(
	[
		'node',
		Bun.resolveSync('next/dist/bin/next', import.meta.dir),
		'dev',
		'--hostname',
		'127.0.0.1',
		'--port',
		String(port),
	],
	{
		cwd: import.meta.dir,
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env, PORT: String(port) },
	},
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
