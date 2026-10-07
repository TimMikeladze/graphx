/**
 * Does Jev reranking put the right title first more often than fused retrieval alone?
 *
 * A known-item test: each query describes one well-known title in plain words, without any word of
 * its title, and a hit is that title. Fused retrieval (`hybridRetrieve`) builds a shortlist, and
 * `animeRerank()` reorders the same shortlist, so the difference between the two rows is the
 * reranker and nothing else. The ceiling for any reranker is "in the shortlist at all".
 *
 *   TYPESAFE_API_KEY=… bun run eval-rerank.ts [--shortlist 30] [--embedder hash|ollama|openai]
 *
 * The 20 judgments are hand-written, so this is a smoke-scale eval, not a benchmark.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getDb, Graph, init } from 'graphx';
import { animeSchema, embedderFor, NAMESPACE } from './graphx.config.ts';
import { animeRerank, hasJevKey } from './rerank.ts';

const { values } = parseArgs({
	options: {
		shortlist: { type: 'string', default: '30' },
		embedder: { type: 'string' },
		db: { type: 'string', default: join(import.meta.dir, NAMESPACE) },
	},
});
if (!hasJevKey()) throw new Error('eval-rerank: set TYPESAFE_API_KEY');
const SHORTLIST = Number(values.shortlist);

/** Query → the exact `title` it describes. */
export const JUDGMENTS: Array<[string, string]> = [
	['a student finds a notebook that kills anyone whose name is written in it', 'Death Note'],
	['humanity lives behind huge walls to hide from giants that eat people', 'Shingeki no Kyojin'],
	[
		'teenagers pilot biomechanical giants against mysterious angels, deeply depressing',
		'Shinseiki Evangelion',
	],
	[
		'a self-proclaimed mad scientist sends text messages to the past with a microwave',
		'Steins;Gate',
	],
	['bounty hunters on a spaceship, jazz soundtrack, space western', 'Cowboy Bebop'],
	[
		'a girl works in a bathhouse for spirits to save her parents who turned into pigs',
		'Sen to Chihiro no Kamikakushi',
	],
	[
		'two brothers use alchemy to get their bodies back after a failed human transmutation',
		'Fullmetal Alchemist: Brotherhood',
	],
	[
		'a wandering man studies strange primitive lifeforms that cause supernatural problems for villagers',
		'Mushishi',
	],
	[
		'police in a surveillance state measure how likely citizens are to commit crimes',
		'Psycho-Pass',
	],
	[
		'magical girls make a contract with a cute creature and it goes horribly wrong',
		'Mahou Shoujo Madoka★Magica',
	],
	[
		'child soldiers on Mars form a mercenary company with a mobile suit',
		'Kidou Senshi Gundam: Tekketsu no Orphans',
	],
	[
		'drilling through the ceiling of an underground village into a giant robot space war',
		'Tengen Toppa Gurren Lagann',
	],
	[
		'an exiled prince gains the power of absolute obedience and leads a rebellion with a mask',
		'Code Geass: Hangyaku no Lelouch',
	],
	[
		'two girls ride a kettenkrad through the ruins of a dead city at the end of the world',
		'Shoujo Shuumatsu Ryokou',
	],
	[
		'an energy-conserving high school boy solves small mysteries for the classic literature club',
		'Hyouka',
	],
	[
		'an elf mage who outlived her hero party travels again to understand humans',
		'Sousou no Frieren',
	],
	[
		'a cursed prince gets caught in a war between forest gods and an iron-making town',
		'Mononoke Hime',
	],
	['a surgeon in Germany hunts a former patient who became a serial killer', 'Monster'],
	['astronauts collect orbital garbage in the 2070s', 'Planetes'],
	[
		'an orphan girl descends a giant pit whose depths curse anyone who comes back up',
		'Made in Abyss',
	],
];

const embedder = embedderFor(values.embedder);
const db = getDb(values.db as string);
await init(db, embedder);
const g = new Graph(db, animeSchema, { embedder });
const rerank = animeRerank();

type Row = { id: string; title: string };
const rank = (rows: Row[], title: string) => rows.findIndex((r) => r.title === title) + 1;
const fused: number[] = [];
const reranked: number[] = [];
const started = performance.now();
let calls = 0;

for (const [query, title] of JUDGMENTS) {
	const hits = (await g.hybridRetrieve({ query, k: SHORTLIST, maxDepth: 0 }))
		.filter((h) => h.type === 'anime')
		.slice(0, SHORTLIST);
	const rows = hits.map((h) => ({ id: h.id, title: String((h.data as { title: string }).title) }));
	fused.push(rank(rows, title));
	const order = new Map((await rerank(query, hits)).map((s) => [s.id, s.score]));
	calls += hits.length;
	reranked.push(
		rank(
			[...rows].sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)),
			title,
		),
	);
	process.stderr.write(`  ${fused.length}/${JUDGMENTS.length}\r`);
}
process.stderr.write('\n');

const at = (ranks: number[], k: number) =>
	ranks.filter((r) => r > 0 && r <= k).length / ranks.length;
const mrr = (ranks: number[]) => ranks.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / ranks.length;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
console.log(`${JUDGMENTS.length} described titles, shortlist ${SHORTLIST}, ${embedder.id}\n`);
console.log(`| ${'retrieval'.padEnd(22)} | top-1 | top-3 | top-10 |   MRR |`);
console.log(`| ${'-'.repeat(22)} | ----: | ----: | -----: | ----: |`);
for (const [name, r] of [
	['fused (hybridRetrieve)', fused],
	['fused + jevRerank', reranked],
] as const) {
	console.log(
		`| ${name.padEnd(22)} | ${pct(at(r, 1))} | ${pct(at(r, 3))} | ${pct(at(r, 10))}  | ${mrr(r).toFixed(3)} |`,
	);
}
console.log(
	`\nin the shortlist at all: ${pct(at(fused, SHORTLIST))} — the ceiling for any reranker` +
		`\n${calls} Jev requests, ${((performance.now() - started) / 1000).toFixed(1)}s wall`,
);
db.close();
