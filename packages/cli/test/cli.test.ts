import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { buildServeApp, parseIngestArgs, parseNewArgs, parseServeArgs, skipBreakdown } from '../src/cli.ts';

// The PG test leg sets GRAPHX_DB_DRIVER=postgres process-wide, which the dev `createApp` (via
// getDb with no DbConfig) would inherit — so the libSQL-file serve test is pinned to that leg.
const PG = process.env.GRAPHX_TEST_DRIVER === 'postgres';

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for parseIngestArgs
// ──────────────────────────────────────────────────────────────────────────────

test('parseIngestArgs: parses dir and defaults', () => {
	const args = parseIngestArgs(['ingest', '/some/dir']);
	expect(args.dir).toBe('/some/dir');
	expect(args.config).toBe('./graphx.config.ts');
	expect(args.source).toBeUndefined();
	expect(args.idField).toBeUndefined();
	expect(args.prune).toBe(false);
	expect(args.watch).toBe(false);
	expect(args.assetsType).toBeUndefined();
});

test('parseIngestArgs: parses --source', () => {
	const args = parseIngestArgs(['ingest', '/some/dir', '--source', 'my-vault']);
	expect(args.source).toBe('my-vault');
});

test('parseIngestArgs: parses --prune', () => {
	const args = parseIngestArgs(['ingest', '/some/dir', '--prune']);
	expect(args.prune).toBe(true);
});

test('parseIngestArgs: parses --watch short flag -w', () => {
	const args = parseIngestArgs(['ingest', '/some/dir', '--watch']);
	expect(args.watch).toBe(true);
});

test('parseIngestArgs: parses --config', () => {
	const args = parseIngestArgs(['ingest', '/some/dir', '--config', './my.config.ts']);
	expect(args.config).toBe('./my.config.ts');
});

test('parseIngestArgs: parses --id-field', () => {
	const args = parseIngestArgs(['ingest', '/some/dir', '--id-field', 'slug']);
	expect(args.idField).toBe('slug');
});

test('parseIngestArgs: parses --assets-type', () => {
	const args = parseIngestArgs(['ingest', '/some/dir', '--assets-type', 'asset']);
	expect(args.assetsType).toBe('asset');
});

test('parseIngestArgs: throws when dir is missing', () => {
	expect(() => parseIngestArgs(['ingest'])).toThrow('missing <dir>');
});

test('parseIngestArgs: parses combined flags', () => {
	const args = parseIngestArgs([
		'ingest',
		'/vault',
		'--source',
		'vault1',
		'--prune',
		'--watch',
		'--id-field',
		'slug',
		'--assets-type',
		'media',
	]);
	expect(args.dir).toBe('/vault');
	expect(args.source).toBe('vault1');
	expect(args.prune).toBe(true);
	expect(args.watch).toBe(true);
	expect(args.idField).toBe('slug');
	expect(args.assetsType).toBe('media');
});

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for parseServeArgs / parseNewArgs
// ──────────────────────────────────────────────────────────────────────────────

test('parseServeArgs: defaults', () => {
	const args = parseServeArgs(['serve']);
	expect(args.config).toBe('./graphx.config.ts');
	expect(args.port).toBe(8899);
});

test('parseServeArgs: parses --port and --config', () => {
	const args = parseServeArgs(['serve', '--port', '3000', '--config', './my.config.ts']);
	expect(args.port).toBe(3000);
	expect(args.config).toBe('./my.config.ts');
});

test('parseServeArgs: parses short flags -p/-c', () => {
	const args = parseServeArgs(['serve', '-p', '4000', '-c', './x.ts']);
	expect(args.port).toBe(4000);
	expect(args.config).toBe('./x.ts');
});

test('parseNewArgs: parses dir', () => {
	expect(parseNewArgs(['new', 'my-app']).dir).toBe('my-app');
});

test('parseNewArgs: throws when dir is missing', () => {
	expect(() => parseNewArgs(['new'])).toThrow('missing <dir>');
});

