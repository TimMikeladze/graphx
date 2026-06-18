import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../../core/src/define-graph-schema.ts';
import type { DbClient } from '../../core/src/dialect.ts';
import { Graph } from '../../core/src/graph.ts';
import type { EmbedFn } from '../../core/src/retrieve.ts';
import { init } from '../../core/src/schema.ts';
import { embReadSql, makeTestDb } from '../../core/test/harness.ts';
import { ingestDir } from '../src/index.ts';
import type { Source } from '../src/source.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		note: z.object({ title: z.string().optional() }).passthrough(),
		strict: z.object({ n: z.number() }),
		asset: z.object({ path: z.string() }),
	},
	edges: {
		links_to: { from: 'note', to: 'note' },
		cites: { from: 'note', to: 'note' },
		related: { from: 'note', to: 'note', props: z.object({ note: z.string() }).partial() },
		tagged: {
			from: 'note',
			to: 'note',
			props: z.object({ meta: z.object({ score: z.number() }).partial() }).partial(),
		},
		embeds: { from: 'note', to: ['note', 'asset'] },
	},
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
		args: ['ingest:default:file:a.md'],
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
	expect(res.skipped).toHaveLength(1);
	expect(res.skipped[0]).toMatchObject({ key: 'a.md', stage: 'kind', code: 'no-kind' });
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
	expect(res.skipped).toContainEqual(
		expect.objectContaining({ key: 'a.md', stage: 'link', code: 'unresolved-link' }),
	);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

// --- Edge expressiveness tests ---

