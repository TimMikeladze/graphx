/**
 * The Lex Fridman Podcast: two public sources joined into one `Episode` per conversation.
 *
 *   feed.xml      https://lexfridman.com/feed/podcast/ — every episode since 2018: title, date,
 *                 duration, audio, and a description holding sponsors and the chapter outline.
 *   podcast.html  https://lexfridman.com/podcast/ — the episode list: guest name(s) as Lex's site
 *                 spells them, a one-line tagline, and the YouTube link.
 *
 * The two are joined on the episode's slug (`lexfridman.com/<slug>`). The feed is the spine; the
 * page adds guests for titles that do not lead with a name (`#459 – DeepSeek, China, …`). A couple
 * of early episodes are on the page but gone from the feed; each is recovered from the Wayback
 * Machine's copy of its post, else from its YouTube page (`recovered.json`).
 */
import {
	type Chapter,
	decodeEntities,
	Episode,
	escapeRe,
	type FeedItem,
	keyOf,
	paragraphs,
	parseClock,
	parseFeed,
	slugOf,
	sponsorKey,
	splitGuests,
	splitTopics,
	summarySubjects,
	textOf,
	uniquePeople,
} from '../parse.ts';
import { cached, fetchText, type Podcast } from './source.ts';

export const FEED_URL = 'https://lexfridman.com/feed/podcast/';
export const PAGE_URL = 'https://lexfridman.com/podcast/';

// --- titles ----------------------------------------------------------------------------------------

export interface ParsedTitle {
	number: number | null;
	kind: Episode['kind'];
	/** Without the `#123 – ` prefix. */
	title: string;
	/** The name prefix before the first colon, when the title has one. */
	guestLabel?: string;
	topics: string[];
}

/**
 * Four shapes across eight years:
 *   `Max Tegmark: Life 3.0`                                      (2018–19, no number)
 *   `#252 – Elon Musk: SpaceX, Mars, Tesla Autopilot, …`         (guest, colon, topics)
 *   `#459 – DeepSeek, China, OpenAI, NVIDIA, …`                  (topics only; guests on the page)
 *   `#488 – Infinity, Paradoxes … & the Multiverse – Joel David Hamkins` (guest trailing)
 * plus `Lex Solo #3 – …`, an AMA, and the 2020 rename announcement.
 * `knownGuest` is the page's name for this episode, used to strip it from the title.
 */
export function parseTitle(raw: string, knownGuest?: string): ParsedTitle {
	const full = decodeEntities(raw).replace(/\s+/g, ' ').trim();
	const numbered = /^#(\d+)\s*[–—-]\s*(.+)$/.exec(full);
	const number = numbered ? Number(numbered[1]) : null;
	const title = numbered ? (numbered[2] as string) : full;

	let kind: Episode['kind'] = 'interview';
	if (/^Lex Solo\b/i.test(full)) kind = 'solo';
	else if (/Ask Me Anything/i.test(full)) kind = 'ama';
	else if (/^New Name:/i.test(full)) kind = 'announcement';
	if (kind !== 'interview') return { number, kind, title, topics: [] };

	let rest = title;
	if (knownGuest) {
		const trailing = new RegExp(`\\s+[–—-]\\s+${escapeRe(knownGuest)}$`);
		rest = rest.replace(trailing, '');
	}
	const colon = rest.indexOf(': ');
	if (colon > 0) {
		return {
			number,
			kind,
			title,
			guestLabel: rest.slice(0, colon).trim(),
			topics: splitTopics(rest.slice(colon + 2)),
		};
	}
	// No colon and no list ("Bernie Sanders Interview"): a title, not topics.
	return { number, kind, title, topics: rest.includes(',') ? splitTopics(rest) : [] };
}

// --- the feed description --------------------------------------------------------------------------

const SUMMARY_CUT =
	/\s*(Please support this podcast|Support this podcast|Thank you for listening|Check out our sponsors|This conversation is part of|Video version is available|If you would like to get more information|This episode is (?:presented|sponsored|brought))[\s\S]*$/i;

