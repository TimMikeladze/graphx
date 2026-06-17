import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../core/src/define-graph-schema.ts';
import type { DbClient } from '../../core/src/dialect.ts';
import { Graph } from '../../core/src/graph.ts';
import type { EmbedFn } from '../../core/src/retrieve.ts';
import { init } from '../../core/src/schema.ts';
import { makeTestDb } from '../../core/test/harness.ts';
import { ingestDir } from '../src/index.ts';

const SCHEMA = defineGraphSchema({
	nodes: { note: z.object({ title: z.string().optional() }).passthrough() },
	edges: { links_to: { from: 'note', to: 'note' } },
});

const embed: EmbedFn = async () => [1, 0, 0, 0];

async function graph(): Promise<{ g: Graph<typeof SCHEMA>; client: DbClient }> {
	const client = makeTestDb({ file: true }).client;
	await init(client, 4);
	return { g: new Graph(client, SCHEMA), client };
}

async function vault(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'gx-ingest-'));
	for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
	return dir;
}

test('ingestDir: first run adds a node per file', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\ntitle: A\n---\nalpha',
		'b.md': '---\nkind: note\ntitle: B\n---\nbeta',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(2);
	expect(res.updated).toBe(0);
	const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(rows.rows[0]!.c)).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: re-running an unchanged vault is a no-op', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: note\n---\nalpha' });
	await ingestDir({ dir, graph: g, embed });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: editing a file creates a new version (history preserved)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: note\n---\nv1' });
	await ingestDir({ dir, graph: g, embed });
	await writeFile(join(dir, 'a.md'), '---\nkind: note\n---\nv2');
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
	const versions = await client.execute({
		sql: 'SELECT COUNT(*) AS c FROM node_versions WHERE uri = ?',
		args: ['file:a.md'],
	});
	expect(Number(versions.rows[0]!.c)).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a file with no resolvable kind is skipped', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': 'no frontmatter here' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(0);
	expect(res.skipped).toEqual([{ key: 'a.md', reason: 'no kind' }]);
	await rm(dir, { recursive: true, force: true });
	client.close();
});