test('ingestDir: inline typed link [cites:: [[b]]] produces cites edge; plain [[b]] produces links_to', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\n[cites:: [[b]]] and [[b]]',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed });
	const edges = await client.execute('SELECT rel FROM edges ORDER BY rel');
	const rels = edges.rows.map((r) => String(r.rel)).sort();
	expect(rels).toEqual(['cites', 'links_to']);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: edgeFields frontmatter field becomes typed edge, field excluded from node props', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\nrelated: "[[b]]"\n---\nbody',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { related: 'related' } });
	const edges = await client.execute('SELECT rel FROM edges');
	expect(edges.rows.length).toBe(1);
	expect(String(edges.rows[0]!.rel)).toBe('related');
	// related field must NOT appear in stored node props
	const nodes = await client.execute("SELECT props FROM nodes WHERE uri = 'ingest:default:file:a.md'");
	const props = JSON.parse(String(nodes.rows[0]!.props));
	expect(props).not.toHaveProperty('related');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: edgeFields array value becomes multiple edges', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\nrelated:\n  - "[[b]]"\n  - "[[c]]"\n---\nbody',
		'b.md': '---\nkind: note\n---\nleaf',
		'c.md': '---\nkind: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { related: 'related' } });
	const edges = await client.execute("SELECT rel FROM edges WHERE rel = 'related'");
	expect(edges.rows.length).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: edgeFields object form with weight/props; re-ingest with drift updates edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\nrelated:\n  target: "[[b]]"\n  weight: 0.5\n  props:\n    note: x\n---\nbody',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { related: 'related' } });
	const e1 = await client.execute('SELECT weight, props FROM edges');
	expect(e1.rows.length).toBe(1);
	expect(Number(e1.rows[0]!.weight)).toBe(0.5);
	const p1 = JSON.parse(String(e1.rows[0]!.props));
	expect(p1.note).toBe('x');

	// re-ingest with weight changed to 0.9 → drift update
	await writeFile(
		join(dir, 'a.md'),
		'---\nkind: note\nrelated:\n  target: "[[b]]"\n  weight: 0.9\n  props:\n    note: x\n---\nbody',
	);
	const r2 = await ingestDir({ dir, graph: g, embed, edgeFields: { related: 'related' } });
	expect(r2.edgesClosed).toBeGreaterThanOrEqual(1);
	expect(r2.edgesAdded).toBeGreaterThanOrEqual(1);
	const e2 = await client.execute('SELECT weight FROM edges');
	expect(e2.rows.length).toBe(1);
	expect(Number(e2.rows[0]!.weight)).toBeCloseTo(0.9);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: drift in NESTED edge props is detected and updates the edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\ntagged:\n  target: "[[b]]"\n  props:\n    meta:\n      score: 1\n---\nbody',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { tagged: 'tagged' } });
	const e1 = await client.execute('SELECT props FROM edges');
	expect(JSON.parse(String(e1.rows[0]!.props)).meta.score).toBe(1);

	// only a NESTED value changes — a naive top-level-only key compare would miss this drift
	await writeFile(
		join(dir, 'a.md'),
		'---\nkind: note\ntagged:\n  target: "[[b]]"\n  props:\n    meta:\n      score: 2\n---\nbody',
	);
	const r2 = await ingestDir({ dir, graph: g, embed, edgeFields: { tagged: 'tagged' } });
	expect(r2.edgesClosed).toBeGreaterThanOrEqual(1);
	expect(r2.edgesAdded).toBeGreaterThanOrEqual(1);
	const e2 = await client.execute('SELECT props FROM edges');
	expect(e2.rows.length).toBe(1);
	expect(JSON.parse(String(e2.rows[0]!.props)).meta.score).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: removing a typed link on re-edit closes that typed edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\n[cites:: [[b]]]',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	const r1 = await ingestDir({ dir, graph: g, embed });
	expect(r1.edgesAdded).toBe(1);

	await writeFile(join(dir, 'a.md'), '---\nkind: note\n---\nno more link');
	const r2 = await ingestDir({ dir, graph: g, embed });
	expect(r2.edgesClosed).toBe(1);
	const edges = await client.execute('SELECT id FROM edges');
	expect(edges.rows.length).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: inline link with unknown rel is skipped, run not fatal, node still added', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\n[bogus:: [[b]]]',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(2);
	expect(res.skipped.some((s) => s.key === 'a.md' && s.reason.includes('bogus'))).toBe(true);
	const nodes = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(nodes.rows[0]!.c)).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: an ambiguous wikilink is reported distinctly (with candidates), not as missing', async () => {
	const { g, client } = await graph();
	const dir = await mkdtemp(join(tmpdir(), 'gx-ingest-'));
	await mkdir(join(dir, 'x'), { recursive: true });
	await mkdir(join(dir, 'y'), { recursive: true });
	await writeFile(join(dir, 'x', 'dup.md'), '---\nkind: note\n---\nX');
	await writeFile(join(dir, 'y', 'dup.md'), '---\nkind: note\n---\nY');
	await writeFile(join(dir, 'src.md'), '---\nkind: note\n---\nsee [[dup]]');
	const res = await ingestDir({ dir, graph: g, embed });
	const amb = res.skipped.find((s) => s.code === 'ambiguous-link');
	expect(amb).toBeDefined();
	expect(amb!.detail).toEqual(['x/dup.md', 'y/dup.md']);
	const edges = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(edges.rows[0]!.c)).toBe(0); // no edge for an ambiguous link
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a schema-rejected file yields a structured node skip carrying Zod issues', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: strict\nn: not-a-number\n---\nbody' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(0);
	const skip = res.skipped.find((s) => s.key === 'a.md');
	expect(skip).toMatchObject({ stage: 'node', code: 'schema-reject' });
	expect(Array.isArray(skip!.detail)).toBe(true); // the Zod issues
	await rm(dir, { recursive: true, force: true });
	client.close();
});

// --- Identity & rename stability ---