/** The opening paragraph, minus the sponsor pitch and boilerplate that follow the guest's intro. */
export function parseSummary(description: string): string {
	const first = paragraphs(description)[0] ?? '';
	return textOf(first).replace(/\n/g, ' ').replace(SUMMARY_CUT, '').trim();
}

/** Bold section headings that sit in sponsor paragraphs but are not sponsors. */
const HEADING =
	/^(?:sponsors?|sponsor details|outline|episode links|podcast info|contact lex|support & connect|transcript|feedback|ama|hiring|other)$/i;

/**
 * Three eras of sponsor reads:
 *   `<b>SPONSORS:</b> … <b>Wispr Flow:</b> AI-powered voice dictation app.`   (2023–)
 *   `sponsors:<br /> – <b>Policygenius</b>: https://…`                       (2020–23)
 *   `sponsors:<br /> – Cash App – use code "LexPodcast" …`                    (2019–20)
 */
export function parseSponsors(description: string): string[] {
	const names: string[] = [];
	for (const p of paragraphs(description)) {
		if (!/sponsor/i.test(p) || /sponsors above/i.test(p)) continue;
		const bold = [...p.matchAll(/<b>([\s\S]*?)<\/b>/g)]
			.map((m) => textOf(m[1] as string).replace(/:\s*$/, ''))
			.filter((n) => n && !HEADING.test(n) && n.length < 40);
		if (bold.length) {
			names.push(...bold);
			continue;
		}
		// Unbolded: one sponsor per "– Name – …" or "– Name: …" line.
		for (const line of textOf(p).split('\n')) {
			const m = /^[–—-]\s*(.+?)\s*(?:[–—:(,]|\sat\s|$)/.exec(line);
			const name = m?.[1]
				?.replace(/^(?:get|sign up (?:to|for)|download|go to|visit)\s+/i, '')
				.trim();
			if (name && !/^https?$/i.test(name) && name.length < 40) names.push(name);
		}
	}
	const seen = new Set<string>();
	return names.filter((n) => {
		const k = sponsorKey(n);
		return k && !seen.has(k) && seen.add(k);
	});
}

/** `(1:06:04) – Street fights in Dagestan` lines after `OUTLINE:`. */
export function parseChapters(description: string): Chapter[] {
	const at = description.search(/OUTLINE:/);
	if (at < 0) return [];
	const chapters: Chapter[] = [];
	for (const line of textOf(description.slice(at)).split('\n')) {
		const m = /^\(?(\d{1,2}:\d{2}(?::\d{2})?)\)?\s*[–—-]\s*(.+)$/.exec(line);
		if (!m) continue;
		const startSec = parseClock(m[1] as string);
		if (startSec !== undefined) chapters.push({ startSec, title: (m[2] as string).trim() });
	}
	return chapters;
}

// --- the podcast page ------------------------------------------------------------------------------

export interface PageEntry {
	slug: string;
	/** The list's own title, e.g. `Kate Darling: Social Robotics`. */
	title?: string;
	person?: string;
	tagline?: string;
	youtubeUrl?: string;
	transcriptUrl?: string;
}

export function parsePage(html: string): PageEntry[] {
	const entries: PageEntry[] = [];
	const blocks = html.split('<div class="episode-item">').slice(1);
	for (const block of blocks) {
		const span = (cls: string) => {
			const m = new RegExp(`<span class="${cls}">([\\s\\S]*?)</span>`).exec(block);
			return m ? textOf(m[1] as string) || undefined : undefined;
		};
		const episode = /<a href="([^"]+)">Episode<\/a>/.exec(block)?.[1];
		if (!episode) continue;
		const title = /<div class="episode-title">\s*<a [^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
		entries.push({
			slug: slugOf(episode),
			title: title ? textOf(title) : undefined,
			person: span('ep-person'),
			tagline: span('ep-tagline'),
			youtubeUrl: /<a href="(https:\/\/www\.youtube\.com\/[^"]+)">YouTube<\/a>/.exec(block)?.[1],
			transcriptUrl: /<a href="([^"]+)">\s*Transcript<\/a>/.exec(block)?.[1],
		});
	}
	return entries;
}

