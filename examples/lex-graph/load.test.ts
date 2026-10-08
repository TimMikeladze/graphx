/**
 * The plan and the loader over both shows' fixtures: dated nodes, people shared across shows,
 * mentions, `asOf` reads, and idempotent reloads.
 */
import { expect, test } from 'bun:test';
import { diff, Graph, hashEmbed, init, match } from 'graphx';
import { openMemoryDb } from 'graphx/local';
import { planEpisodes } from './dataset.ts';
import { episodes, lexEpisodes } from './fixtures.ts';
import { podcastSchema } from './graphx.config.ts';
import { syncPlan } from './load.ts';

const embedder = hashEmbed(64);

test('plans dated nodes and mentions across episodes', () => {
	const plan = planEpisodes(lexEpisodes);
	const musk = plan.nodes.find((n) => n.key === 'person:elon musk');
	// Valid from the first appearance, not the latest.
	expect(new Date(musk!.validFrom).toISOString().slice(0, 4)).toBe('2019');
	const mentions = plan.edges.filter((e) => e.rel === 'mentions');
	// Sam Altman's #419 chapters name Elon Musk.
	expect(
		mentions.some((e) => e.src === 'episode:lex/sam-altman-2' && e.dst === 'person:elon musk'),
	).toBe(true);
	// Never a mention of an episode's own guest.
	expect(
		mentions.some((e) => e.src === 'episode:lex/elon-musk-3' && e.dst === 'person:elon musk'),
	).toBe(false);
	const keys = plan.edges.map((e) => `${e.rel}|${e.src}|${e.dst}`);
	expect(new Set(keys).size).toBe(keys.length);
	// Only the shows that have episodes become nodes.
	expect(plan.nodes.filter((n) => n.type === 'podcast').map((n) => n.key)).toEqual(['podcast:lex']);
});

test('two shows share people, and each show has its host and its episodes', () => {
	const plan = planEpisodes(episodes);
	const shows = plan.nodes.filter((n) => n.type === 'podcast');
	expect(shows.map((n) => n.key).sort()).toEqual(['podcast:lex', 'podcast:mindscape']);
	// Mindscape started in 2018-06, before Lex's first episode in 2018-08.
	const mindscape = shows.find((n) => n.key === 'podcast:mindscape')!;
	expect(new Date(mindscape.validFrom).toISOString().slice(0, 7)).toBe('2018-07');

	const edges = (rel: string) => plan.edges.filter((e) => e.rel === rel);
	expect(
		edges('hosts')
			.map((e) => `${e.src}→${e.dst}`)
			.sort(),
	).toEqual(['person:lex fridman→podcast:lex', 'person:sean carroll→podcast:mindscape']);
	expect(edges('episodeOf')).toHaveLength(episodes.length);

	// Max Tegmark is one person with appearances on both shows.
	const tegmark = edges('appearedOn').filter((e) => e.src === 'person:max tegmark');
	expect(new Set(tegmark.map((e) => e.dst.split('/')[0]))).toEqual(
		new Set(['episode:lex', 'episode:mindscape']),
	);
	expect(plan.nodes.filter((n) => n.key === 'person:max tegmark')).toHaveLength(1);
	// Two different John Danahers: the jiu-jitsu coach on Lex, the philosopher on Mindscape.
	const danaher = edges('appearedOn').filter((e) => e.src.startsWith('person:john danaher'));
	expect(danaher.find((e) => e.dst.startsWith('episode:mindscape/'))?.src).toBe(
		'person:john danaher (philosopher)',
	);
	expect(danaher.find((e) => e.dst.startsWith('episode:lex/'))?.src).toBe('person:john danaher');
	// Same slug on two shows would still be two episodes: the key carries the show.
	expect(plan.nodes.some((n) => n.key.startsWith('episode:mindscape/'))).toBe(true);

	const dataset = plan.nodes.find((n) => n.type === 'dataset')!;
	expect((dataset.data.sources as string[]).length).toBe(4);
});

test('loads, reads as of a date, and reloads idempotently', async () => {
	const db = await openMemoryDb();
	await init(db, embedder);
	const plan = planEpisodes(episodes);
	const stats = await syncPlan(db, plan, { embedder });
	expect(stats.nodes.inserted).toBe(plan.nodes.length);

	const muskEpisodes = await (
		await match(podcastSchema, db)
			.node('p', 'person')
			.where('p', 'key', 'elon musk')
			.out('appearedOn')
			.node('e', 'episode')
			.select('e')
	).run();
	expect(muskEpisodes.length).toBeGreaterThanOrEqual(3);

	// Before 2020 only the early fixture episodes of either show existed.
	const in2019 = await (
		await match(podcastSchema, db)
			.node('e', 'episode')
			.where('e', 'podcast', 'lex')
			.asOf(Date.parse('2020-01-01'))
			.select('e')
	).run();
	expect(in2019.map((r) => r.e.data.slug).sort()).toEqual([
		'elon-musk',
		'eric-weinstein',
		'max-tegmark',
	]);

	const g = new Graph(db, podcastSchema, { embedder });
	const hits = (
		await g.hybridRetrieve({ query: 'Dagestan street fights', k: 10, maxDepth: 0 })
	).filter((h) => h.type === 'episode');
	expect(hits[0]?.data).toMatchObject({ slug: 'khabib-nurmagomedov' });
	const quantum = (
		await g.hybridRetrieve({ query: 'Bohmian mechanics hidden variables', k: 10, maxDepth: 0 })
	).filter((h) => h.type === 'episode');
	expect(quantum[0]?.data).toMatchObject({ podcast: 'mindscape', number: 241 });

	const again = await syncPlan(db, planEpisodes(episodes), { embedder });
	expect(again.nodes).toMatchObject({ inserted: 0, updated: 0, retracted: 0 });
	expect(again.edges).toMatchObject({ inserted: 0, retracted: 0 });

	// Next scrape: one episode retitled, one gone.
	const next = structuredClone(episodes);
	const lexFirst = next.find((e) => e.slug === 'max-tegmark')!;
	lexFirst.title = 'Max Tegmark: Life 3.0 (remastered)';
	const dropped = next.pop()!;
	const before = Date.now();
	const changed = await syncPlan(db, planEpisodes(next), { embedder });
	expect(changed.nodes.updated).toBeGreaterThanOrEqual(2); // the retitle + the dataset node
	expect(changed.nodes.retracted).toBeGreaterThanOrEqual(1);
	// Each write takes its own millisecond, so the run can end ahead of the wall clock.
	const d = await diff(db, before - 1, Date.now() + 60_000);
	const slugs = d.nodes.map((n) => JSON.parse(String(n.data)).slug).filter(Boolean);
	expect(slugs).toContain('max-tegmark');
	expect(slugs).toContain(dropped.slug);
	db.close();
});
