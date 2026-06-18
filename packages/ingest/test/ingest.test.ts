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
		args: ['ingest:default:a.md'],
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

test('ingestDir: links become edges; removing a link closes the edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\nlinks to [[b]]',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	const r1 = await ingestDir({ dir, graph: g, embed });
	expect(r1.edgesAdded).toBe(1);
	const e1 = await client.execute('SELECT src, dst FROM edges');
	expect(e1.rows.length).toBe(1);

	await writeFile(join(dir, 'a.md'), '---\nkind: note\n---\nno more link');
	const r2 = await ingestDir({ dir, graph: g, embed });
	expect(r2.edgesClosed).toBe(1);
	const e2 = await client.execute('SELECT src, dst FROM edges');
	expect(e2.rows.length).toBe(0);

	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: deleting a file does NOT prune by default (deleted=0, node stays live)', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\nalpha',
		'b.md': '---\nkind: note\n---\nbeta',
	});
	await ingestDir({ dir, graph: g, embed });
	await rm(join(dir, 'b.md'));
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.deleted).toBe(0);
	const c = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(c.rows[0]!.c)).toBe(2); // b still live (no prune)
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: prune closes nodes for removed files and their incident edges', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\nlinks to [[b]]',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed });
	const e0 = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(e0.rows[0]!.c)).toBe(1); // a -> b

	await rm(join(dir, 'b.md')); // a.md is unchanged, so a is NOT touched this run
	const res = await ingestDir({ dir, graph: g, embed, prune: true });
	expect(res.deleted).toBe(1);
	const live = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(live.rows[0]!.c)).toBe(1); // b dropped from the live view
	// the inbound edge a->b is closed by the prune cascade (no dangling edge into a gone node)
	const e1 = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(e1.rows[0]!.c)).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: prune is scoped per source (one source does not prune another)', async () => {
	const { g, client } = await graph();
	const dirA = await vault({ 'a.md': '---\nkind: note\n---\nA' });
	const dirB = await vault({ 'b.md': '---\nkind: note\n---\nB' });
	await ingestDir({ dir: dirA, graph: g, embed, source: 'A' });
	await ingestDir({ dir: dirB, graph: g, embed, source: 'B' });

	await rm(join(dirA, 'a.md')); // source A is now empty on disk
	const res = await ingestDir({ dir: dirA, graph: g, embed, source: 'A', prune: true });
	expect(res.deleted).toBe(1);
	const live = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(live.rows[0]!.c)).toBe(1); // source B's node survives
	await rm(dirA, { recursive: true, force: true });
	await rm(dirB, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a link to a missing file is skipped, not fatal', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: note\n---\nbroken [[ghost]]' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(1);
	expect(res.edgesAdded).toBe(0);
	expect(res.skipped).toContainEqual({ key: 'a.md', reason: 'unresolved link: ghost' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});
