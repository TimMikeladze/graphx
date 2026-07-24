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
		stub: z.object({ name: z.string() }),
		tag: z.object({ name: z.string() }),
	},
	edges: {
		links_to: { from: 'note', to: ['note', 'stub'] },
		cites: { from: 'note', to: ['note', 'stub'] },
		related: { from: 'note', to: 'note', data: z.object({ note: z.string() }).partial() },
		tagged: {
			from: 'note',
			to: 'note',
			data: z.object({ meta: z.object({ score: z.number() }).partial() }).partial(),
		},
		embeds: { from: 'note', to: ['note', 'asset'] },
		tagged_with: { from: 'note', to: 'tag' },
		topic: { from: 'note', to: 'tag' },
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
		'a.md': '---\ntype: note\ntitle: A\n---\nalpha',
		'b.md': '---\ntype: note\ntitle: B\n---\nbeta',
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
	const dir = await vault({ 'a.md': '---\ntype: note\n---\nalpha' });
	await ingestDir({ dir, graph: g, embed });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: editing a file creates a new version (history preserved)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\nv1' });
	await ingestDir({ dir, graph: g, embed });
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nv2');
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

test('ingestDir: a file with no resolvable type is skipped', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': 'no frontmatter here' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(0);
	expect(res.skipped).toHaveLength(1);
	expect(res.skipped[0]).toMatchObject({ key: 'a.md', stage: 'type', code: 'no-type' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: links become edges; removing a link closes the edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nlinks to [[b]]',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	const r1 = await ingestDir({ dir, graph: g, embed });
	expect(r1.edgesAdded).toBe(1);
	const e1 = await client.execute('SELECT src, dst FROM edges');
	expect(e1.rows.length).toBe(1);

	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nno more link');
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
		'a.md': '---\ntype: note\n---\nalpha',
		'b.md': '---\ntype: note\n---\nbeta',
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
		'a.md': '---\ntype: note\n---\nlinks to [[b]]',
		'b.md': '---\ntype: note\n---\nleaf',
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
	const dirA = await vault({ 'a.md': '---\ntype: note\n---\nA' });
	const dirB = await vault({ 'b.md': '---\ntype: note\n---\nB' });
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
	const dir = await vault({ 'a.md': '---\ntype: note\n---\nbroken [[ghost]]' });
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
		'a.md': '---\ntype: note\n---\n[cites:: [[b]]] and [[b]]',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed });
	const edges = await client.execute('SELECT rel FROM edges ORDER BY rel');
	const rels = edges.rows.map((r) => String(r.rel)).sort();
	expect(rels).toEqual(['cites', 'links_to']);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: edgeFields frontmatter field becomes typed edge, field excluded from node data', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\nrelated: "[[b]]"\n---\nbody',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { related: 'related' } });
	const edges = await client.execute('SELECT rel FROM edges');
	expect(edges.rows.length).toBe(1);
	expect(String(edges.rows[0]!.rel)).toBe('related');
	// related field must NOT appear in stored node data
	const nodes = await client.execute("SELECT data FROM nodes WHERE uri = 'ingest:default:file:a.md'");
	const data = JSON.parse(String(nodes.rows[0]!.data));
	expect(data).not.toHaveProperty('related');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: edgeFields array value becomes multiple edges', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\nrelated:\n  - "[[b]]"\n  - "[[c]]"\n---\nbody',
		'b.md': '---\ntype: note\n---\nleaf',
		'c.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { related: 'related' } });
	const edges = await client.execute("SELECT rel FROM edges WHERE rel = 'related'");
	expect(edges.rows.length).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: edgeFields object form with weight/data; re-ingest with drift updates edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\nrelated:\n  target: "[[b]]"\n  weight: 0.5\n  data:\n    note: x\n---\nbody',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { related: 'related' } });
	const e1 = await client.execute('SELECT weight, data FROM edges');
	expect(e1.rows.length).toBe(1);
	expect(Number(e1.rows[0]!.weight)).toBe(0.5);
	const p1 = JSON.parse(String(e1.rows[0]!.data));
	expect(p1.note).toBe('x');

	// re-ingest with weight changed to 0.9 → drift update
	await writeFile(
		join(dir, 'a.md'),
		'---\ntype: note\nrelated:\n  target: "[[b]]"\n  weight: 0.9\n  data:\n    note: x\n---\nbody',
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

test('ingestDir: drift in NESTED edge data is detected and updates the edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\ntagged:\n  target: "[[b]]"\n  data:\n    meta:\n      score: 1\n---\nbody',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, edgeFields: { tagged: 'tagged' } });
	const e1 = await client.execute('SELECT data FROM edges');
	expect(JSON.parse(String(e1.rows[0]!.data)).meta.score).toBe(1);

	// only a NESTED value changes — a naive top-level-only key compare would miss this drift
	await writeFile(
		join(dir, 'a.md'),
		'---\ntype: note\ntagged:\n  target: "[[b]]"\n  data:\n    meta:\n      score: 2\n---\nbody',
	);
	const r2 = await ingestDir({ dir, graph: g, embed, edgeFields: { tagged: 'tagged' } });
	expect(r2.edgesClosed).toBeGreaterThanOrEqual(1);
	expect(r2.edgesAdded).toBeGreaterThanOrEqual(1);
	const e2 = await client.execute('SELECT data FROM edges');
	expect(e2.rows.length).toBe(1);
	expect(JSON.parse(String(e2.rows[0]!.data)).meta.score).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: removing a typed link on re-edit closes that typed edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n[cites:: [[b]]]',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	const r1 = await ingestDir({ dir, graph: g, embed });
	expect(r1.edgesAdded).toBe(1);

	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nno more link');
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
		'a.md': '---\ntype: note\n---\n[bogus:: [[b]]]',
		'b.md': '---\ntype: note\n---\nleaf',
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
	await writeFile(join(dir, 'x', 'dup.md'), '---\ntype: note\n---\nX');
	await writeFile(join(dir, 'y', 'dup.md'), '---\ntype: note\n---\nY');
	await writeFile(join(dir, 'src.md'), '---\ntype: note\n---\nsee [[dup]]');
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
	const dir = await vault({ 'a.md': '---\ntype: strict\nn: not-a-number\n---\nbody' });
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
	const dir = await vault({ 'foo.md': '---\ntype: note\nid: stable-1\n---\nbody' });
	await ingestDir({ dir, graph: g, embed });
	const n = await client.execute('SELECT uri FROM nodes');
	expect(n.rows.length).toBe(1);
	expect(String(n.rows[0]!.uri)).toBe('ingest:default:id:stable-1');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: renaming a file with a stable id preserves the node + history (not delete+add)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'foo.md': '---\ntype: note\nid: stable-1\n---\nv1' });
	await ingestDir({ dir, graph: g, embed });
	const before = await client.execute("SELECT id FROM nodes WHERE uri = 'ingest:default:id:stable-1'");
	const nodeId = String(before.rows[0]!.id);

	// rename foo.md -> bar.md (same id), edit body
	await rm(join(dir, 'foo.md'));
	await writeFile(join(dir, 'bar.md'), '---\ntype: note\nid: stable-1\n---\nv2');
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
	const dir = await vault({ 'foo.md': '---\ntype: note\n---\nbody' });
	await ingestDir({ dir, graph: g, embed });
	await rm(join(dir, 'foo.md'));
	await writeFile(join(dir, 'bar.md'), '---\ntype: note\n---\nbody');
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
		'a.md': '---\ntype: note\nid: dup\n---\nA',
		'b.md': '---\ntype: note\nid: dup\n---\nB',
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
	const dir = await vault({ 'a.md': '---\ntype: note\ntitle: v1\n---\nbody text' });

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
	await writeFile(join(dir, 'a.md'), '---\ntype: note\ntitle: v2\n---\nbody text');
	const res = await ingestDir({ dir, graph: g, embed: countingEmbed });
	expect(res.updated).toBe(1);
	expect(embedCalls).toBe(1); // counter must NOT have increased

	// Edit the body → re-embed fires
	await writeFile(join(dir, 'a.md'), '---\ntype: note\ntitle: v2\n---\nbody text changed');
	const res2 = await ingestDir({ dir, graph: g, embed: countingEmbed });
	expect(res2.updated).toBe(1);
	expect(embedCalls).toBe(2); // body changed, so embed called again

	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: changing embedId re-embeds even when the body is unchanged (model swap)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\nbody text' });

	let calls = 0;
	const counting: EmbedFn = async () => {
		calls++;
		return [1, 0, 0, 0];
	};

	// First ingest under model 'm1' → one embed.
	await ingestDir({ dir, graph: g, embed: counting, embedId: 'm1' });
	expect(calls).toBe(1);

	// Same embedId, unchanged body → no re-embed.
	const r1 = await ingestDir({ dir, graph: g, embed: counting, embedId: 'm1' });
	expect(r1.unchanged).toBe(1);
	expect(calls).toBe(1);

	// Swap embedId → must re-embed despite identical body (otherwise vector spaces mix).
	const r2 = await ingestDir({ dir, graph: g, embed: counting, embedId: 'm2' });
	expect(r2.updated).toBe(1);
	expect(r2.unchanged).toBe(0);
	expect(calls).toBe(2);

	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: foreign edges (authored outside ingest) survive a reconcile of the source', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nlinks to [[b]]',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed });

	const ids = await client.execute('SELECT uri, id FROM nodes');
	const byUri = new Map(ids.rows.map((r) => [String(r.uri), String(r.id)]));
	const aId = byUri.get('ingest:default:file:a.md')!;
	const bId = byUri.get('ingest:default:file:b.md')!;

	// A user / enrichment job adds a TYPED-PROPS edge directly (no ingest provenance). A typed
	// rel is used on purpose: it proves provenance can't ride in data (zod strips unknown keys).
	await g.addEdge({ rel: 'related', src: aId, dst: bId, data: { note: 'manual' } });
	expect(Number((await client.execute('SELECT COUNT(*) AS c FROM edges')).rows[0]!.c)).toBe(2);

	// Re-reconcile a.md (edit forces it into `touched`). Ingest must NOT close the foreign edge.
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nstill links [[b]] after an edit');
	await ingestDir({ dir, graph: g, embed });

	const rels = (await client.execute('SELECT rel FROM edges ORDER BY rel')).rows.map((r) => String(r.rel));
	expect(rels).toEqual(['links_to', 'related']); // ingest's own edge + the surviving foreign edge
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: batched embeds preserve per-file association (embedConcurrency=3)', async () => {
	// Each fake embed returns a vector derived from the body's first char code, so we can
	// assert that node[i].emb was computed from node[i].body (not a neighbor's body).
	const bodies = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
	const files: Record<string, string> = {};
	for (const b of bodies) {
		files[`${b}.md`] = `---\ntype: note\n---\n${b}`;
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
		'a.md': '---\ntype: note\ntitle: Alpha\n---\nbody a',
		'b.md': '---\ntype: note\ntitle: Beta\n---\nbody b',
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
	const dir = await vault({ 'doc.md': '---\ntype: note\n---\nsee ![alt](./img/pic.png)' });
	const res = await ingestDir({ dir, graph: g, embed, assets: { type: 'asset' } });
	expect(res.edgesAdded).toBe(1);
	const asset = await client.execute("SELECT uri, content_type, data FROM nodes WHERE type = 'asset'");
	expect(asset.rows.length).toBe(1);
	expect(String(asset.rows[0]!.uri)).toBe('ingest:default:asset:img/pic.png');
	expect(String(asset.rows[0]!.content_type)).toBe('image/png');
	expect(JSON.parse(String(asset.rows[0]!.data)).path).toBe('img/pic.png');
	const edge = await client.execute("SELECT rel FROM edges");
	expect(edge.rows.length).toBe(1);
	expect(String(edge.rows[0]!.rel)).toBe('embeds');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: assets are ignored unless opted in', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'doc.md': '---\ntype: note\n---\n![alt](./pic.png)' });
	await ingestDir({ dir, graph: g, embed }); // no `assets`
	const assets = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'asset'");
	expect(Number(assets.rows[0]!.c)).toBe(0);
	const edges = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(edges.rows[0]!.c)).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: the same asset embedded by two docs dedupes to one asset node, two edges', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n![](./shared.png)',
		'b.md': '---\ntype: note\n---\n![](./shared.png)',
	});
	await ingestDir({ dir, graph: g, embed, assets: { type: 'asset' } });
	const assets = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'asset'");
	expect(Number(assets.rows[0]!.c)).toBe(1);
	const edges = await client.execute("SELECT COUNT(*) AS c FROM edges WHERE rel = 'embeds'");
	expect(Number(edges.rows[0]!.c)).toBe(2);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: an embed of a known note links to that note (no asset node)', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nembed ![[b]]',
		'b.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed, assets: { type: 'asset' } });
	const assets = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'asset'");
	expect(Number(assets.rows[0]!.c)).toBe(0); // resolved to note b, not an asset
	const edge = await client.execute("SELECT rel FROM edges WHERE rel = 'embeds'");
	expect(edge.rows.length).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: removing an embed closes its edge; asset node survives prune', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'doc.md': '---\ntype: note\n---\n![](./pic.png)' });
	await ingestDir({ dir, graph: g, embed, assets: { type: 'asset' } });
	expect(Number((await client.execute("SELECT COUNT(*) AS c FROM edges")).rows[0]!.c)).toBe(1);

	// remove the embed AND prune — the embeds edge closes, but the asset node is never pruned
	await writeFile(join(dir, 'doc.md'), '---\ntype: note\n---\nno embed now');
	const res = await ingestDir({ dir, graph: g, embed, assets: { type: 'asset' }, prune: true });
	expect(res.edgesClosed).toBeGreaterThanOrEqual(1);
	expect(res.deleted).toBe(0); // doc still present; asset never pruned
	expect(Number((await client.execute("SELECT COUNT(*) AS c FROM edges")).rows[0]!.c)).toBe(0);
	expect(Number((await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'asset'")).rows[0]!.c)).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a heading link resolves to the whole note and records the fragment on the edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nsee [[b#Intro]]',
		'b.md': '---\ntype: note\n---\n## Intro\nbeta',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.skipped).toEqual([]);
	expect(res.edgesAdded).toBe(1);
	const rows = await client.execute('SELECT rel, data FROM edges');
	expect(rows.rows.length).toBe(1);
	expect(rows.rows[0]!.rel).toBe('links_to');
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ fragment: 'Intro' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a block-ref link resolves to the note, carrying the ^id fragment', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nsee [[b#^abc123]]',
		'b.md': '---\ntype: note\n---\nbeta ^abc123',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.skipped).toEqual([]);
	const rows = await client.execute('SELECT data FROM edges');
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ fragment: '^abc123' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a fragment-less link stores no fragment in edge data', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nsee [[b]]',
		'b.md': '---\ntype: note\n---\nbeta',
	});
	await ingestDir({ dir, graph: g, embed });
	const rows = await client.execute('SELECT data FROM edges');
	expect(JSON.parse(String(rows.rows[0]!.data ?? '{}'))).toEqual({});
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a wikilink to a frontmatter alias resolves to that note', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nsee [[Bee]]',
		'b.md': '---\ntype: note\naliases: [Bee, B-note]\n---\nbeta',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.skipped).toEqual([]);
	expect(res.edgesAdded).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a scalar `aliases` string is accepted as a single alias', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nsee [[Bee]]',
		'b.md': '---\ntype: note\naliases: Bee\n---\nbeta',
	});
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.skipped).toEqual([]);
	expect(res.edgesAdded).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: aliases on an UNCHANGED file still resolve on a later run', async () => {
	// b.md is unchanged on run 2, so its body is never re-read — its aliases must still be
	// indexed, or a new link to [[Bee]] would fail to resolve.
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nno links yet',
		'b.md': '---\ntype: note\naliases: [Bee]\n---\nbeta',
	});
	await ingestDir({ dir, graph: g, embed });
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nsee [[Bee]]');
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.skipped).toEqual([]);
	expect(res.edgesAdded).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: an Obsidian folder-relative wikilink resolves from a nested file', async () => {
	const { g, client } = await graph();
	const dir = await mkdtemp(join(tmpdir(), 'gx-ingest-'));
	await mkdir(join(dir, 'note', 'sub'), { recursive: true });
	await writeFile(join(dir, 'note', 'alpha.md'), '---\ntype: note\n---\nsee [[sub/dupe]]');
	await writeFile(join(dir, 'note', 'sub', 'dupe.md'), '---\ntype: note\n---\ndupe');
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.skipped).toEqual([]);
	expect(res.edgesAdded).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a trashed copy sharing an id does NOT displace the live note', async () => {
	// Obsidian moves deleted notes to `.trash/`, frontmatter intact. `.trash` sorts before most
	// folders, so before hidden paths were skipped the DELETED copy claimed the id first and the
	// live file was rejected as a duplicate-identity.
	const { g, client } = await graph();
	const dir = await mkdtemp(join(tmpdir(), 'gx-ingest-'));
	await mkdir(join(dir, '.trash'), { recursive: true });
	await mkdir(join(dir, 'note'), { recursive: true });
	await writeFile(join(dir, 'note', 'n.md'), '---\nid: n\ntype: note\n---\nCURRENT');
	await writeFile(join(dir, '.trash', 'n.md'), '---\nid: n\ntype: note\n---\nDELETED');
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(1);
	expect(res.skipped).toEqual([]);
	const rows = await client.execute('SELECT body FROM nodes');
	expect(rows.rows.length).toBe(1);
	expect(String(rows.rows[0]!.body)).toBe('CURRENT');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: exclude drops keys before they are read or ingested', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'keep.md': '---\ntype: note\n---\nkeep',
		'diagram.excalidraw.md': '---\ntype: note\n---\n# Excalidraw Data\n{"elements":[]}',
	});
	const res = await ingestDir({
		dir,
		graph: g,
		embed,
		exclude: (key) => key.endsWith('.excalidraw.md'),
	});
	expect(res.added).toBe(1);
	const rows = await client.execute('SELECT body FROM nodes');
	expect(String(rows.rows[0]!.body)).toBe('keep');
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: newly excluding an already-ingested file prunes it (exclude cleans up)', async () => {
	// `prune` reconciles against what the source NOW yields, and an excluded key is no longer
	// yielded — so adding an `exclude` retracts the junk a previous run ingested. Without prune
	// the node just lingers, same as for a file deleted off disk.
	const { g, client } = await graph();
	const dir = await vault({
		'keep.md': '---\ntype: note\n---\nkeep',
		'drawing.excalidraw.md': '---\ntype: note\n---\ndrawing',
	});
	const first = await ingestDir({ dir, graph: g, embed });
	expect(first.added).toBe(2);
	const res = await ingestDir({
		dir,
		graph: g,
		embed,
		prune: true,
		exclude: (key) => key.endsWith('.excalidraw.md'),
	});
	expect(res.deleted).toBe(1);
	const rows = await client.execute('SELECT body FROM nodes');
	expect(rows.rows.map((r) => String(r.body))).toEqual(['keep']);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a later plain link does not erase an earlier link fragment', async () => {
	// All links to one note collapse to a single (rel, dst) edge. A fragment is information the
	// plain form simply lacks, so it must not be clobbered by ordering — regardless of which
	// form appears last in the body.
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\nsee [[b#Intro]] and also [[b]]',
		'b.md': '---\ntype: note\n---\nbeta',
	});
	await ingestDir({ dir, graph: g, embed });
	const rows = await client.execute('SELECT data FROM edges');
	expect(rows.rows.length).toBe(1);
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ fragment: 'Intro' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: with several fragments to one note, the last fragment wins', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n[[b#First]] then [[b#Second]]',
		'b.md': '---\ntype: note\n---\nbeta',
	});
	await ingestDir({ dir, graph: g, embed });
	const rows = await client.execute('SELECT data FROM edges');
	expect(rows.rows.length).toBe(1);
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ fragment: 'Second' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: dangling is off by default — an unresolved wikilink is still a skip', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\nstub [[not-yet-written]]' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(1);
	expect(res.edgesAdded).toBe(0);
	expect(res.skipped).toHaveLength(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: dangling turns an unresolved wikilink into a stub node + edge, not a skip', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\nstub [[Not Yet Written]]' });
	const res = await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	expect(res.skipped).toEqual([]);
	expect(res.edgesAdded).toBe(1);
	const rows = await client.execute("SELECT uri, data FROM nodes WHERE type = 'stub'");
	expect(rows.rows.length).toBe(1);
	expect(String(rows.rows[0]!.uri)).toBe('ingest:default:dangling:not yet written');
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ name: 'Not Yet Written' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: two notes linking the same missing name share ONE stub node', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n[[Ghost]]',
		'b.md': '---\ntype: note\n---\n[[ghost]]',
	});
	const res = await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	expect(res.edgesAdded).toBe(2);
	const rows = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'stub'");
	expect(Number(rows.rows[0]!.c)).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a typed dangling link keeps its own rel', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\n[cites:: [[ghost]]]' });
	await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	const rows = await client.execute('SELECT rel FROM edges');
	expect(rows.rows.map((r) => String(r.rel))).toEqual(['cites']);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: writing the missing note re-points the link at the real node', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\n[[ghost]]' });
	await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	// The stub is now a real note. a.md must be re-read for its link to re-resolve, so touch it.
	await writeFile(join(dir, 'ghost.md'), '---\ntype: note\n---\nnow real');
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\n[[ghost]] (edited)');
	await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	const edges = await client.execute(
		"SELECT n.type AS t FROM edges e JOIN nodes n ON n.id = e.dst",
	);
	expect(edges.rows.map((r) => String(r.t))).toEqual(['note']);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: an ambiguous wikilink stays a skip — it is not dangling', async () => {
	const { g, client } = await graph();
	const dir = await mkdtemp(join(tmpdir(), 'gx-ingest-'));
	await mkdir(join(dir, 'x'), { recursive: true });
	await mkdir(join(dir, 'y'), { recursive: true });
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\n[[dup]]');
	await writeFile(join(dir, 'x', 'dup.md'), '---\ntype: note\n---\nx');
	await writeFile(join(dir, 'y', 'dup.md'), '---\ntype: note\n---\ny');
	const res = await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	expect(res.skipped).toHaveLength(1);
	expect(res.skipped[0]).toMatchObject({ code: 'ambiguous-link' });
	const rows = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'stub'");
	expect(Number(rows.rows[0]!.c)).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: a broken relative PATH link is a skip, not a dangling stub', async () => {
	// `[[wikilink]]` to a missing note is an intentional PKM stub. `[x](./typo.md)` is just broken.
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\n[x](./typo.md)' });
	const res = await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	expect(res.skipped).toHaveLength(1);
	const rows = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'stub'");
	expect(Number(rows.rows[0]!.c)).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: prune never retracts stub nodes', async () => {
	// Links are only re-extracted for CHANGED files, so a run cannot know that an unchanged note
	// still references a stub — pruning on that partial view would delete live stubs.
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\n[[ghost]]' });
	await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' } });
	const res = await ingestDir({ dir, graph: g, embed, dangling: { type: 'stub' }, prune: true });
	expect(res.deleted).toBe(0);
	const rows = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'stub'");
	expect(Number(rows.rows[0]!.c)).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: editing a link fragment updates the existing edge (drift)', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n[[b#First]]',
		'b.md': '---\ntype: note\n---\nbeta',
	});
	await ingestDir({ dir, graph: g, embed });
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\n[[b#Second]]');
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.edgesAdded).toBe(1);
	expect(res.edgesClosed).toBe(1);
	const rows = await client.execute('SELECT data FROM edges');
	expect(rows.rows.length).toBe(1);
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ fragment: 'Second' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: dropping a fragment from a link clears it off the edge', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n[[b#First]]',
		'b.md': '---\ntype: note\n---\nbeta',
	});
	await ingestDir({ dir, graph: g, embed });
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\n[[b]] only');
	await ingestDir({ dir, graph: g, embed });
	const rows = await client.execute('SELECT data FROM edges');
	expect(JSON.parse(String(rows.rows[0]!.data ?? '{}'))).toEqual({});
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: an edgeFields edge does not silently drop a body link fragment', async () => {
	// Both produce (cites, b). edgeFields is the more explicit declaration and wins on weight/data,
	// but it must not erase a fragment the body link contributed.
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\ncites: b\n---\n[cites:: [[b#Intro]]]',
		'b.md': '---\ntype: note\n---\nbeta',
	});
	const res = await ingestDir({ dir, graph: g, embed, edgeFields: { cites: 'cites' } });
	expect(res.edgesAdded).toBe(1);
	const rows = await client.execute('SELECT data FROM edges');
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ fragment: 'Intro' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: touched files reconcile their own edges only (no cross-contamination)', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n[[c]]',
		'b.md': '---\ntype: note\n---\n[[c]] and [[a]]',
		'c.md': '---\ntype: note\n---\nleaf',
	});
	await ingestDir({ dir, graph: g, embed });
	// a drops its only link; b keeps both. Batched edge loading must not let one file's
	// reconciliation see or close another's edges.
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nno links now');
	await writeFile(join(dir, 'b.md'), '---\ntype: note\n---\n[[c]] and [[a]] still');
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.edgesClosed).toBe(1);
	const rows = await client.execute(
		'SELECT s.uri AS src, t.uri AS dst FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes t ON t.id = e.dst ORDER BY t.uri',
	);
	expect(rows.rows.map((r) => `${String(r.src).slice(-4)}->${String(r.dst).slice(-4)}`)).toEqual([
		'b.md->a.md',
		'b.md->c.md',
	]);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: pruning two connected nodes closes the shared edge exactly once', async () => {
	// The edge is incident to BOTH pruned nodes. Loading incident edges per node lazily hid this;
	// batching them up front surfaces the same id twice, so it must be de-duplicated.
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\n---\n[[b]]',
		'b.md': '---\ntype: note\n---\nleaf',
		'keep.md': '---\ntype: note\n---\nunrelated',
	});
	await ingestDir({ dir, graph: g, embed });
	await rm(join(dir, 'a.md'));
	await rm(join(dir, 'b.md'));
	const res = await ingestDir({ dir, graph: g, embed, prune: true });
	expect(res.deleted).toBe(2);
	expect(res.edgesClosed).toBe(1);
	const c = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(c.rows[0]!.c)).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: tags are off by default — a #tag body stays plain node data', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\ntags: [theory]\n---\nabout #graphs' });
	const res = await ingestDir({ dir, graph: g, embed });
	expect(res.added).toBe(1);
	expect(res.edgesAdded).toBe(0);
	const rows = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'tag'");
	expect(Number(rows.rows[0]!.c)).toBe(0);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: tags option turns inline and frontmatter tags into shared tag nodes', async () => {
	const { g, client } = await graph();
	const dir = await vault({
		'a.md': '---\ntype: note\ntags: [theory]\n---\nabout #graphs',
		'b.md': '---\ntype: note\n---\nalso #graphs and #Graphs again',
	});
	const res = await ingestDir({ dir, graph: g, embed, tags: { type: 'tag' } });
	expect(res.skipped).toEqual([]);
	// a: theory + graphs, b: graphs (deduped case-insensitively) = 3 edges, 2 tag nodes
	expect(res.edgesAdded).toBe(3);
	const rows = await client.execute("SELECT uri, data FROM nodes WHERE type = 'tag' ORDER BY uri");
	expect(rows.rows.map((r) => String(r.uri))).toEqual([
		'ingest:default:tag:graphs',
		'ingest:default:tag:theory',
	]);
	expect(JSON.parse(String(rows.rows[0]!.data))).toEqual({ name: 'graphs' });
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: tags keeps `tags` in node data (it is metadata, not just topology)', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\ntags: [theory]\n---\nbody' });
	await ingestDir({ dir, graph: g, embed, tags: { type: 'tag' } });
	const rows = await client.execute("SELECT data FROM nodes WHERE type = 'note'");
	expect(JSON.parse(String(rows.rows[0]!.data)).tags).toEqual(['theory']);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: tags uses a custom rel when given', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\n#graphs' });
	await ingestDir({ dir, graph: g, embed, tags: { type: 'tag', rel: 'topic' } });
	const rows = await client.execute('SELECT rel FROM edges');
	expect(rows.rows.map((r) => String(r.rel))).toEqual(['topic']);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: removing a tag from a note closes that edge on re-ingest', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\n#graphs and #theory' });
	await ingestDir({ dir, graph: g, embed, tags: { type: 'tag' } });
	await writeFile(join(dir, 'a.md'), '---\ntype: note\n---\nonly #graphs now');
	const res = await ingestDir({ dir, graph: g, embed, tags: { type: 'tag' } });
	expect(res.edgesClosed).toBe(1);
	const c = await client.execute('SELECT COUNT(*) AS c FROM edges');
	expect(Number(c.rows[0]!.c)).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});

test('ingestDir: prune never retracts tag nodes', async () => {
	const { g, client } = await graph();
	const dir = await vault({ 'a.md': '---\ntype: note\n---\n#graphs' });
	await ingestDir({ dir, graph: g, embed, tags: { type: 'tag' } });
	const res = await ingestDir({ dir, graph: g, embed, tags: { type: 'tag' }, prune: true });
	expect(res.deleted).toBe(0);
	const c = await client.execute("SELECT COUNT(*) AS c FROM nodes WHERE type = 'tag'");
	expect(Number(c.rows[0]!.c)).toBe(1);
	await rm(dir, { recursive: true, force: true });
	client.close();
});
