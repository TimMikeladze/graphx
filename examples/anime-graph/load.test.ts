/**
 * The loader against a 50-entry slice of a real release (`fixtures/sample.json`: a Gundam
 * franchise walk plus ten unrelated titles), not the 62 MB download.
 */
import { expect, test } from 'bun:test';
import { diff, Graph, hashEmbed, init, match } from 'graphx';
import { openMemoryDb } from 'graphx/local';
import { identityOf, parseSource, planRelease, type Release } from './dataset.ts';
import { lastUpdateOf } from './download.ts';
import { animeSchema } from './graphx.config.ts';
import { readRelease, syncPlan } from './load.ts';

const release = await readRelease(new URL('./fixtures/sample.json', import.meta.url).pathname);
const embedder = hashEmbed(64);

async function fresh() {
	const db = await openMemoryDb();
	await init(db, embedder);
	return db;
}

test('parses every site the release links to, including ANN query-string ids', () => {
	expect(parseSource('https://myanimelist.net/anime/51478')).toEqual({
		field: 'malId',
		id: '51478',
	});
	expect(parseSource('https://animenewsnetwork.com/encyclopedia/anime.php?id=25117')).toEqual({
		field: 'annId',
		id: '25117',
	});
	expect(parseSource('https://anime-planet.com/anime/cowboy-bebop')?.id).toBe('cowboy-bebop');
	expect(parseSource('https://example.com/anime/1')).toBeNull();
});

test('identity prefers MAL, then AniList, then the first source', () => {
	const mal = 'https://myanimelist.net/anime/1';
	const al = 'https://anilist.co/anime/2';
	const kitsu = 'https://kitsu.app/anime/3';
	expect(identityOf({ sources: [al, kitsu, mal] })).toBe(mal);
	expect(identityOf({ sources: [kitsu, al] })).toBe(al);
	expect(identityOf({ sources: [kitsu] })).toBe(kitsu);
});

test('reads lastUpdate from the head of a release file', () => {
	expect(lastUpdateOf('{"$schema":"x","lastUpdate":"2026-07-04","data":[')).toBe('2026-07-04');
	expect(lastUpdateOf('{"data":[')).toBeNull();
});

test('plans one node per entry, deduped relations, and counts unresolved urls', () => {
	const plan = planRelease(release);
	expect(plan.nodes.filter((n) => n.type === 'anime')).toHaveLength(release.data.length);
	expect(plan.nodes.filter((n) => n.type === 'dataset')).toHaveLength(1);
	const keys = plan.edges.map((e) => `${e.rel}|${e.src}|${e.dst}`);
	expect(new Set(keys).size).toBe(keys.length);
	expect(plan.edges.some((e) => e.src === e.dst)).toBe(false);
	// A slice of the franchise: most of its relations point at entries outside the slice.
	expect(plan.unresolved.urls).toBeGreaterThan(0);
	expect(plan.edges.filter((e) => e.rel === 'relatedTo').length).toBeGreaterThan(20);
});

test('loads into a graph that match() and hybridRetrieve can read', async () => {
	const db = await fresh();
	const stats = await syncPlan(db, planRelease(release), { embedder });
	expect(stats.nodes.inserted).toBe(
		stats.types.anime! + stats.types.studio! + stats.types.producer! + stats.types.tag! + 1,
	);

	const rows = await (
		await match(animeSchema, db)
			.node('a', 'anime')
			.out('animatedBy')
			.node('s', 'studio')
			.where('s', 'name', 'sunrise inc.')
			.select('a', 's')
	).run();
	expect(rows.map((r) => r.a.data.title)).toContain('Kidou Senshi Gundam');

	const g = new Graph(db, animeSchema, { embedder });
	const hits = await g.hybridRetrieve({ query: 'Gundam Thunderbolt', k: 5, maxDepth: 0 });
	expect(String((hits[0]?.data as { title?: string })?.title)).toContain('Thunderbolt');
	db.close();
});

test('is idempotent, and a changed release becomes updates, inserts and retractions', async () => {
	const db = await fresh();
	await syncPlan(db, planRelease(release), { embedder });

	const again = await syncPlan(db, planRelease(release), { embedder });
	expect(again.nodes).toMatchObject({ inserted: 0, updated: 0, retracted: 0 });
	expect(again.edges).toMatchObject({ inserted: 0, retracted: 0 });

	// Next week: one entry re-scored, one dropped, one gains a MAL url it did not have.
	const next = structuredClone(release) as Release;
	const [changed, dropped] = [next.data[0]!, next.data[1]!];
	changed.episodes += 1;
	next.data = next.data.filter((e) => e !== dropped);
	const noMal = next.data.find((e) => !e.sources.some((s) => s.includes('myanimelist')));
	noMal?.sources.push('https://myanimelist.net/anime/999999999');
	next.lastUpdate = '2099-01-01';

	const before = Date.now();
	const stats = await syncPlan(db, planRelease(next), { embedder });
	expect(stats.nodes.inserted).toBe(0); // the re-keyed entry kept its node
	// The dropped entry, plus any tag or studio only it used.
	expect(stats.nodes.retracted).toBeGreaterThanOrEqual(1);
	expect(stats.nodes.updated).toBe(noMal ? 3 : 2); // changed + dataset (+ re-keyed)

	const d = await diff(db, before - 1, Date.now());
	const titles = d.nodes.map((n) => JSON.parse(String(n.data)).title);
	expect(titles).toContain(changed.title);
	expect(titles).toContain(dropped.title);
	db.close();
});
