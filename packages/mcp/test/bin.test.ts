import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';

/**
 * These drive the BUILT binary over stdio, because every finding this file covers survived a
 * source review and only showed up when the process was actually run. Needs `bun run build`
 * first — CI builds before it tests.
 */
const BIN = join(import.meta.dir, '../dist/bin.js');

/** A live `graphx-mcp` process, already through the MCP handshake. */
async function spawnBin(env: Record<string, string>, cwd: string) {
	const child = spawn('bun', [BIN], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let buf = '';
	let stderr = '';
	let exit: number | null = null;
	const pending = new Map<number, (m: any) => void>();
	child.stdout.on('data', (d) => {
		buf += String(d);
		let i: number;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (line) {
				const msg = JSON.parse(line);
				pending.get(msg.id)?.(msg);
			}
		}
	});
	child.stderr.on('data', (d) => {
		stderr += String(d);
	});
	child.on('exit', (code) => {
		exit = code;
	});

	let id = 0;
	const send = (method: string, params?: unknown) =>
		new Promise<any>((resolve, reject) => {
			const myId = ++id;
			pending.set(myId, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
			setTimeout(
				() => reject(new Error(`timeout on ${method} (exit=${exit}, stderr=${stderr})`)),
				15000,
			);
		});

	await send('initialize', {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'bin-test', version: '1.0.0' },
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	return {
		call: (name: string, args: Record<string, unknown>) =>
			send('tools/call', { name, arguments: args }).then((m) => m.result),
		list: () => send('tools/list').then((m) => m.result.tools as Array<{ name: string }>),
		stop: () => child.kill(),
	};
}

test('bin: graphx_context hands an agent the ids every other tool needs', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'gx-mcp-local-'));
	try {
		const bin = await spawnBin({ GRAPHX_MCP_MODE: 'local', GRAPHX_DB: 'mygraph' }, cwd);

		// The ids are minted fresh on every start and appear in no config, so this tool is the
		// only way an agent can learn them — there is no list_tenants to fall back to.
		const ctx = await bin.call('graphx_context', {});
		expect(ctx.isError).toBeFalsy();
		const { mode, tenant, project } = ctx.structuredContent;
		expect(mode).toBe('local');
		expect(tenant).toBeString();
		expect(project).toBeString();

		// The proof they are usable: a tool that would 404 on a guessed tenant.
		const projects = await bin.call('list_projects', { tenant });
		expect(projects.isError).toBeFalsy();
		expect(projects.structuredContent.projects.map((p: any) => p.id)).toContain(project);

		// GRAPHX_DB is a NAMESPACE: `mygraph` is the file `./mygraph.db`, not a URL.
		expect(await readdir(cwd)).toContain('mygraph.db');

		bin.stop();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}, 30000);

test('bin: remote mode touches no database, even from a read-only cwd', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'gx-mcp-remote-'));
	try {
		await Bun.$`chmod 555 ${cwd}`.quiet();
		const bin = await spawnBin(
			{ GRAPHX_MCP_MODE: 'remote', GRAPHX_URL: 'https://example.invalid' },
			cwd,
		);

		// Remote mode wants the app only for its route registry, so it must not bootstrap one:
		// the dev bootstrap runs a full init() and dies outright where it cannot write.
		const names = (await bin.list()).map((t) => t.name);
		expect(names).toContain('list_nodes');
		expect(names).toContain('graphx_context');

		const ctx = await bin.call('graphx_context', {});
		expect(ctx.structuredContent.mode).toBe('remote');
		expect(ctx.structuredContent.tenant).toBeNull();

		expect(await readdir(cwd)).toEqual([]);
		bin.stop();
	} finally {
		await Bun.$`chmod 755 ${cwd}`.quiet();
		await rm(cwd, { recursive: true, force: true });
	}
}, 30000);