test('ingestDir: a frontmatter id keys the node by id: (not path)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'foo.md': '---\nkind: note\nid: stable-1\n---\nbody' });
	await ingestDir({ dir, graph: g, embed });
	const n = await client.execute('SELECT uri FROM nodes');
	expect(n.rows.length).toBe(1);
	expect(String(n.rows[0]!.uri)).toBe('ingest:default:id:stable-1');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: renaming a file with a stable id preserves the node + history (not delete+add)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'foo.md': '---\nkind: note\nid: stable-1\n---\nv1' });
	await ingestDir({ dir, graph: g, embed });
	const before = await client.execute("SELECT id FROM nodes WHERE uri = 'ingest:default:id:stable-1'");
	const nodeId = String(before.rows[0]!.id);

	// rename foo.md -> bar.md (same id), edit body
	await rm(join(dir, 'foo.md'));
	await writeFile(join(dir, 'bar.md'), '---\nkind: note\nid: stable-1\n---\nv2');
	const res = await ingestDir({ dir, graph: g, embed, prune: true });

	expect(res.deleted).toBe(0); // identity survived the rename → NOT pruned
	expect(res.added).toBe(0); // NOT a new node
	expect(res.updated).toBe(1); // body changed → one new version
	const after = await client.execute("SELECT id FROM nodes WHERE uri = 'ingest:default:id:stable-1'");
	expect(after.rows.length).toBe(1);
	expect(String(after.rows[0]!.id)).toBe(nodeId); // SAME node id
	const versions = await client.execute({
		sql: 'SELECT COUNT(*) AS c FROM node_versions WHERE id = ?',
		args: [nodeId],
	});
	expect(Number(versions.rows[0]!.c)).toBe(2); // history preserved
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: without a stable id, a rename is delete+add (prune removes the old path node)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'foo.md': '---\nkind: note\n---\nbody' });
	await ingestDir({ dir, graph: g, embed });
	await rm(join(dir, 'foo.md'));
	await writeFile(join(dir, 'bar.md'), '---\nkind: note\n---\nbody');
	const res = await ingestDir({ dir, graph: g, embed, prune: true });
	expect(res.added).toBe(1); // bar.md is a new path-identity node
	expect(res.deleted).toBe(1); // foo.md's node pruned
	const live = await client.execute('SELECT uri FROM nodes');
	expect(live.rows.length).toBe(1);
	expect(String(live.rows[0]!.uri)).toBe('ingest:default:file:bar.md');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: two files claiming the same id → second is skipped as duplicate-identity', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\nid: dup\n---\nA',
		'b.md': '---\nkind: note\nid: dup\n---\nB',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(1);
	expect(res.skipped.some((s) => s.code === 'duplicate-identity')).toBe(true);
	const live = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(live.rows[0]!.c)).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

// --- embed_hash re-embed gating ---

test('ingestDir: frontmatter-only edit does NOT re-embed (body unchanged)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\nkind: note\ntitle: v1\n---\nbody text' });

	let embedCalls = 0;
	const countingEmbed: EmbedFn = async (_body: string) => {
		embedCalls++;
		return [1, 0, 0, 0];
	};

	// First ingest: one embed call (new node)
	await ingestDir({ dir, graph: g, embed: countingEmbed });
	expect(embedCalls).toBe(1);

	// Read stored emb before re-ingest
	const before = await client.execute("SELECT emb FROM nodes WHERE uri = 'ingest:default:file:a.md'");
	expect(before.rows[0]!.emb).not.toBeNull();

	// Re-ingest after changing ONLY frontmatter (body unchanged) → no re-embed, result.updated=1
	await writeFile(join(dir, 'a.md'), '---\nkind: note\ntitle: v2\n---\nbody text');
	const res = await ingestDir({ dir, graph: g, embed: countingEmbed });
	expect(res.updated).toBe(1);
	expect(embedCalls).toBe(1); // counter must NOT have increased

	// Edit the body → re-embed fires
	await writeFile(join(dir, 'a.md'), '---\nkind: note\ntitle: v2\n---\nbody text changed');
	const res2 = await ingestDir({ dir, graph: g, embed: countingEmbed });
	expect(res2.updated).toBe(1);
	expect(embedCalls).toBe(2); // body changed, so embed called again

	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: batched embeds preserve per-file association (embedConcurrency=3)', async () => {
	// Each fake embed returns a vector derived from the body's first char code, so we can
	// assert that node[i].emb was computed from node[i].body (not a neighbor's body).
	const bodies = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
	const files: Record<string, string> = {};
	for (const b of bodies) {
		files[`${b}.md`] = `---\nkind: note\n---\n${b}`;
	}

	const bodyToVec = (body: string): number[] => {
		const code = body.trim().charCodeAt(0);
		return [code, 0, 0, 0];
	};

	const associatedEmbed: EmbedFn = async (body: string) => bodyToVec(body);

	const { g, client } = await graph();
	const dir = await vault(files);
	await ingestDir({ dir, graph: g, embed: associatedEmbed, embedConcurrency: 3 });

	// For each body, read the stored vector back (dialect-correct) and assert its first
	// element equals THIS body's first char code — proving node[i].emb came from body[i],
	// not a neighbor's (which a reorder in the concurrent embed step would cause).
	for (const b of bodies) {
		const uri = `ingest:default:file:${b}.md`;
		const row = await client.execute({
			sql: `SELECT ${embReadSql(client)} AS v FROM nodes WHERE uri = ?`,
			args: [uri],
		});
		expect(row.rows.length).toBe(1);
		const arr = JSON.parse(String(row.rows[0]!.v)) as number[];
		expect(arr[0]).toBe(b.charCodeAt(0));
	}

	await rm(dir, { recursive: true, force: true });
	client.close();
});

