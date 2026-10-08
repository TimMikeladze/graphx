/**
 * The Lex Fridman Podcast parsers against real markup (`fixtures/lex/`): the feed across every era
 * of its format, the podcast page, and the episode the feed dropped.
 */
import { expect, test } from 'bun:test';
import { lexEpisodes as episodes, lexFeed as feed, lexPage as page } from './fixtures.ts';
import { type Episode, splitGuests, splitTopics, summarySubjects } from './parse.ts';
import { numberEarlyEpisodes, orphansOf, parseTitle } from './podcasts/lex.ts';

const bySlug = (slug: string) => episodes.find((e) => e.slug === slug) as Episode;

test('parses every title shape', () => {
	expect(parseTitle('Max Tegmark: Life 3.0')).toMatchObject({
		number: null,
		guestLabel: 'Max Tegmark',
		topics: ['Life 3.0'],
	});
	expect(parseTitle('#252 &#8211; Elon Musk: SpaceX, Mars, and AI')).toMatchObject({
		number: 252,
		guestLabel: 'Elon Musk',
		topics: ['SpaceX', 'Mars', 'AI'],
	});
	// Guest trails the topics; the page's name strips it.
	expect(
		parseTitle(
			'#488 – Infinity, Gödel Incompleteness & the Multiverse – Joel David Hamkins',
			'Joel David Hamkins',
		).topics,
	).toEqual(['Infinity', 'Gödel Incompleteness', 'the Multiverse']);
	expect(parseTitle('#450 – Bernie Sanders Interview').topics).toEqual([]);
	expect(parseTitle('Lex Solo #2 – The Future of Neuralink').kind).toBe('solo');
});

test('splits guests and topics without breaking phrases', () => {
	expect(splitGuests('Georges St-Pierre, John Danaher, and Gordon Ryan')).toEqual([
		'Georges St-Pierre',
		'John Danaher',
		'Gordon Ryan',
	]);
	expect(splitGuests('Luís and João Batalha')).toEqual(['Luís Batalha', 'João Batalha']);
	expect(splitTopics('Thinking Fast and Slow, Deep Learning, and AI')).toEqual([
		'Thinking Fast and Slow',
		'Deep Learning',
		'AI',
	]);
	expect(
		summarySubjects(
			'Ben Shapiro is a commentator. Steven Bonnell, aka Destiny, is a streamer. This debate was long.',
		),
	).toEqual(['Ben Shapiro', 'Steven Bonnell']);
});

test('joins feed and page, including the episode the feed dropped', () => {
	expect(episodes).toHaveLength(19);
	expect(orphansOf(feed, page).map((p) => p.slug)).toEqual(['kate-darling']);
	expect(bySlug('kate-darling')).toMatchObject({ number: 98, guests: ['Kate Darling'] });

	// Guests from the page when the title has none; from the summary when the page names a group.
	expect(bySlug('deepseek-dylan-patel-nathan-lambert').guests).toEqual([
		'Dylan Patel',
		'Nathan Lambert',
	]);
	expect(bySlug('cursor-team').guests).toEqual([
		'Aman Sanger',
		'Arvid Lunnemark',
		'Michael Truell',
		'Sualeh Asif',
	]);
	expect(bySlug('ben-shapiro-destiny-debate').guests).toEqual(['Ben Shapiro', 'Destiny']);

	// Sponsors in all three formats, and the outline.
	const khabib = bySlug('khabib-nurmagomedov');
	expect(khabib.sponsors).toEqual(['Wispr Flow', 'LMNT', 'Shopify', 'BetterHelp', 'Perplexity']);
	expect(khabib.chapters[0]).toEqual({ startSec: 0, title: 'Introduction' });
	expect(khabib.chapters.at(-1)?.startSec).toBe(3 * 3600 + 8 * 60 + 46);
	expect(khabib.summary).toStartWith('Khabib Nurmagomedov is one of the greatest fighters');
	expect(khabib.summary).not.toContain('sponsors');
	expect(bySlug('michael-malice-7').sponsors).toContain('Policygenius');
	expect(bySlug('nick-bostrom').sponsors).toEqual(['Cash App']);
	expect(bySlug('vitalik-buterin').sponsors).toEqual(['ExpressVPN', 'MasterClass']);
});

test('numbers the early episodes only when the count fits', () => {
	const ep = (n: number | null, d: string): Episode =>
		({ number: n, kind: 'interview', publishedAt: d }) as Episode;
	const fits = numberEarlyEpisodes([ep(null, '1'), ep(null, '2'), ep(3, '3')]);
	expect(fits.map((e) => e.number)).toEqual([1, 2, 3]);
	const gap = numberEarlyEpisodes([ep(null, '1'), ep(5, '2')]);
	expect(gap.map((e) => e.number)).toEqual([null, 5]);
});
