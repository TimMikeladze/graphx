import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

/**
 * The published `graphx` bin has a `node` shebang, so `npx graphx` must work without Bun. This
 * drives the BUILT binary with Node — needs `bun run build` first, as CI does. Skipped when no
 * Node >= 22.18 (the first to strip types from `graphx.config.ts` unflagged) is on PATH.
 */
const BIN = join(import.meta.dir, '../../dist/cli.js');
const SDK = join(import.meta.dir, '../../dist/core/index.js');
const ZOD = fileURLToPath(import.meta.resolve('zod'));

const NOT_LIBSQL = (process.env.GRAPHX_TEST_DRIVER ?? 'libsql') !== 'libsql';
const nodeVersion = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '';
const [major = 0, minor = 0] = nodeVersion.replace(/^v/, '').split('.').map(Number);
const NO_NODE = !(major > 22 || (major === 22 && minor >= 18));

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => resolve(port));
		});
	});
}

test.skipIf(NO_NODE || NOT_LIBSQL)('built CLI: `graphx serve` runs under Node', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'graphx-node-cli-'));
	await writeFile(
		join(cwd, 'graphx.config.ts'),
		`import { defineGraphSchema, hashEmbed } from ${JSON.stringify(SDK)};
import { z } from ${JSON.stringify(ZOD)};
const schema = defineGraphSchema({ nodes: { note: z.object({ title: z.string() }) }, edges: {} });
export default { schema, embedder: hashEmbed(8), namespace: 'node_cli', db: { driver: 'libsql' } };
`,
	);
	const port = await freePort();
	const child = spawn('node', [BIN, 'serve', '-p', String(port)], { cwd, stdio: 'pipe' });
	let stderr = '';
	child.stderr.on('data', (d) => (stderr += d));
	try {
		let spec: { openapi?: string } | undefined;
		for (let i = 0; i < 60 && !spec; i++) {
			if (child.exitCode !== null) throw new Error(`serve exited: ${stderr}`);
			spec = await fetch(`http://localhost:${port}/openapi.json`)
				.then((r) => (r.ok ? r.json() : undefined))
				.catch(() => undefined);
			if (!spec) await new Promise((r) => setTimeout(r, 250));
		}
		expect(spec?.openapi).toBeString();
	} finally {
		child.kill('SIGKILL');
		await rm(cwd, { recursive: true, force: true });
	}
});