test('run: `new <dir>` scaffolds a runnable project', async () => {
	const base = await mkdtemp(join(tmpdir(), 'gx-new-'));
	const dir = join(base, 'app');
	try {
		const { run } = await import('../src/cli.ts');
		await run(['new', dir]);
		const config = await readFile(join(dir, 'graphx.config.ts'), 'utf8');
		expect(config).toContain('defineGraphSchema');
		expect(config).toContain('hashEmbed');
		const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
		expect(pkg.scripts.serve).toBe('graphx serve');
		// Deps pin the CLI's real version, not the misleading `latest`.
		expect(pkg.dependencies['@graphx/core']).not.toBe('latest');
		expect(pkg.dependencies['@graphx/core']).toMatch(/^\^\d/);
		expect(pkg.dependencies['@graphx/cli']).toMatch(/^\^\d/);
		expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('bun run serve');
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test('run: `new <dir>` refuses to overwrite an existing project', async () => {
	const base = await mkdtemp(join(tmpdir(), 'gx-new2-'));
	const dir = join(base, 'app');
	try {
		const { run } = await import('../src/cli.ts');
		await run(['new', dir]); // first scaffold succeeds
		await expect(run(['new', dir])).rejects.toThrow(/already exists/); // second refuses
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// buildServeApp is the testable core of `graphx serve` (loads config → builds the app, no listener).
test.skipIf(PG)('buildServeApp: loads a config and serves the seeded graph via /demo (libSQL)', async () => {
	const ns = `cli-serve-${Date.now()}`;
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(
		configPath,
		`import { defineGraphSchema, hashEmbed } from '../../core/src/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({ title: z.string().optional() }) }, edges: {} });
export default { schema, embed: hashEmbed(8), dim: 8, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);
	try {
		const { app, control, tenant, project, user } = await buildServeApp(configPath);
		expect(await (await app.request('/demo')).json()).toEqual({ tenant, project, user });
		const res = await app.request(`/t/${tenant}/p/${project}/nodes`);
		expect(res.status).toBe(200);
		control.close();
	} finally {
		await rm(configPath, { force: true });
		for (const sfx of ['', '-wal', '-shm']) await rm(`${ns}.db${sfx}`, { force: true });
	}
});

// buildServeApp bridges a postgres config through GRAPHX_DB_DRIVER/PG_URL env for the dev createApp,
// then MUST restore them — otherwise a later call / the rest of the process inherits the wrong
// backend. Uses a refused port so the build fails fast; the `finally` restore must still run.
test('buildServeApp: restores env after a postgres config even when the build fails (no leak)', async () => {
	const beforeDriver = process.env.GRAPHX_DB_DRIVER;
	const beforeUrl = process.env.GRAPHX_PG_URL;
	const ns = `cli-pgleak-${Date.now()}`;
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(
		configPath,
		`import { defineGraphSchema, hashEmbed } from '../../core/src/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({}).passthrough() }, edges: {} });
export default { schema, embed: hashEmbed(8), dim: 8, db: { driver: 'postgres', connectionString: 'postgresql://postgres:postgres@127.0.0.1:1/nope' }, namespace: '${ns}' };
`,
	);
	try {
		await expect(buildServeApp(configPath)).rejects.toThrow(); // connection refused
		expect(process.env.GRAPHX_DB_DRIVER).toBe(beforeDriver);
		expect(process.env.GRAPHX_PG_URL).toBe(beforeUrl);
	} finally {
		await rm(configPath, { force: true });
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for skipBreakdown
// ──────────────────────────────────────────────────────────────────────────────

test('skipBreakdown: groups skip entries by code with counts', () => {
	const out = skipBreakdown([
		{ key: 'a', stage: 'node', code: 'schema-reject', reason: 'x' },
		{ key: 'b', stage: 'node', code: 'schema-reject', reason: 'y' },
		{ key: 'c', stage: 'link', code: 'unresolved-link', reason: 'z' },
	]);
	expect(out).toContain('schema-reject=2');
	expect(out).toContain('unresolved-link=1');
});

test('skipBreakdown: empty for no skips', () => {
	expect(skipBreakdown([])).toBe('');
});

// ──────────────────────────────────────────────────────────────────────────────
// End-to-end: run() with a temp graphx.config.ts + vault dir (libSQL only)
// ──────────────────────────────────────────────────────────────────────────────

test('run: ingests a vault via a temp config file (libSQL)', async () => {
	// getDb keys libSQL on `file:<namespace>.db` (relative to CWD), so pick a unique namespace
	// and read that exact file back to verify. The config lives INSIDE the repo so its
	// `../../core/src` + `zod` imports resolve (a config under os.tmpdir() cannot reach them).
	const ns = `cli-e2e-${Date.now()}`;
	const dbFile = `${ns}.db`;
	const vaultDir = await mkdtemp(join(tmpdir(), 'gx-cli-vault-'));
	const configPath = join(import.meta.dir, `${ns}.config.ts`);

	await writeFile(join(vaultDir, 'note.md'), '---\ntype: note\ntitle: Hello\n---\nworld');
	await writeFile(
		configPath,
		`import { defineGraphSchema } from '../../core/src/define-graph-schema.ts';
import { z } from 'zod';
const schema = defineGraphSchema({
  nodes: { note: z.object({ title: z.string().optional() }).passthrough() },
  edges: { links_to: { from: 'note', to: 'note' } },
});
const embed = async () => [1, 0, 0, 0];
// Pin libSQL — the PG test leg sets GRAPHX_DB_DRIVER=postgres globally, which getDb would
// otherwise inherit (and then need core/pg). This e2e exercises the CLI wiring on libSQL.
export default { schema, embed, dim: 4, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);

	try {
		const { run } = await import('../src/cli.ts');
		// No try/catch: if run() throws (config import, backend wiring, ingest), the test FAILS.
		await run(['ingest', vaultDir, '--config', configPath]);

		// Open the libSQL file getDb wrote to and assert the one seeded note landed.
		const { createClient } = await import('@libsql/client');
		const client = createClient({ url: `file:${dbFile}` });
		const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
		expect(Number(rows.rows[0]!.c)).toBe(1);
		client.close();
	} finally {
		await rm(vaultDir, { recursive: true, force: true });
		await rm(configPath, { force: true });
		for (const sfx of ['', '-wal', '-shm']) await rm(`${dbFile}${sfx}`, { force: true });
	}
});

test('run: throws a clear error when the config omits dim', async () => {
	const ns = `cli-nodim-${Date.now()}`;
	const vaultDir = await mkdtemp(join(tmpdir(), 'gx-cli-vault-'));
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(join(vaultDir, 'note.md'), '---\ntype: note\n---\nhi');
	await writeFile(
		configPath,
		`import { defineGraphSchema } from '../../core/src/define-graph-schema.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({}).passthrough() }, edges: {} });
const embed = async () => [1, 0, 0, 0];
export default { schema, embed, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);
	try {
		const { run } = await import('../src/cli.ts');
		await expect(run(['ingest', vaultDir, '--config', configPath])).rejects.toThrow(/must set .?dim/);
	} finally {
		await rm(vaultDir, { recursive: true, force: true });
		await rm(configPath, { force: true });
		for (const sfx of ['', '-wal', '-shm']) await rm(`${ns}.db${sfx}`, { force: true });
	}
});
