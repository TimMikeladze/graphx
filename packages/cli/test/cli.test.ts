import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { parseIngestArgs } from '../src/cli.ts';

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
	expect(args.assetsKind).toBeUndefined();
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

test('parseIngestArgs: parses --assets-kind', () => {
	const args = parseIngestArgs(['ingest', '/some/dir', '--assets-kind', 'asset']);
	expect(args.assetsKind).toBe('asset');
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
		'--assets-kind',
		'media',
	]);
	expect(args.dir).toBe('/vault');
	expect(args.source).toBe('vault1');
	expect(args.prune).toBe(true);
	expect(args.watch).toBe(true);
	expect(args.idField).toBe('slug');
	expect(args.assetsKind).toBe('media');
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

	await writeFile(join(vaultDir, 'note.md'), '---\nkind: note\ntitle: Hello\n---\nworld');
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
export default { schema, embed, db: { driver: 'libsql' }, namespace: '${ns}' };
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
