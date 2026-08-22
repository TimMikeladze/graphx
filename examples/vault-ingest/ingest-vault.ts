/**
 * Example — ingest a markdown vault from the filesystem into a graphx graph.
 *
 * 1 file = 1 node. Links become edges. Re-runs reconcile incrementally against the
 * bitemporal store: unchanged files are skipped (no re-embed), edited files become new
 * versions, deleted files are retracted (with `prune`).
 *
 * Run it: `bun examples/vault-ingest/ingest-vault.ts`
 *
 * The demo copies `./vault` to a temp dir before mutating it, so it is re-runnable and
 * never touches the checked-in fixtures. `hashEmbed` is core's deterministic dev
 * embedder — no API key, but the vectors carry no semantics, so the retrieve step at
 * the end demonstrates plumbing, not relevance.
 */

import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
	defineGraphSchema,
	getDb,
	Graph,
	hashEmbed,
	init,
	retrieve,
} from '../../packages/core/src/index.ts';
import { ingestDir } from '../../packages/ingest/src/index.ts';

// --- Schema ------------------------------------------------------------------
//
// Node types must match what ingest resolves for each file: `frontmatter.type` if
// present, else the top-level folder name. The vault has `note/` and `person/`
// folders and no `type:` keys, so type comes from the folder. `asset` is the type
// declared below for `![[...]]` embeds that aren't themselves ingested files.
//
// Frontmatter (minus `type` and any `edgeFields` keys) is stored as node `data` and
// validated by these schemas — `.passthrough()` lets `id`/`tags` through untouched.

const SCHEMA = defineGraphSchema({
	nodes: {
		note: z.object({ title: z.string() }).passthrough(),
		person: z.object({ name: z.string() }).passthrough(),
		asset: z.object({ path: z.string() }),
	},
	edges: {
		links_to: { from: 'note', to: 'note' },
		authored_by: { from: 'note', to: 'person' },
		embeds: { from: 'note', to: ['note', 'asset'] },
	},
});

const DIM = 768;
const embed = hashEmbed(DIM);

/** Options shared by every run below — identical opts are what make re-runs reconcile. */
function opts(dir: string, graph: Graph<typeof SCHEMA>) {
	return {
		dir,
		graph,
		embed,
		// Namespaces node uris as `ingest:notes-vault:<identity>`. Reconcile and prune only
		// ever touch this source, so a second vault can share the graph safely.
		source: 'notes-vault',
		// Changing this forces a re-embed of every node even when bodies are byte-identical —
		// set it to your real model id so a model swap can't leave stale vectors behind.
		embedId: `hash:${DIM}`,
		// Frontmatter `author: "[[ada]]"` becomes a typed edge instead of node data.
		edgeFields: { author: 'authored_by' },
		// `![[diagram.png]]` has no ingested file behind it, so it becomes a metadata-only
		// asset node (path + MIME, no bytes) with an `embeds` edge pointing at it.
		assets: { type: 'asset', rel: 'embeds' },
	};
}

if (import.meta.main) {
	const work = await mkdtemp(join(tmpdir(), 'gx-vault-'));
	const dir = join(work, 'vault');
	await cp(new URL('./vault', import.meta.url).pathname, dir, { recursive: true });

	const db = getDb(join(work, 'graph'));
	await init(db, DIM);
	const graph = new Graph(db, SCHEMA);

	// --- Run 1: cold ingest ----------------------------------------------------
	const first = await ingestDir(opts(dir, graph));
	console.log('run 1 (cold):    ', first);
	// added: 4 = 3 notes + 1 person. The `diagram.png` asset node is also created, but the
	// counters track files, and an asset is a pointer rather than a file.
	// edgesAdded: 6 = 3 links_to + 2 authored_by + 1 embeds.

	// The graph is queryable immediately. Walk out from a node by uri:
	const [ada] = (await graph.listNodes({ type: 'person' })).nodes;
	const byAda = await graph.neighbors(ada!.id, { rels: ['authored_by'], direction: 'reverse' });
	console.log(
		`\nnotes authored by ${(ada!.data as { name: string }).name}:`,
		byAda.map((n) => (n.data as { title: string }).title),
	);

	// --- Run 2: nothing changed on disk ----------------------------------------
	// Every file's sha256 matches `content_hash`, so nothing is re-embedded or rewritten.
	const second = await ingestDir(opts(dir, graph));
	console.log('\nrun 2 (no-op):   ', second);

	// --- Run 3: edit one file --------------------------------------------------
	// Its body hash changes -> the node gets a new version, and its links are re-reconciled.
	// The `[[bitemporal]]` link is gone from the new body, so that edge is closed.
	await writeFile(
		join(dir, 'note', 'retrieval.md'),
		'---\ntitle: GraphRAG Retrieval\ntags: [rag]\n---\n\nSeed with a vector search, then walk the edges. Rewritten, and no longer links out.\n',
	);
	const third = await ingestDir(opts(dir, graph));
	console.log('run 3 (1 edit):  ', third);

	// --- Run 4: delete a file, with prune --------------------------------------
	// Without `prune: true` the node would linger as a stale live row. With it, the node and
	// its incident edges are retracted — but the history stays: past versions remain readable
	// via `asOf`, and re-adding the file later revives the same identity.
	await rm(join(dir, 'note', 'temporal-graphs.md'));
	const fourth = await ingestDir({ ...opts(dir, graph), prune: true });
	console.log('run 4 (1 delete):', fourth);

	// --- GraphRAG retrieve -----------------------------------------------------
	// ANN seeds from the vector index, then expands `maxDepth` hops over the live edges.
	const hits = await retrieve(db, embed, {
		query: 'how does bitemporal storage work?',
		k: 2,
		maxDepth: 1,
	});
	console.log(
		'\nretrieve (depth-ordered):',
		hits.map((h) => ({ uri: h.uri, depth: h.depth })),
	);

	db.close();
	await rm(work, { recursive: true, force: true });
}
