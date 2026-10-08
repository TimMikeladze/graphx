/**
 * Sean Carroll's Mindscape: two public sources.
 *
 *   feed.xml    https://rss.libsyn.com/shows/604590/destinations/5264190.xml — every episode since
 *               July 2018: title, date, duration, audio, the episode intro and the guest's bio.
 *   posts.xml   https://preposterousuniverse.com/wp-sitemap-posts-post-1.xml — every episode's
 *               post on Sean's site, which holds the show notes and the transcript.
 *
 * Most feed items link to a Libsyn page, not the post, so the sitemap supplies the post. Titles
 * are regular: `241 | Tim Maudlin on Locality, Hidden Variables, and Quantum Foundations`,
 * `200 | Solo: The Philosophy of the Multiverse`, `AMA | June 2025`. There are no sponsor reads
 * or chapter outlines in the feed.
 */
import {
	Episode,
	type FeedItem,
	keyOf,
	paragraphs,
	parseFeed,
	splitGuests,
	splitTopics,
	summarySubjects,
	textOf,
	uniquePeople,
} from '../parse.ts';
import { cached, type Podcast } from './source.ts';

export const FEED_URL = 'https://rss.libsyn.com/shows/604590/destinations/5264190.xml';
export const SITE_URL = 'https://preposterousuniverse.com/podcast/';
export const SITEMAP_URL = 'https://preposterousuniverse.com/wp-sitemap-posts-post-1.xml';

export interface ParsedTitle {
	number: number | null;
	kind: Episode['kind'];
	/** Without the `241 | ` prefix. */
	title: string;
	/** The names before ` on `, for an interview. */
	guestLabel?: string;
	topics: string[];
}

/**
 *   `241 | Tim Maudlin on Locality, Hidden Variables, and Quantum Foundations`   (interview)
 *   `200 | Solo: The Philosophy of the Multiverse`  (also `Solo | …` and `Solo -- …`)
 *   `AMA | June 2025`, `Ask Me Anything | July 2024`, `Mindscape Ask Me Anything, Sean Carroll | …`
 *   `Holiday Message 2022: …`, `Bonus | …`, `Welcome to the Mindscape Podcast!`
 */
export function parseTitle(raw: string): ParsedTitle {
	const full = raw.replace(/\s+/g, ' ').trim();
	const numbered = /^(\d+)\s*\|\s*(.+)$/.exec(full);
	const number = numbered ? Number(numbered[1]) : null;
	const title = numbered ? (numbered[2] as string) : full;

	if (/\b(?:AMA|Ask Me Anything)\b/.test(full)) return { number, kind: 'ama', title, topics: [] };
	if (/^Welcome to\b/i.test(full)) return { number, kind: 'announcement', title, topics: [] };
	if (/^(?:Holiday Message|Bonus)\b/i.test(full)) {
		const rest = /^[^:|]+[:|]\s*(.+)$/.exec(title)?.[1];
		return { number, kind: 'bonus', title, topics: rest ? splitTopics(rest) : [] };
	}
	const solo = /^Solo\s*(?::|\||--|–|—)\s*(.+)$/.exec(title);
	if (solo) return { number, kind: 'solo', title, topics: splitTopics(solo[1] as string) };

	const on = title.indexOf(' on ');
	if (on > 0) {
		return {
			number,
			kind: 'interview',
			title,
			guestLabel: title.slice(0, on).trim(),
			topics: splitTopics(title.slice(on + 4)),
		};
	}
	// `Niayesh Afshordi and Phil Halper`: names only, no topics.
	const names = splitGuests(title);
	const named = names.every((n) => /^(?:[A-Z][\p{L}.'’-]*\s+)+[A-Z][\p{L}'’-]+$/u.test(n));
	return named
		? { number, kind: 'interview', title, guestLabel: title, topics: [] }
		: { number, kind: 'interview', title, topics: [] };
}

/**
 * Mindscape guests who share a name with a different person on another show, by `keyOf`. People
 * are shared across shows by name, so a homonym needs a name of its own here.
 */
export const HOMONYMS: Record<string, string> = {
	// The philosopher of technology, not the jiu-jitsu coach on Lex Fridman.
	'john danaher': 'John Danaher (philosopher)',
};

/** Boilerplate paragraphs: the Patreon pitch and the blog-post link. */
const BOILERPLATE = /^(?:Support Mindscape|Blog post with|S?upport Mindscape)/i;

/** The opening paragraph: the episode intro, before the boilerplate and the guest's bio. */
export function parseSummary(description: string): string {
	const first = paragraphs(description)
		.map((p) => textOf(p).replace(/\n/g, ' '))
		.find((t) => t && !BOILERPLATE.test(t));
	return first ?? '';
}

/**
 * The guest's bio paragraph (`Tim Maudlin received his Ph.D. … He is currently a professor of
 * philosophy at New York University.`) as a one-liner: the "is currently …" clause when there is
 * one, else the first sentence.
 */
export function parseTagline(description: string, guest: string): string | undefined {
	const surname = guest.split(/\s+/).at(-1) as string;
	const bio = paragraphs(description)
		.map((p) => textOf(p).replace(/\n/g, ' '))
		.find((t) => t.startsWith(guest) || t.startsWith(surname));
	if (!bio) return undefined;
	const sentences = bio.split(/(?<=[a-z)]\.)\s+(?=[A-Z])/);
	const current = sentences
		.map(
			(s) => /^(?:He|She|They)\s+(?:is|are)\s+(?:currently\s+)?(?:an?\s+)?(.+?)\.?$/.exec(s)?.[1],
		)
		.find(Boolean);
	const line = current
		? current.charAt(0).toUpperCase() + current.slice(1)
		: (sentences[0] as string).replace(/\.$/, '');
	return line.length > 140 ? `${line.slice(0, 139).replace(/[\s,;]+\S*$/, '')}…` : line;
}

