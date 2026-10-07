/**
 * Demo queries over the loaded anime graph. Run `load.ts` first.
 *
 *   bun run queries.ts [--title "Kidou Senshi Gundam"] [--studio "sunrise inc."] [--query "…"]
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
	community,
	diff,
	getDb,
	Graph,
	history,
	init,
	journey,
	match,
	pagerank,
	topNodes,
} from 'graphx';
import { animeSchema, embedderFor, NAMESPACE } from './graphx.config.ts';
import { animeRerank, hasJevKey } from './rerank.ts';

const { values } = parseArgs({
	options: {
		title: { type: 'string', default: 'Kidou Senshi Gundam' },
		studio: { type: 'string', default: 'sunrise inc.' },
		query: { type: 'string', default: 'dark psychological mecha' },
		embedder: { type: 'string' },
		db: { type: 'string', default: join(import.meta.dir, NAMESPACE) },
	},
});

const embedder = embedderFor(values.embedder);
const db = getDb(values.db as string);
await init(db, embedder);
const g = new Graph(db, animeSchema, { embedder });

let t = performance.now();
const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 70 - s.length))}`);
type Anime = { title: string; type: string; year?: number; score?: number };
const label = (d: Anime) =>
	`${d.title} (${d.type}${d.year ? `, ${d.year}` : ''}${d.score ? `, ${d.score.toFixed(2)}` : ''})`;

/** Live anime nodes whose title is exactly `title`, most-related first. */
async function findAnime(title: string) {
	const rows = await (
		await match(animeSchema, db).node('a', 'anime').where('a', 'title', title).select('a')
	).run();
	if (!rows.length) throw new Error(`no anime titled '${title}'`);
	return rows[0]!.a;
}

// --- 1. franchise tree ---------------------------------------------------------------------------
heading(`franchise: relatedTo from "${values.title}"`);
const root = await findAnime(values.title as string);
const direct = await g.neighbors(root.id, { rels: ['relatedTo'], direction: 'forward' });
console.log(`${label(root.data)} — ${direct.length} direct relations`);
const reached = await journey(db, {
	start: root.id,
	from: 0,
	rels: ['relatedTo'],
	direction: 'both',
	maxDepth: 2,
	limits: { maxRows: 100_000 },
});
const byHops = new Map<number, number>();
for (const r of reached) byHops.set(r.hops, (byHops.get(r.hops) ?? 0) + 1);
console.log(
	`journey (≤2 hops, both directions): ${reached.length} titles — ${[...byHops]
		.sort(([a], [b]) => a - b)
		.map(([h, n]) => `${n} at ${h} hop${h === 1 ? '' : 's'}`)
		.join(', ')}`,
);
for (const n of direct.slice(0, 8)) console.log(`  → ${label(n.data as Anime)}`);

// --- 2. studio filmography -----------------------------------------------------------------------
heading(`filmography: anime -animatedBy-> studio "${values.studio}"`);
const films = await (
	await match(animeSchema, db)
		.node('a', 'anime')
		.out('animatedBy')
		.node('s', 'studio')
		.where('s', 'name', values.studio)
		.select('a')
).run();
const scored = films
	.map((r) => r.a.data)
	.filter((d) => d.score !== undefined && d.type === 'TV')
	.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
console.log(`${films.length} titles; top TV series by median score:`);
for (const d of scored.slice(0, 8)) console.log(`  ${label(d)}`);

// --- 3. semantic search, then the same shortlist reranked by Jev --------------------------------
heading(`hybridRetrieve("${values.query}")  [${embedder.id}]`);
const shortlist = (
	await g.hybridRetrieve({ query: values.query as string, k: 30, maxDepth: 0 })
).filter((h) => h.type === 'anime');
const show = (rows: typeof shortlist) => {
	for (const h of rows.slice(0, 8)) {
		console.log(
			`  ${(h.score ?? 0).toFixed(4)}  ${h.via.join('+').padEnd(10)} ${label(h.data as Anime)}`,
		);
	}
};
show(shortlist);