// --- Source seam tests ---

test('ingestDir: accepts a custom in-memory Source (no dir)', async () => {
	const { g, client } = await graph();

	const files: Record<string, string> = {
		'a.md': '---\nkind: note\ntitle: Alpha\n---\nbody a',
		'b.md': '---\nkind: note\ntitle: Beta\n---\nbody b',
	};
	const memSource: Source = {
		list: async () => ['a.md', 'b.md'],
		read: async (key: string) => files[key] ?? '',
	};

	const res = await ingestDir({ fileSource: memSource, graph: g, embed });
	expect(res.added).toBe(2);
	expect(res.skipped).toHaveLength(0);
	const rows = await client.execute('SELECT COUNT(*) AS c FROM nodes');
	expect(Number(rows.rows[0]!.c)).toBe(2);
	client.close();
});

test('ingestDir: throws when neither dir nor fileSource is provided', async () => {
	const { g, client } = await graph();
	// @ts-expect-error intentionally omitting required dir/fileSource
	await expect(ingestDir({ graph: g, embed })).rejects.toThrow('ingestDir: requires `dir` or `fileSource`');
	client.close();
});

// --- Lightweight image-asset ingestion ---

test('ingestDir: an image embed becomes an asset node + embeds edge (assets opt-in)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'doc.md': '---\nkind: note\n---\nsee ![alt](./img/pic.png)' });
	const res = await ingestDir({ dir, graph: g, embed, assets: { kind: 'asset' } });
	expect(res.edgesAdded).toBe(1);
	const asset = await client.execute("SELECT uri, content_type, props FROM nodes WHERE kind = 'asset'");
	expect(asset.rows.length).toBe(1);
	expect(String(asset.rows[0]!.uri)).toBe('ingest:default:asset:img/pic.png');
	expect(String(asset.rows[0]!.content_type)).toBe('image/png');
	expect(JSON.parse(String(asset.rows[0]!.props)).path).toBe('img/pic.png');
	const edge = await client.execute("SELECT rel FROM edges");
	expect(edge.rows.length).toBe(1);
	expect(String(edge.rows[0]!.rel)).toBe('embeds');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: assets are ignored unless opted in', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'doc.md': '---\nkind: note\n---\n![alt](./pic.png)' });
	await ingestDir({ dir, graph: g, embed }); // no `assets`
	const assets = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'asset'");
	expect(Number(assets.rows[0]!.c)).toBe(0);
	const edges = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(edges.rows[0]!.c)).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: the same asset embedded by two docs dedupes to one asset node, two edges', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\n![](./shared.png)',
		'b.md': '---\nkind: note\n---\n![](./shared.png)',
	});
	await ingestDir({ dir, graph: g, embed, assets: { kind: 'asset' } });
	const assets = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'asset'");
	expect(Number(assets.rows[0]!.c)).toBe(1);
	const edges = await client.execute("SELECT COUNT(*) AS c FROM edges WHERE rel = 'embeds'");
	expect(Number(edges.rows[0]!.c)).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: an embed of a known note links to that note (no asset node)', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\nkind: note\n---\nembed ![[b]]',
		'b.md': '---\nkind: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, assets: { kind: 'asset' } });
	const assets = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'asset'");
	expect(Number(assets.rows[0]!.c)).toBe(0); // resolved to note b, not an asset
	const edge = await client.execute("SELECT rel FROM edges WHERE rel = 'embeds'");
	expect(edge.rows.length).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: removing an embed closes its edge; asset node survives prune', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'doc.md': '---\nkind: note\n---\n![](./pic.png)' });
	await ingestDir({ dir, graph: g, embed, assets: { kind: 'asset' } });
	expect(Number((await client.execute("SELECT COUNT(*) AS c FROM edges")).rows[0]!.c)).toBe(1);

	// remove the embed AND prune — the embeds edge closes, but the asset node is never pruned
	await writeFile(join(dir, 'doc.md'), '---\nkind: note\n---\nno embed now');
	const res = await ingestDir({ dir, graph: g, embed, assets: { kind: 'asset' }, prune: true });
	expect(res.edgesClosed).toBeGreaterThanOrEqual(1);
	expect(res.deleted).toBe(0); // doc still present; asset never pruned
	expect(Number((await client.execute("SELECT COUNT(*) AS c FROM edges")).rows[0]!.c)).toBe(0);
	expect(Number((await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'asset'")).rows[0]!.c)).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});
