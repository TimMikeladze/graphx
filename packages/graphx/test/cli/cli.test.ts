import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, spyOn, test } from 'bun:test';
import {
	buildServeApp,
	parseForkArgs,
	parseIngestArgs,
	parseNewArgs,
	parseServeArgs,
	parseTriggersArgs,
	parseUpcastArgs,
	run,
	skipBreakdown,
} from '../../src/cli.ts';
import { loadConfig, openDb } from '../../src/cli-config.ts';
import { init } from '../../src/core/schema.ts';

// A non-libSQL test leg (postgres/duckdb) sets GRAPHX_DB_DRIVER process-wide, which the dev
// `createApp` (via getDb with no DbConfig) would inherit — so the libSQL-file serve test is
// pinned to the libSQL leg. An ALLOWLIST, not a postgres denylist: `=== 'postgres'` alone let
// this run (and blow up on "duck adapter is not registered") once a third driver existed.
const NOT_LIBSQL = (process.env.GRAPHX_TEST_DRIVER ?? 'libsql') !== 'libsql';

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
		const { run } = await import('../../src/cli.ts');
		await run(['new', dir]);
		const config = await readFile(join(dir, 'graphx.config.ts'), 'utf8');
		expect(config).toContain('defineGraphSchema');
		expect(config).toContain('hashEmbed');
		const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
		expect(pkg.scripts.serve).toBe('graphx serve');
		// The single `graphx` dep pins the CLI's real version, not the misleading `latest`.
		expect(pkg.dependencies.graphx).not.toBe('latest');
		expect(pkg.dependencies.graphx).toMatch(/^\^\d/);
		expect(config).toContain("from 'graphx'");
		expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('bun run serve');
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test('run: `new <dir>` refuses to overwrite an existing project', async () => {
	const base = await mkdtemp(join(tmpdir(), 'gx-new2-'));
	const dir = join(base, 'app');
	try {
		const { run } = await import('../../src/cli.ts');
		await run(['new', dir]); // first scaffold succeeds
		await expect(run(['new', dir])).rejects.toThrow(/already exists/); // second refuses
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// buildServeApp is the testable core of `graphx serve` (loads config → builds the app, no listener).
test.skipIf(NOT_LIBSQL)(
	'buildServeApp: loads a config and serves the seeded graph via /demo (libSQL)',
	async () => {
		const ns = `cli-serve-${Date.now()}`;
		const configPath = join(import.meta.dir, `${ns}.config.ts`);
		await writeFile(
			configPath,
			`import { defineGraphSchema, hashEmbed } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({ title: z.string().optional() }) }, edges: {} });
export default { schema, embedder: hashEmbed(8), db: { driver: 'libsql' }, namespace: '${ns}' };
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
	},
);

// The config's `rerank` reaches `/hybrid` — the path both `graphx serve` and `graphx mcp` take.
test.skipIf(NOT_LIBSQL)('buildServeApp: the config rerank orders /hybrid results', async () => {
	const ns = `cli-rerank-${Date.now()}`;
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(
		configPath,
		`import { defineGraphSchema, hashEmbed } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({ title: z.string() }) }, edges: {} });
// Reverses the fused order, so the test can tell it ran.
const rerank = async (_q, cs) => cs.map((c, i) => ({ id: c.id, score: i }));
export default { schema, embedder: hashEmbed(8), rerank, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);
	try {
		const { app, control, tenant, project, graph } = await buildServeApp(configPath);
		await graph.addNode({ type: 'note', data: { title: 'a' }, body: 'router gateway' });
		await graph.addNode({ type: 'note', data: { title: 'b' }, body: 'switch gateway' });
		const hybrid = async (body: unknown) =>
			(await (
				await app.request(`/t/${tenant}/p/${project}/hybrid`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			).json()) as Array<{ id: string }>;
		const rows = await hybrid({ query: 'gateway', k: 10, maxDepth: 0 });
		expect(rows).toHaveLength(2);
		const fused = await graph.hybridRetrieve({ query: 'gateway', k: 10, maxDepth: 0 });
		expect(rows.map((r) => r.id)).toEqual(fused.map((r) => r.id).reverse());
		control.close();
	} finally {
		await rm(configPath, { force: true });
		for (const sfx of ['', '-wal', '-shm']) await rm(`${ns}.db${sfx}`, { force: true });
	}
});

test('buildServeApp: a `rerank` or `guard` that is not a function is refused', async () => {
	const ns = `cli-badrerank-${Date.now()}`;
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(
		configPath,
		`import { defineGraphSchema } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({}) }, edges: {} });
export default { schema, rerank: { model: 'jev-latest' }, namespace: '${ns}' };
`,
	);
	try {
		await expect(buildServeApp(configPath)).rejects.toThrow(/`rerank` is not a function/);
		// A second file: a module import is cached by path, so rewriting the first would not reload.
		const guardPath = join(import.meta.dir, `${ns}-guard.config.ts`);
		await writeFile(
			guardPath,
			`import { defineGraphSchema } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({}) }, edges: {} });
export default { schema, guard: true, namespace: '${ns}-g' };
`,
		);
		try {
			await expect(buildServeApp(guardPath)).rejects.toThrow(/`guard` is not a function/);
		} finally {
			await rm(guardPath, { force: true });
		}
	} finally {
		await rm(configPath, { force: true });
	}
});

// buildServeApp opens the config's backend itself (cached under the namespace) rather than
// bridging it through process env, so a failing postgres config must leave the env untouched.
// Uses a refused port so the build fails fast.
test('buildServeApp: a postgres config that cannot connect fails without touching the env', async () => {
	const beforeDriver = process.env.GRAPHX_DB_DRIVER;
	const beforeUrl = process.env.GRAPHX_PG_URL;
	const ns = `cli-pgleak-${Date.now()}`;
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(
		configPath,
		`import { defineGraphSchema, hashEmbed } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({}).passthrough() }, edges: {} });
export default { schema, embedder: hashEmbed(8), db: { driver: 'postgres', connectionString: 'postgresql://postgres:postgres@127.0.0.1:1/nope' }, namespace: '${ns}' };
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
	// `../../src/core` + `zod` imports resolve (a config under os.tmpdir() cannot reach them).
	const ns = `cli-e2e-${Date.now()}`;
	const dbFile = `${ns}.db`;
	const vaultDir = await mkdtemp(join(tmpdir(), 'gx-cli-vault-'));
	const configPath = join(import.meta.dir, `${ns}.config.ts`);

	await writeFile(join(vaultDir, 'note.md'), '---\ntype: note\ntitle: Hello\n---\nworld');
	await writeFile(
		configPath,
		`import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { z } from 'zod';
const schema = defineGraphSchema({
  nodes: { note: z.object({ title: z.string().optional() }).passthrough() },
  edges: { links_to: { from: 'note', to: 'note' } },
});
import { defineEmbedder } from '../../src/core/embedder.ts';
const embedder = defineEmbedder({ id: 'stub', dim: 4, embed: async (texts) => texts.map(() => [1, 0, 0, 0]) });
// Pin libSQL — the PG test leg sets GRAPHX_DB_DRIVER=postgres globally, which getDb would
// otherwise inherit (and then need core/pg). This e2e exercises the CLI wiring on libSQL.
export default { schema, embedder, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);

	try {
		const { run } = await import('../../src/cli.ts');
		// No try/catch: if run() throws (config import, backend wiring, ingest), the test FAILS.
		await run(['ingest', vaultDir, '--config', configPath]);

		// Open the libSQL file getDb wrote to and assert the one seeded note landed.
		const { createClient } = await import('@libsql/client');
		const client = createClient({ url: `file:${dbFile}` });
		const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
		expect(Number(rows.rows[0]!.c)).toBe(1);
		// The graph embedded the note through the config's embedder.
		const vectors = await client.execute('SELECT COUNT(*) AS c FROM node_embeddings');
		expect(Number(vectors.rows[0]!.c)).toBe(1);
		client.close();
	} finally {
		await rm(vaultDir, { recursive: true, force: true });
		await rm(configPath, { force: true });
		for (const sfx of ['', '-wal', '-shm']) await rm(`${dbFile}${sfx}`, { force: true });
	}
});

test('run: a config still written for the old `embed` / `dim` keys is refused with the fix', async () => {
	const ns = `cli-oldcfg-${Date.now()}`;
	const vaultDir = await mkdtemp(join(tmpdir(), 'gx-cli-vault-'));
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(join(vaultDir, 'note.md'), '---\ntype: note\n---\nhi');
	await writeFile(
		configPath,
		`import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({}).passthrough() }, edges: {} });
const embed = async () => [1, 0, 0, 0];
export default { schema, embed, dim: 4, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);
	try {
		const { run } = await import('../../src/cli.ts');
		await expect(run(['ingest', vaultDir, '--config', configPath])).rejects.toThrow(
			/sets `embed`, which no longer exists — rename it to `embedder`/,
		);
	} finally {
		await rm(vaultDir, { recursive: true, force: true });
		await rm(configPath, { force: true });
		for (const sfx of ['', '-wal', '-shm']) await rm(`${ns}.db${sfx}`, { force: true });
	}
});

test('parseIngestArgs: --edge-field maps a frontmatter field to a rel', () => {
	const args = parseIngestArgs(['ingest', '/d', '--edge-field', 'author=authored_by']);
	expect(args.edgeFields).toEqual({ author: 'authored_by' });
});

test('parseIngestArgs: --edge-field is repeatable', () => {
	const args = parseIngestArgs([
		'ingest',
		'/d',
		'--edge-field',
		'author=authored_by',
		'--edge-field',
		'cites=cites',
	]);
	expect(args.edgeFields).toEqual({ author: 'authored_by', cites: 'cites' });
});

test('parseIngestArgs: --edge-field without an = is a clear error, not a silent drop', () => {
	expect(() => parseIngestArgs(['ingest', '/d', '--edge-field', 'author'])).toThrow(
		/--edge-field.*field=rel/,
	);
});

test('parseIngestArgs: --edge-field with an empty side is rejected', () => {
	expect(() => parseIngestArgs(['ingest', '/d', '--edge-field', '=rel'])).toThrow(/--edge-field/);
	expect(() => parseIngestArgs(['ingest', '/d', '--edge-field', 'field='])).toThrow(/--edge-field/);
});

test('parseIngestArgs: edgeFields is undefined when no --edge-field is given', () => {
	expect(parseIngestArgs(['ingest', '/d']).edgeFields).toBeUndefined();
});

test('parseIngestArgs: parses --dangling-type', () => {
	expect(parseIngestArgs(['ingest', '/d', '--dangling-type', 'stub']).danglingType).toBe('stub');
});

test('parseIngestArgs: parses --tags-type', () => {
	expect(parseIngestArgs(['ingest', '/d', '--tags-type', 'tag']).tagsType).toBe('tag');
	expect(parseIngestArgs(['ingest', '/d']).tagsType).toBeUndefined();
});

test('parseTriggersArgs: defaults the config path and honours -c', () => {
	expect(parseTriggersArgs(['triggers'])).toEqual({ config: './graphx.config.ts' });
	expect(parseTriggersArgs(['triggers', '-c', './other.config.ts'])).toEqual({
		config: './other.config.ts',
	});
	expect(parseTriggersArgs(['triggers', '--config', './x.ts'])).toEqual({ config: './x.ts' });
});

test('parseForkArgs: target namespace, ISO or epoch-ms --as-of', () => {
	expect(parseForkArgs(['fork', 'what-if'])).toEqual({
		config: './graphx.config.ts',
		target: 'what-if',
		asOf: undefined,
		recordedAsOf: undefined,
	});
	expect(parseForkArgs(['fork', 'b', '--recorded-as-of', '1700000000000']).recordedAsOf).toBe(
		1700000000000,
	);
	expect(parseForkArgs(['fork', 'b', '--as-of', '2026-09-30T00:00:00Z']).asOf).toBe(
		Date.parse('2026-09-30T00:00:00Z'),
	);
	expect(parseForkArgs(['fork', 'b', '--as-of', '1700000000000']).asOf).toBe(1700000000000);
	expect(() => parseForkArgs(['fork'])).toThrow('missing <namespace>');
	expect(() => parseForkArgs(['fork', 'b', '--as-of', 'soon'])).toThrow('--as-of');
	expect(() => parseForkArgs(['fork', 'b', '--recorded-as-of', 'soon'])).toThrow(
		'--recorded-as-of',
	);
});

test('run: fork branches the configured namespace into a new one (libSQL)', async () => {
	const ns = `cli-fork-${Date.now()}`;
	const branch = `${ns}-b`;
	const vaultDir = await mkdtemp(join(tmpdir(), 'gx-cli-vault-'));
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(join(vaultDir, 'note.md'), '---\ntype: note\ntitle: Hello\n---\nworld');
	await writeFile(
		configPath,
		`import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { defineEmbedder } from '../../src/core/embedder.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { note: z.object({ title: z.string().optional() }).passthrough() }, edges: {} });
const embedder = defineEmbedder({ id: 'stub', dim: 4, embed: async (texts) => texts.map(() => [1, 0, 0, 0]) });
export default { schema, embedder, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);
	try {
		const { run } = await import('../../src/cli.ts');
		await run(['ingest', vaultDir, '--config', configPath]);
		await run(['fork', branch, '--config', configPath]);
		const { createClient } = await import('@libsql/client');
		const client = createClient({ url: `file:${branch}.db` });
		expect(Number((await client.execute('SELECT COUNT(*) AS c FROM nodes')).rows[0]!.c)).toBe(1);
		expect(
			Number((await client.execute('SELECT COUNT(*) AS c FROM node_embeddings')).rows[0]!.c),
		).toBe(1);
		client.close();
		// A second fork into the now-populated branch is refused.
		await expect(run(['fork', branch, '--config', configPath])).rejects.toThrow('empty');
	} finally {
		const { closeAll } = await import('../../src/core/db.ts');
		closeAll();
		await rm(vaultDir, { recursive: true, force: true });
		await rm(configPath, { force: true });
		for (const db of [ns, branch])
			for (const sfx of ['', '-wal', '-shm']) await rm(`${db}.db${sfx}`, { force: true });
	}
});

test('parseUpcastArgs: defaults, --type and --dry-run', () => {
	expect(parseUpcastArgs(['upcast'])).toEqual({
		config: './graphx.config.ts',
		type: undefined,
		dryRun: false,
	});
	expect(parseUpcastArgs(['upcast', '--type', 'device', '--dry-run', '-c', 'x.ts'])).toEqual({
		config: 'x.ts',
		type: 'device',
		dryRun: true,
	});
});

test.skipIf(NOT_LIBSQL)('run: doctor reports lagging data and `upcast` rewrites it', async () => {
	const ns = `cli-upcast-${Date.now()}`;
	const configPath = join(import.meta.dir, `${ns}.config.ts`);
	await writeFile(
		configPath,
		`import { defineGraphSchema, defineUpcasters } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({
	nodes: { device: z.object({ name: z.string(), criticality: z.number() }) },
	edges: {},
});
const upcasters = defineUpcasters({
	device: { current: 2, steps: [(d) => ({ name: d.name, criticality: d.crit })] },
});
export default { schema, upcasters, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
	);
	const log = spyOn(console, 'log').mockImplementation(() => {});
	const out = () => log.mock.calls.map((c) => String(c[0])).join('\n');
	try {
		const client = openDb(await loadConfig(configPath));
		await init(client);
		await client.execute("INSERT INTO node_identity (id) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAA')");
		await client.execute({
			sql: 'INSERT INTO node_versions (id, type, data, valid_from) VALUES (?,?,?,?)',
			args: ['01ARZ3NDEKTSV4RRFFQ69G5FAA', 'device', '{"name":"gw","crit":3}', 1],
		});

		await run(['doctor', '--config', configPath]);
		expect(out()).toContain('upcast device  1 of 1 live behind v2');
		expect(out()).toContain('run `graphx upcast`');

		log.mockClear();
		await run(['upcast', '--config', configPath, '--dry-run']);
		expect(out()).toContain('scanned=1 would upcast=1 (dry run)');

		log.mockClear();
		await run(['upcast', '--config', configPath]);
		expect(out()).toContain('scanned=1 upcast=1');
		const r = await client.execute({
			sql: 'SELECT data FROM nodes WHERE id = ?',
			args: ['01ARZ3NDEKTSV4RRFFQ69G5FAA'],
		});
		expect(JSON.parse(String(r.rows[0]?.data))).toEqual({ name: 'gw', criticality: 3, _v: 2 });

		log.mockClear();
		await run(['doctor', '--config', configPath]);
		expect(out()).toContain('upcast device  0 of 1 live behind v2');
		expect(out()).not.toContain('run `graphx upcast`');
		client.close();
	} finally {
		log.mockRestore();
		await rm(configPath, { force: true });
		for (const sfx of ['', '-wal', '-shm']) await rm(`${ns}.db${sfx}`, { force: true });
	}
});

test.skipIf(NOT_LIBSQL)(
	'run: doctor refuses overlapping open versions, --repair-overlaps settles them',
	async () => {
		const ns = `cli-overlap-${Date.now()}`;
		const configPath = join(import.meta.dir, `${ns}.config.ts`);
		await writeFile(
			configPath,
			`import { defineGraphSchema } from '../../src/core/index.ts';
import { z } from 'zod';
const schema = defineGraphSchema({ nodes: { device: z.object({ name: z.string() }) }, edges: {} });
export default { schema, db: { driver: 'libsql' }, namespace: '${ns}' };
`,
		);
		const log = spyOn(console, 'log').mockImplementation(() => {});
		const out = () => log.mock.calls.map((c) => String(c[0])).join('\n');
		try {
			const client = openDb(await loadConfig(configPath));
			await init(client);
			// v1 damage from the old bulkLoad bug: two open versions of one id, layout not yet v2
			await client.execute('DROP INDEX nv_one_live');
			await client.execute("INSERT INTO node_identity (id) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAA')");
			for (const name of ['old', 'reloaded']) {
				await client.execute({
					sql: 'INSERT INTO node_versions (id, type, data, valid_from) VALUES (?,?,?,?)',
					args: ['01ARZ3NDEKTSV4RRFFQ69G5FAA', 'device', JSON.stringify({ name }), 1],
				});
			}
			await client.execute("UPDATE graph_meta SET value = '1' WHERE key = 'schema_version'");

			await run(['doctor', '--config', configPath]);
			expect(out()).toContain('01ARZ3NDEKTSV4RRFFQ69G5FAA');
			expect(out()).toContain('--repair-overlaps');
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;

			log.mockClear();
			await run(['doctor', '--config', configPath, '--repair-overlaps']);
			expect(out()).toContain('repaired       1 node and 0 edge version(s) are no longer current');
			expect(out()).toContain('overlaps       0 node id(s), 0 edge id(s)');
			const r = await client.execute('SELECT data FROM nodes');
			expect(r.rows.map((row) => JSON.parse(String(row.data)).name)).toEqual(['reloaded']);
			client.close();
		} finally {
			log.mockRestore();
			await rm(configPath, { force: true });
			for (const sfx of ['', '-wal', '-shm']) await rm(`${ns}.db${sfx}`, { force: true });
		}
	},
);
