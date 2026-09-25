/**
 * Does Jev reranking find the right record more often than fused retrieval alone?
 *
 * A known-item test built from the collector's own disagreement, with no hand-written judgments:
 * two sources describe many of the same Greek figures in different words. Each query is the Greek
 * Myth API's description of a figure with its name masked out; the corpus is every Greek deity
 * greek-mythology-data describes; a hit is any corpus record carrying that figure's name. Fused
 * retrieval (`hybridRetrieve`) builds a shortlist, and `jevRerank()` reorders the same shortlist —
 * so the difference between the two rows is the reranker and nothing else.
 *
 *   TYPESAFE_API_KEY=… bun run eval-rerank.ts [--queries 171] [--shortlist 20]
 *
 * The first stage uses `hashEmbed`, a lexical embedder, so the fused row measures a keyword
 * retriever; a semantic embedder would lift it. The rerank row is what Jev adds on top.
 */
import { parseArgs } from 'node:util';
import { defineGraphSchema, Graph, hashEmbed, init, bulkLoad } from 'graphx';
import { jevRerank } from 'graphx/jev';
import { openMemoryDb } from 'graphx/local';
import { z } from 'zod';
import { loadPantheon } from './load.ts';

const { values } = parseArgs({
	options: {
		queries: { type: 'string', default: '171' },
		shortlist: { type: 'string', default: '20' },
		collector: {
			type: 'string',
			default: process.env.COLLECTOR_DB ?? '../../../pantheon-collector/pantheon_graph.db',
		},
	},
});
const QUERIES = Number(values.queries);
const SHORTLIST = Number(values.shortlist);
if (!process.env.TYPESAFE_API_KEY) throw new Error('eval-rerank: set TYPESAFE_API_KEY');

const plan = loadPantheon(values.collector as string);
const greek = plan.nodes.filter((n) => n.type === 'deity' && n.data.pantheon === 'Greek');
const corpus = greek.filter((n) => n.data.source === 'greek-mythology-data');
const names = new Set(corpus.map((n) => String(n.data.name).toLowerCase()));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const queries = greek
	.filter((n) => n.data.source === 'Greek Myth API' && n.data.description)
	.filter((n) => names.has(String(n.data.name).toLowerCase()))
	.map((n) => ({
		name: String(n.data.name).toLowerCase(),
		// The name would make it a lookup; mask it so the description has to carry the match.
		text: String(n.data.description).replace(
			new RegExp(escape(String(n.data.name)), 'gi'),
			'this figure',
		),
	}))
	.slice(0, QUERIES);

const schema = defineGraphSchema({
	nodes: {
		deity: z.object({ name: z.string(), source: z.string() }).passthrough(),
	},
	edges: {},
});
const db = await openMemoryDb();
const embedder = hashEmbed(128);
await init(db, embedder);
await bulkLoad(
	db,
	schema,
	corpus.map((n) => ({ type: 'deity' as const, data: n.data as never, body: n.body })),
	{ embedder, chunkSize: 500 },
);
const g = new Graph(db, schema, { embedder });
console.log(
	`${queries.length} queries against ${corpus.length} greek-mythology-data deities, shortlist ${SHORTLIST}\n`,
);

type Row = { name: string };
const rank = (rows: Row[], name: string) =>
	rows.findIndex((r) => r.name.toLowerCase() === name) + 1;
const fused: number[] = [];
const reranked: number[] = [];
const rerank = jevRerank();
const started = performance.now();
let calls = 0;
for (const q of queries) {
	const rows = await g.hybridRetrieve({ query: q.text, k: SHORTLIST, maxDepth: 0 });
	const shortlist = rows.slice(0, SHORTLIST);
	fused.push(
		rank(
			shortlist.map((r) => r.data as Row),
			q.name,
		),
	);
	const order = new Map((await rerank(q.text, shortlist)).map((s) => [s.id, s.score]));
	calls += shortlist.length;
	const sorted = [...shortlist].sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
	reranked.push(
		rank(
			sorted.map((r) => r.data as Row),
			q.name,
		),
	);
	process.stderr.write(`  ${fused.length}/${queries.length}\r`);
}
process.stderr.write('\n');

const at = (ranks: number[], k: number) =>
	ranks.filter((r) => r > 0 && r <= k).length / ranks.length;
const mrr = (ranks: number[]) => ranks.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / ranks.length;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
console.log(`| ${'retrieval'.padEnd(22)} | top-1 | top-3 | top-10 |   MRR |`);
console.log(`| ${'-'.repeat(22)} | ----: | ----: | -----: | ----: |`);
for (const [label, r] of [
	['fused (hybridRetrieve)', fused],
	['fused + jevRerank', reranked],
] as const) {
	console.log(
		`| ${label.padEnd(22)} | ${pct(at(r, 1))} | ${pct(at(r, 3))} | ${pct(at(r, 10))}  | ${mrr(r).toFixed(3)} |`,
	);
}
console.log(
	`\nin the shortlist at all: ${pct(at(fused, SHORTLIST))} — the ceiling for any reranker` +
		`\n${calls} Jev requests, ${((performance.now() - started) / 1000).toFixed(1)}s wall`,
);