/** The episode posts in the site's sitemap: `https://preposterousuniverse.com/podcast/2023/06/26/241-…`. */
export function parseSitemap(xml: string): string[] {
	return [...xml.matchAll(/<loc>([^<]+\/podcast\/\d{4}\/[^<]+)<\/loc>/g)].map((m) =>
		(m[1] as string).replace(/\/$/, ''),
	);
}

/**
 * The episode's post among `posts`: the one with the item's own slug, else the one whose slug
 * starts with the episode's number (`241-…`, `episode-27-…` in 2018, `x-150-…`), nearest in date
 * when two do. Undefined when no post is the episode's.
 */
export function blogPostOf(
	item: Pick<FeedItem, 'slug' | 'publishedAt'>,
	number: number | null,
	posts: string[],
): string | undefined {
	const slugOf = (u: string) => u.split('/').at(-1) as string;
	const same = posts.find((u) => slugOf(u) === item.slug);
	if (same || number === null) return same;
	const own = new RegExp(`^(?:episode-|x-)?${number}-`);
	const at = Date.parse(item.publishedAt);
	return posts
		.filter((u) => own.test(slugOf(u)))
		.sort((a, b) => Math.abs(postDay(a) - at) - Math.abs(postDay(b) - at))[0];
}

/** The day in a post's path: `…/podcast/2023/06/26/…` → that midnight, UTC. */
const postDay = (u: string) => Date.parse(u.split('/').slice(-4, -1).join('-'));

/**
 * Episodes whose post `blogPostOf` could not find — a renumbered episode (`232-…` in the feed,
 * `231-…` on the site) or a renamed AMA (`ama-may-2022`, posted as `ama-may-2020-2`) — take the
 * one post no other episode claimed that went up within a day of them.
 */
function linkLeftovers(episodes: Episode[], posts: string[]): void {
	const claimed = new Set(episodes.map((e) => e.transcriptUrl));
	for (const e of episodes) {
		if (e.transcriptUrl) continue;
		const at = Date.parse(e.publishedAt);
		const near = posts.filter((u) => !claimed.has(u) && Math.abs(postDay(u) - at) <= 86_400_000);
		if (near.length !== 1) continue;
		e.url = e.transcriptUrl = near[0] as string;
		claimed.add(near[0]);
	}
}

/** One `Episode` per feed item, oldest first, linked to its post when `posts` has it. */
export function parseEpisodes(feed: FeedItem[], posts: string[] = []): Episode[] {
	const episodes = feed
		.map((item): Episode => {
			const t = parseTitle(item.title);
			const summary = parseSummary(item.description);
			let guests = t.guestLabel ? splitGuests(t.guestLabel) : [];
			// A one-word label ("Daniels") is a group; the bio paragraph introduces the people.
			if (guests.length === 1 && !/\s/.test(guests[0] as string)) {
				const text = paragraphs(item.description).map((p) => textOf(p).replace(/\n/g, ' '));
				const subjects = summarySubjects(text.join(' '));
				if (subjects.length) guests = subjects;
			}
			guests = uniquePeople(guests);
			const tagline = guests.length === 1 ? parseTagline(item.description, guests[0]!) : undefined;
			guests = guests.map((g) => HOMONYMS[keyOf(g)] ?? g);
			return Episode.parse({
				podcast: 'mindscape',
				slug: item.slug,
				number: t.number,
				kind: t.kind,
				title: t.title,
				guests,
				tagline,
				topics: t.topics,
				publishedAt: item.publishedAt,
				durationSec: item.durationSec,
				url: blogPostOf(item, t.number, posts) ?? item.url,
				transcriptUrl: blogPostOf(item, t.number, posts),
				audioUrl: item.audioUrl,
				summary,
				sponsors: [],
				chapters: [],
			});
		})
		.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
	linkLeftovers(episodes, posts);
	return episodes;
}

export const mindscape: Podcast = {
	key: 'mindscape',
	name: "Sean Carroll's Mindscape",
	short: 'Mindscape',
	host: 'Sean Carroll',
	url: SITE_URL,
	image:
		'https://static.libsyn.com/p/assets/b/0/6/d/b06d098337897af116c3140a3186d450/21d641ef836c48dff270cbede4360d187bdd6c56cb126be7d6f51078db34d4675527fa72e13c86bb573ec42c5d4fc493e18e7d95fec734ec77168fc379baefcf.jpeg',
	sources: [FEED_URL, SITEMAP_URL],
	async scrape(dir, { offline }) {
		const feed = parseFeed(await cached(dir, 'feed.xml', FEED_URL, offline));
		const posts = parseSitemap(await cached(dir, 'posts.xml', SITEMAP_URL, offline));
		const episodes = parseEpisodes(feed, posts);
		const linked = new Set(episodes.map((e) => e.transcriptUrl));
		const unlinked = posts.filter((u) => !linked.has(u));
		if (unlinked.length)
			console.log(`[mindscape] posts matching no episode: ${unlinked.join(', ')}`);
		return episodes;
	},
};