// --- the join --------------------------------------------------------------------------------------

/**
 * Page entries the feed no longer carries: a couple of early episodes whose WordPress posts were
 * taken down but stay on the list and on YouTube. `scrape` recovers each as a feed item, from
 * an archived copy of the post or, failing that, from the video.
 */
export function orphansOf(feed: FeedItem[], page: PageEntry[]): PageEntry[] {
	const slugs = new Set(feed.map((f) => f.slug));
	return page.filter((p) => !slugs.has(p.slug) && p.title && p.youtubeUrl);
}

/**
 * A Wayback Machine copy of an episode's WordPress post, as the feed item it once was. Null when
 * the snapshot is not that post (a redirect to another slug, a 404 page).
 */
export function parseArchivedPost(html: string, slug: string): FeedItem | null {
	const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
	if (canonical && slugOf(canonical) !== slug) return null;
	const title = /<h1 class="entry-title">([\s\S]*?)<\/h1>/.exec(html)?.[1];
	const published = /<meta property="article:published_time" content="([^"]+)"/.exec(html)?.[1];
	if (!title || !published) return null;
	const body = /<div class="entry-content">([\s\S]*?)<\/div><!-- \.entry-content -->/.exec(
		html,
	)?.[1];
	return {
		slug,
		title: textOf(title),
		url: `https://lexfridman.com/${slug}`,
		publishedAt: new Date(published).toISOString(),
		audioUrl: /<source type="audio\/mpeg" src="([^"?]+)/.exec(html)?.[1],
		// The post body minus the player's own "Podcast: Play in new window" paragraph.
		description: (body ?? '').replace(/<p class="powerpress_links[\s\S]*?<\/p>/g, ''),
	};
}

/**
 * A YouTube watch page as a feed item: its upload date, length and, from a title like
 * `Kate Darling: Social Robotics | Lex Fridman Podcast #98`, the episode number.
 */
export function parseVideoPage(html: string, entry: PageEntry): FeedItem | null {
	const date = /"uploadDate":"([^"]+)"/.exec(html)?.[1];
	if (!date) return null;
	const len = /"lengthSeconds":"(\d+)"/.exec(html)?.[1];
	const videoTitle = decodeEntities(/<meta name="title" content="([^"]+)"/.exec(html)?.[1] ?? '');
	const number = /Podcast #(\d+)\s*$/.exec(videoTitle)?.[1];
	return {
		slug: entry.slug,
		title: number ? `#${number} – ${entry.title}` : (entry.title as string),
		url: `https://lexfridman.com/${entry.slug}`,
		publishedAt: new Date(date).toISOString(),
		durationSec: len ? Number(len) : undefined,
		description: '',
	};
}

/**
 * One `Episode` per feed item, oldest first, enriched with its page entry when the page lists it.
 * Guests: the page's names when it has them, else the title's name prefix, else none.
 */
