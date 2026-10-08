/**
 * The Mindscape parser against real feed items (`fixtures/mindscape/feed.xml`): every title shape,
 * group and names-only titles, the summary and the guest's one-liner.
 */
import { expect, test } from 'bun:test';
import { mindscapeEpisodes as episodes, mindscapeFeed, mindscapePosts } from './fixtures.ts';
import type { Episode, FeedItem } from './parse.ts';
import { parseEpisodes, parseTitle } from './podcasts/mindscape.ts';

const byNumber = (n: number) => episodes.find((e) => e.number === n) as Episode;

test('parses every title shape', () => {
	expect(
		parseTitle('241 | Tim Maudlin on Locality, Hidden Variables, and Quantum Foundations'),
	).toEqual({
		number: 241,
		kind: 'interview',
		title: 'Tim Maudlin on Locality, Hidden Variables, and Quantum Foundations',
		guestLabel: 'Tim Maudlin',
		topics: ['Locality', 'Hidden Variables', 'Quantum Foundations'],
	});
	expect(parseTitle('9 | Solo -- Why Is There Something Rather than Nothing?')).toMatchObject({
		kind: 'solo',
		topics: ['Why Is There Something Rather than Nothing?'],
	});
	expect(parseTitle('100 | Solo | Life and Its Meaning').kind).toBe('solo');
	expect(parseTitle('AMA | June 2025')).toMatchObject({ number: null, kind: 'ama', topics: [] });
	expect(parseTitle('Mindscape Ask Me Anything, Sean Carroll | September 2026').kind).toBe('ama');
	expect(parseTitle('Holiday Message 2019: On Publishing Books')).toMatchObject({
		kind: 'bonus',
		topics: ['On Publishing Books'],
	});
	expect(parseTitle('Welcome to the Mindscape Podcast!').kind).toBe('announcement');
});

test('reads people from labels, groups and names-only titles', () => {
	expect(episodes).toHaveLength(mindscapeFeed.length);
	expect(byNumber(256).guests).toEqual(['Kelly Weinersmith', 'Zach Weinersmith']);
	// "Daniels" is a duo; the bio paragraph names them.
	expect(byNumber(193).guests).toEqual(['Daniel Kwan', 'Daniel Scheinert']);
	// No " on " in the title: the names are the title.
	expect(byNumber(316)).toMatchObject({
		guests: ['Niayesh Afshordi', 'Phil Halper'],
		topics: [],
	});
	for (const e of episodes.filter((x) => x.kind !== 'interview')) expect(e.guests).toEqual([]);
});

test('keeps the intro as the summary and the bio as a one-liner', () => {
	const maudlin = byNumber(241);
	expect(maudlin.summary).toStartWith("Last year's Nobel Prize");
	expect(maudlin.summary).not.toContain('Patreon');
	expect(maudlin.tagline).toBe('Professor of philosophy at New York University');
	expect(maudlin.url).toBe(
		'https://preposterousuniverse.com/podcast/2023/06/26/241-tim-maudlin-on-locality-hidden-variables-and-quantum-foundations',
	);
	expect(maudlin.transcriptUrl).toBe(maudlin.url);
	expect(maudlin.durationSec).toBeGreaterThan(3600);
	expect(maudlin.audioUrl).toStartWith('https://');
	// Oldest first, Welcome before #1.
	expect(episodes[0]?.kind).toBe('announcement');
});

test('links every episode to its own post, including renumbered and renamed ones', () => {
	// The feed links a Libsyn page; the sitemap has the post, old `episode-N-` slugs included.
	expect(byNumber(2).url).toBe(
		'https://preposterousuniverse.com/podcast/2018/07/10/episode-2-carlo-rovelli-on-quantum-mechanics-spacetime-and-reality',
	);
	const posts = new Set(mindscapePosts);
	for (const e of episodes) expect(posts.has(e.transcriptUrl as string)).toBe(true);
	expect(new Set(episodes.map((e) => e.transcriptUrl)).size).toBe(episodes.length);

	// A post numbered differently from the feed, and an AMA posted under another month's slug, are
	// matched by the day they went up.
	const item = (slug: string, title: string, day: string): FeedItem => ({
		slug,
		title,
		url: `https://example.libsyn.com/${slug}`,
		publishedAt: `${day}T10:00:00.000Z`,
		description: '',
	});
	const [renumbered, renamed] = parseEpisodes(
		[
			item('32-naomi-oreskes-on-climate', '32 | Naomi Oreskes on Climate', '2019-02-04'),
			item('ama-may-2022', 'AMA | May 2022', '2022-05-12'),
		],
		[
			'https://preposterousuniverse.com/podcast/2019/02/04/episode-33-naomi-oreskes-on-climate',
			'https://preposterousuniverse.com/podcast/2022/05/12/ama-may-2020-2',
		],
	);
	expect(renumbered?.transcriptUrl).toEndWith('/episode-33-naomi-oreskes-on-climate');
	expect(renamed?.transcriptUrl).toEndWith('/ama-may-2020-2');
});