heading(`… reranked by Jev (jevRerank over the top ${shortlist.length})`);
if (!hasJevKey()) {
	console.log('  skipped — set TYPESAFE_API_KEY to rerank with Jev');
} else {
	t = performance.now();
	const order = new Map(
		(await animeRerank()(values.query as string, shortlist)).map((s) => [s.id, s.score]),
	);
	const reranked = [...shortlist]
		.filter((h) => order.has(h.id))
		.sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))
		.map((h) => ({ ...h, score: order.get(h.id) ?? 0 }));
	show(reranked);
	console.log(
		`  ${shortlist.length} Jev requests in ${((performance.now() - t) / 1000).toFixed(1)}s`,
	);
}

// --- 4. pagerank over relatedTo ------------------------------------------------------------------
heading('pagerank over relatedTo — the most central entries');
t = performance.now();
await pagerank(db, { rels: ['relatedTo'] });
console.log(`computed in ${((performance.now() - t) / 1000).toFixed(1)}s`);
const top = await topNodes(db, { by: 'pagerank', type: 'anime', limit: 10 });
for (const row of top) {
	const n = await g.getNode(row.id);
	console.log(`  ${(row.pagerank ?? 0).toExponential(2)}  ${label(n?.data as Anime)}`);
}

// --- 5. communities over relatedTo ---------------------------------------------------------------
heading('community() over relatedTo — franchises as connected groups');
t = performance.now();
const groups = await community(db, { rels: ['relatedTo'] });
const animeIds = new Set(
	(await db.execute("SELECT id FROM nodes WHERE type = 'anime'")).rows.map((r) => String(r.id)),
);
const members = new Map<number, string[]>();
for (const [id, c] of groups) {
	if (!animeIds.has(id)) continue;
	const list = members.get(c);
	if (list) list.push(id);
	else members.set(c, [id]);
}
const sizes = [...members.values()].sort((a, b) => b.length - a.length);
const multi = sizes.filter((m) => m.length > 1);
console.log(
	`${multi.length.toLocaleString()} groups of 2+ titles, ${(sizes.length - multi.length).toLocaleString()} standalone (${((performance.now() - t) / 1000).toFixed(1)}s)`,
);
for (const m of sizes.slice(0, 6)) {
	const sample = await Promise.all(m.slice(0, 3).map((id) => g.getNode(id)));
	console.log(
		`  ${String(m.length).padStart(5)}  ${sample.map((n) => (n?.data as Anime | undefined)?.title ?? '?').join(' · ')}`,
	);
}

// --- 6. what the last release changed ------------------------------------------------------------
heading('diff between the last two loads');
const versions = await history(
	db,
	(await (await match(animeSchema, db).node('d', 'dataset').select('d')).run())[0]!.d.id,
);
if (versions.length < 2) {
	console.log(
		`one load so far (release ${JSON.parse(String(versions[0]?.data)).lastUpdate}) — rerun load.ts on a newer release to see a diff`,
	);
} else {
	// load.ts writes the dataset node last, so consecutive versions of it bracket one release.
	const prev = versions.at(-2)!;
	const cur = versions.at(-1)!;
	const d = await diff(db, Number(prev.valid_from), Number(cur.valid_from));
	const opened = d.nodes.filter((n) => Number(n.valid_from) > Number(prev.valid_from));
	const openedIds = new Set(opened.map((n) => String(n.id)));
	// A version closed inside the window was superseded (its id reopens) or retracted (it does not).
	const closedRows = d.nodes.filter((n) => Number(n.valid_to) <= Number(cur.valid_from));
	const closedIds = new Set(closedRows.map((n) => String(n.id)));
	const added = opened.filter((n) => !closedIds.has(String(n.id)));
	const changed = opened.filter((n) => closedIds.has(String(n.id)));
	const closed = closedRows.filter((n) => !openedIds.has(String(n.id)));
	const anime = (xs: typeof d.nodes) => xs.filter((n) => n.type === 'anime').length;
	console.log(
		`release ${JSON.parse(String(prev.data)).lastUpdate} → ${JSON.parse(String(cur.data)).lastUpdate}: ` +
			`${anime(added)} anime added, ${anime(changed)} changed, ${anime(closed)} retracted; ` +
			`${d.edges.length} edge versions moved`,
	);
	for (const n of added.filter((n) => n.type === 'anime').slice(0, 8)) {
		console.log(`  + ${label(JSON.parse(String(n.data)))}`);
	}
}

db.close();