export function joinSources(feed: FeedItem[], page: PageEntry[]): Episode[] {
	const bySlug = new Map(page.map((e) => [e.slug, e]));
	const episodes = feed.map((item): Episode => {
		const entry = bySlug.get(item.slug);
		const t = parseTitle(item.title, entry?.person);
		const label = entry?.person ?? t.guestLabel;
		const summary = parseSummary(item.description);
		let guests = t.kind === 'interview' && label ? splitGuests(label) : [];
		// A group label ("Cursor Team", "Iran War Debate", "FFmpeg and VLC") names no people; the
		// summary introduces them instead.
		const subjects = summarySubjects(summary);
		const subjectKeys = new Set(subjects.map(keyOf));
		const isGroup =
			guests.some((g) => /\b(?:Debate|Team)$/.test(g)) ||
			(guests.length > 1 && !guests.some((g) => subjectKeys.has(keyOf(g))));
		if (isGroup && subjects.length) guests = subjects;
		const transcript =
			entry?.transcriptUrl ??
			/https:\/\/lexfridman\.com\/[\w-]+-transcript/.exec(item.description)?.[0];
		return Episode.parse({
			podcast: 'lex',
			slug: item.slug,
			number: t.number,
			kind: t.kind,
			title: t.title,
			guests: uniquePeople(guests),
			tagline: entry?.tagline,
			topics: t.topics,
			publishedAt: item.publishedAt,
			durationSec: item.durationSec,
			url: item.url,
			youtubeUrl: entry?.youtubeUrl,
			transcriptUrl: transcript,
			audioUrl: item.audioUrl,
			summary,
			sponsors: parseSponsors(item.description),
			chapters: parseChapters(item.description),
		});
	});
	episodes.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
	return numberEarlyEpisodes(episodes);
}

/**
 * The feed retitled the first 71 conversations without their numbers. They were numbered in
 * release order, so when the unnumbered interviews before the first numbered one are exactly
 * `first - 1` of them, they are `#1` … `#first-1` (Max Tegmark is #1, Vladimir Vapnik's second
 * visit #71). Anything else leaves them unnumbered rather than guess.
 */
export function numberEarlyEpisodes(sorted: Episode[]): Episode[] {
	const firstAt = sorted.findIndex((e) => e.number !== null);
	if (firstAt < 0) return sorted;
	const first = sorted[firstAt]!.number as number;
	const early = sorted.slice(0, firstAt).filter((e) => e.kind === 'interview' && e.number === null);
	if (early.length !== first - 1) return sorted;
	early.forEach((e, i) => (e.number = i + 1));
	return sorted;
}

// --- the scrape ------------------------------------------------------------------------------------

/** An episode the feed dropped: its archived post if the Wayback Machine kept one, else its video. */
async function recover(entry: PageEntry): Promise<FeedItem | null> {
	// `id_` asks for the page exactly as captured, without the archive's toolbar and link rewriting.
	const archived = await fetchText(
		`https://web.archive.org/web/2020id_/https://lexfridman.com/${entry.slug}/`,
	)
		.then((html) => parseArchivedPost(html, entry.slug))
		.catch(() => null);
	return archived ?? parseVideoPage(await fetchText(entry.youtubeUrl as string), entry);
}

export const lex: Podcast = {
	key: 'lex',
	name: 'Lex Fridman Podcast',
	short: 'Lex',
	host: 'Lex Fridman',
	url: PAGE_URL,
	image: 'https://lexfridman.com/wordpress/wp-content/uploads/powerpress/artwork_3000-230.png',
	sources: [FEED_URL, PAGE_URL],
	async scrape(dir, { offline }) {
		const feed = parseFeed(await cached(dir, 'feed.xml', FEED_URL, offline));
		const page = parsePage(await cached(dir, 'podcast.html', PAGE_URL, offline));
		const recoveredFile = Bun.file(`${dir}/recovered.json`);
		const recovered: Record<string, FeedItem> = (await recoveredFile.exists())
			? await recoveredFile.json()
			: {};
		for (const orphan of orphansOf(feed, page)) {
			if (offline || recovered[orphan.slug]) continue;
			const item = await recover(orphan);
			if (item) recovered[orphan.slug] = item;
		}
		await Bun.write(recoveredFile, `${JSON.stringify(recovered, null, '\t')}\n`);
		const episodes = joinSources([...feed, ...Object.values(recovered)], page);
		const slugs = new Set(episodes.map((e) => e.slug));
		const missing = page.filter((p) => !slugs.has(p.slug));
		if (missing.length) {
			console.log(`[lex] on the page but not scraped: ${missing.map((p) => p.slug).join(', ')}`);
		}
		return episodes;
	},
};
