/**
 * Demo queries over the loaded podcast graph. Run `scrape.ts` and `load.ts` first.
 *
 *   bun run queries.ts [--guest "Sean Carroll"] [--query "…"] [--from "Carlo Rovelli" --to "Joe Rogan"]
 *                      [--asOf 2020-01-01] [--year 2024]
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { diff, getDb, Graph, init, match, pagerank, topNodes } from 'graphx';
import { embedderFor, type EpisodeData, NAMESPACE, podcastSchema } from './graphx.config.ts';
import { keyOf } from './parse.ts';
import { PODCASTS } from './podcasts/index.ts';

const { values } = parseArgs({
	options: {
		guest: { type: 'string', default: 'Sean Carroll' },
		query: { type: 'string', default: 'origin of life chemistry' },
		from: { type: 'string', default: 'Carlo Rovelli' },
		to: { type: 'string', default: 'Joe Rogan' },
		asOf: { type: 'string', default: '2020-01-01' },
		year: { type: 'string', default: '2024' },
		embedder: { type: 'string' },
		db: { type: 'string', default: join(import.meta.dir, NAMESPACE) },
	},
});

const embedder = embedderFor(values.embedder);
const db = getDb(values.db as string);
await init(db, embedder);
const g = new Graph(db, podcastSchema, { embedder });

const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 70 - s.length))}`);
const day = (iso: string) => iso.slice(0, 10);
const short = new Map(PODCASTS.map((p) => [p.key, p.short]));
const label = (e: Pick<EpisodeData, 'podcast' | 'number' | 'title' | 'publishedAt'>) =>
	`${day(e.publishedAt)}  ${short.get(e.podcast) ?? e.podcast} ${e.number ? `#${e.number} ` : ''}${e.title}`;
const tally = <T>(xs: T[]) => {
	const m = new Map<T, number>();
	for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1]);
};

async function findGuest(name: string) {
	const rows = await (
		await match(podcastSchema, db).node('p', 'person').where('p', 'key', keyOf(name)).select('p')
	).run();
	if (!rows.length) throw new Error(`no person named '${name}'`);
	return rows[0]!.p;
}

// --- 1. who came back --------------------------------------------------------------------------
heading('most appearances: person -appearedOn-> episode, any show');
const appearances = await (
	await match(podcastSchema, db)
		.node('p', 'person')
		.out('appearedOn')
		.node('e', 'episode')
		.select('p', 'e')
).run();
const byGuest = new Map<string, EpisodeData[]>();
for (const r of appearances) {
	const list = byGuest.get(r.p.data.name) ?? [];
	list.push(r.e.data);
	byGuest.set(r.p.data.name, list);
}
const regulars = [...byGuest].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
for (const [name, eps] of regulars) {
	const years = eps.map((e) => e.publishedAt.slice(0, 4)).sort();
	console.log(
		`  ${String(eps.length).padStart(2)}  ${name.padEnd(22)} ${years[0]}–${years.at(-1)}`,
	);
}
console.log(
	`${byGuest.size} guests across ${new Set(appearances.map((r) => r.e.id)).size} episodes; ` +
		`${[...byGuest.values()].filter((e) => e.length > 1).length} came back at least once`,
);

// --- 1b. where the shows meet --------------------------------------------------------------------
heading('crossovers: people with appearedOn edges into more than one podcast');
const showsOf = new Map<string, Set<string>>();
for (const [name, eps] of byGuest) showsOf.set(name, new Set(eps.map((e) => e.podcast)));
const crossovers = [...showsOf].filter(([, s]) => s.size > 1).map(([name]) => name);
for (const name of crossovers.slice(0, 8)) {
	const eps = byGuest.get(name) as EpisodeData[];
	const per = PODCASTS.map((p) => `${p.short} ×${eps.filter((e) => e.podcast === p.key).length}`);
	console.log(`  ${name.padEnd(22)} ${per.join(', ')}`);
}
console.log(`${crossovers.length} people have been a guest on more than one show`);

// --- 2. one guest: their episodes, and who else brought them up -----------------------------------
heading(`"${values.guest}": hosts, appearedOn, and mentions from other episodes`);
const guest = await findGuest(values.guest as string);
const own = (await g.neighbors(guest.id, { rels: ['appearedOn'], direction: 'forward' }))
	.map((n) => n.data as EpisodeData)
	.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
for (const show of await g.neighbors(guest.id, { rels: ['hosts'], direction: 'forward' }))
	console.log(`  hosts ${(show.data as { name: string }).name}`);
for (const e of own) console.log(`  ${label(e)}`);
const mentionedIn = await (
	await match(podcastSchema, db)
		.node('e', 'episode')
		.out('mentions')
		.node('p', 'person')
		.where('p', 'key', guest.data.key)
		.select('e')
).run();
console.log(`named in a chapter of ${mentionedIn.length} other episode(s)`);
for (const r of mentionedIn.slice(-5))
	console.log(`  ${label(r.e.data)} — ${r.e.data.guests.join(', ')}`);

// --- 3. who gets talked about ------------------------------------------------------------------
heading('most mentioned: episode -mentions-> person, by other guests');
const mentions = await (
	await match(podcastSchema, db)
		.node('e', 'episode')
		.out('mentions')
		.node('p', 'person')
		.select('p')
).run();
for (const [name, n] of tally(mentions.map((r) => r.p.data.name)).slice(0, 8)) {
	console.log(`  ${String(n).padStart(3)}  ${name}`);
}

// --- 4. search -----------------------------------------------------------------------------------
heading(`hybridRetrieve("${values.query}")  [${embedder.id}]`);
const hits = (await g.hybridRetrieve({ query: values.query as string, k: 20, maxDepth: 0 })).filter(
	(h) => h.type === 'episode',
);
for (const h of hits.slice(0, 8)) {
	const e = h.data as EpisodeData;
	console.log(
		`  ${(h.score ?? 0).toFixed(4)}  ${h.via.join('+').padEnd(10)} ${label(e)} — ${e.guests.join(', ')}`,
	);
}

// --- 5. the podcast as of a date ---------------------------------------------------------------
heading(`asOf(${values.asOf}) — the graph as it stood then`);
const then = Date.parse(values.asOf as string);
const count = async (type: 'episode' | 'person' | 'topic' | 'sponsor', t?: number) => {
	const q = match(podcastSchema, db).node('x', type);
	return (await (await (t === undefined ? q : q.asOf(t)).select('x')).run()).length;
};
for (const type of ['episode', 'person', 'topic', 'sponsor'] as const) {
	console.log(
		`  ${type.padEnd(8)} ${String(await count(type, then)).padStart(4)} then, ${String(await count(type)).padStart(4)} now`,
	);
}
const topicsThen = await (
	await match(podcastSchema, db)
		.node('e', 'episode')
		.out('about')
		.node('t', 'topic')
		.asOf(then)
		.select('t')
).run();
console.log(
	`  top topics then: ${tally(topicsThen.map((r) => r.t.data.name))
		.slice(0, 8)
		.map(([t, n]) => `${t} (${n})`)
		.join(', ')}`,
);

// --- 6. a year in review: diff over a window of valid time -------------------------------------
heading(`diff(${values.year}-01-01, ${values.year}-12-31) — what the year added`);
const y0 = Date.parse(`${values.year}-01-01`);
const y1 = Date.parse(`${Number(values.year) + 1}-01-01`);
const d = await diff(db, y0 - 1, y1 - 1);
const added = (type: string) =>
	d.nodes.filter((n) => n.type === type && Number(n.valid_from) >= y0);
const newGuests = added('person').map((n) => JSON.parse(String(n.data)).name as string);
console.log(
	`  ${added('episode').length} episodes, ${newGuests.length} first-time guests, ` +
		`${added('topic').length} new topics, ${added('sponsor').length} new sponsors`,
);
console.log(
	`  first-timers: ${newGuests.slice(0, 10).join(', ')}${newGuests.length > 10 ? ', …' : ''}`,
);
console.log(
	`  new sponsors: ${added('sponsor')
		.map((n) => JSON.parse(String(n.data)).name)
		.join(', ')}`,
);

// --- 7. degrees of separation ------------------------------------------------------------------
heading(`"${values.from}" ⇄ "${values.to}" over appearedOn + mentions + about`);
const [a, b] = [await findGuest(values.from as string), await findGuest(values.to as string)];
// Breadth-first over g.neighbors in both directions: guest — episode — guest or topic — episode — …
const prev = new Map<string, string | null>([[a.id, null]]);
let frontier = [a.id];
while (frontier.length && !prev.has(b.id)) {
	const next: string[] = [];
	for (const id of frontier) {
		const rels = ['appearedOn', 'mentions', 'about'];
		for (const n of await g.neighbors(id, { rels, direction: 'both' })) {
			if (prev.has(n.id)) continue;
			prev.set(n.id, id);
			next.push(n.id);
		}
	}
	frontier = next;
}
if (!prev.has(b.id)) console.log('  not connected');
else {
	const path: string[] = [];
	for (let id: string | null = b.id; id; id = prev.get(id) ?? null) path.unshift(id);
	for (const id of path) {
		const n = await g.getNode(id);
		if (!n) continue;
		const name = String((n.data as { name?: string }).name);
		if (n.type === 'episode') console.log(`    ↳ ${label(n.data as EpisodeData)}`);
		else console.log(`  ${n.type === 'topic' ? `topic: ${name}` : name}`);
	}
	console.log(`  ${path.length - 1} hops`);
}

// --- 8. pagerank ---------------------------------------------------------------------------------
heading('pagerank over appearedOn + mentions + about — the most central people');
await pagerank(db, { rels: ['appearedOn', 'mentions', 'about'] });
for (const row of await topNodes(db, { by: 'pagerank', type: 'person', limit: 8 })) {
	const n = await g.getNode(row.id);
	if (n)
		console.log(`  ${(row.pagerank ?? 0).toExponential(2)}  ${(n.data as { name: string }).name}`);
}

// --- 9. sponsors -------------------------------------------------------------------------------
heading('sponsors: episode -sponsoredBy-> sponsor, longest-running first');
const reads = await (
	await match(podcastSchema, db)
		.node('e', 'episode')
		.out('sponsoredBy')
		.node('s', 'sponsor')
		.select('e', 's')
).run();
const runs = new Map<string, string[]>();
for (const r of reads)
	runs.set(r.s.data.name, [...(runs.get(r.s.data.name) ?? []), r.e.data.publishedAt]);
const ranked = [...runs]
	.map(([name, dates]) => ({ name, n: dates.length, first: dates.sort()[0]!, last: dates.at(-1)! }))
	.sort((x, y) => y.n - x.n)
	.slice(0, 8);
for (const s of ranked)
	console.log(
		`  ${String(s.n).padStart(3)}  ${s.name.padEnd(18)} ${day(s.first)} → ${day(s.last)}`,
	);

db.close();
