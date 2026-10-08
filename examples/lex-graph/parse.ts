/**
 * What every podcast source shares: the `Episode` each one scrapes into, the text helpers, the
 * name and topic splitting rules, and a plain RSS item parser. No network and no database here.
 *
 * Each show's own rules live in `podcasts/<key>.ts` (`lex.ts`, `mindscape.ts`): its title shapes,
 * where its guests and sponsors are written, which extra pages it needs.
 */
import { z } from 'zod';

export const Chapter = z.object({ startSec: z.number().int().nonnegative(), title: z.string() });

export const Episode = z.object({
	/** The show's key in `podcasts/index.ts`: `lex`, `mindscape`. */
	podcast: z.string(),
	/** Unique within its podcast: the last path segment of the episode's page. */
	slug: z.string(),
	/** The show's own episode number; null for unnumbered episodes, AMAs, bonuses. */
	number: z.number().int().nullable(),
	kind: z.enum(['interview', 'solo', 'ama', 'announcement', 'bonus']),
	/** The title without its number prefix. */
	title: z.string(),
	guests: z.array(z.string()),
	/** A one-liner for the guest, e.g. "Prime Minister of India". */
	tagline: z.string().optional(),
	topics: z.array(z.string()),
	publishedAt: z.string(),
	durationSec: z.number().int().optional(),
	url: z.string(),
	youtubeUrl: z.string().optional(),
	transcriptUrl: z.string().optional(),
	audioUrl: z.string().optional(),
	summary: z.string(),
	sponsors: z.array(z.string()),
	chapters: z.array(Chapter),
});

export type Episode = z.infer<typeof Episode>;
export type Chapter = z.infer<typeof Chapter>;

// --- text helpers ----------------------------------------------------------------------------------

const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	hellip: '…',
	ndash: '–',
	mdash: '—',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return NAMED[e.toLowerCase()] ?? whole;
	});
}

/** Tags out, entities decoded, whitespace collapsed. `<br>` becomes a newline first. */
export function textOf(html: string): string {
	return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
		.split('\n')
		.map((l) => l.replace(/\s+/g, ' ').trim())
		.join('\n')
		.trim();
}

/**
 * The identity of a name or a topic: case, accents, quotes and a leading "the" do not make two
 * different things. `Jürgen` and `Jurgen`, `The Simulation` and `simulation` collapse.
 */
export function keyOf(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[‘’'"“”]/g, '')
		.toLowerCase()
		.replace(/^the\s+/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Sponsors differ in spacing and punctuation across years: `Sun Basket`/`Sunbasket`, `Brain.fm`. */
export function sponsorKey(name: string): string {
	return keyOf(name).replace(/[^a-z0-9]/g, '');
}

/** `https://lexfridman.com/elon-musk-4/?utm_source=rss` → `elon-musk-4`. */
export function slugOf(url: string): string {
	const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
	return path.split('/').at(-1) ?? path;
}

/** `1:22:38` / `82:38` / `4958` → seconds. */
export function parseClock(s: string): number | undefined {
	const parts = s.trim().split(':').map(Number);
	if (!parts.length || parts.some((p) => !Number.isFinite(p))) return undefined;
	return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Paragraph HTML, in order. */
export function paragraphs(html: string): string[] {
	return [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1] as string);
}

// --- names and topics ------------------------------------------------------------------------------

/**
 * `Georges St-Pierre, John Danaher & Gordon Ryan` → three names; `Luís and João Batalha` →
 * `Luís Batalha`, `João Batalha` (a lone first name borrows the last guest's surname).
 */
export function splitGuests(label: string): string[] {
	const parts = label
		.split(/\s*,\s*|\s+&\s+|\s+and\s+/)
		.map((p) => p.replace(/^and\s+/, '').trim())
		.filter(Boolean);
	if (parts.length < 2) return parts;
	const last = parts.at(-1)!.split(/\s+/);
	if (last.length < 2) return parts;
	const surname = last.at(-1)!;
	return parts.map((p) => (/\s/.test(p) ? p : `${p} ${surname}`));
}

/**
 * Names that are one person: someone who appears under a handle on one episode and a legal name
 * on another. Keyed by `keyOf` of the variant, valued by the name the graph uses.
 */
export const ALIASES: Record<string, string> = {
	'steven bonnell': 'Destiny',
};

export function canonicalPerson(name: string): string {
	return ALIASES[keyOf(name)] ?? name;
}

/** Guests in order, aliases resolved, one entry per person. */
export function uniquePeople(names: string[]): string[] {
	return [...new Map(names.map(canonicalPerson).map((g) => [keyOf(g), g])).values()];
}

const NAME = String.raw`[A-Z][\p{L}.'’-]*(?:\s+(?:[A-Z][\p{L}.'’-]*|van|von|de|da|del|der|al|bin))*`;

/**
 * The people a summary introduces: the subjects of its "X is …" / "X, Y, and Z are …" sentences,
 * with "aka" handles dropped. Used where a title names a group rather than people
 * ("Cursor Team", "Climate Change Debate", "Daniels").
 */
export function summarySubjects(summary: string): string[] {
	const names: string[] = [];
	for (const sentence of summary.split(/(?<=[.!?])\s+/)) {
		const m = /^(.+?)\s+(?:is|are|was|were)\s/.exec(
			sentence.replace(/\s*\(aka [^)]*\)|,\s*aka [^,]+,/g, ''),
		);
		if (!m) continue;
		const parts = (m[1] as string).split(/\s*,\s*(?:and\s+)?|\s+and\s+/);
		const valid = parts.every((p) => new RegExp(`^${NAME}$`, 'u').test(p) && /\s/.test(p));
		if (valid) names.push(...parts);
	}
	return [...new Set(names)];
}

/**
 * A comma list of topics: `Stalin, Putin, and the Nature of Power` → three topics. Only commas and
 * `&` split; a bare "and" stays inside its phrase ("Thinking Fast and Slow").
 */
export function splitTopics(s: string): string[] {
	return s
		.split(/\s*,\s*/)
		.flatMap((p) => p.split(/\s+&\s+/))
		.map((p) => p.replace(/^and\s+/i, '').trim())
		.filter(Boolean);
}

// --- RSS -------------------------------------------------------------------------------------------

export interface FeedItem {
	slug: string;
	title: string;
	url: string;
	publishedAt: string;
	durationSec?: number;
	audioUrl?: string;
	/** The item's HTML description. */
	description: string;
}

/** `<![CDATA[x]]>` → `x`; anything else as is. */
const uncdata = (s: string) => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');

/** Every `<item>` of an RSS feed with a link and a date. Links lose their query and trailing slash. */
export function parseFeed(xml: string): FeedItem[] {
	const items: FeedItem[] = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const it = m[1] as string;
		const tag = (name: string) => {
			const v = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(it)?.[1];
			return v === undefined ? undefined : uncdata(v);
		};
		const link = decodeEntities(tag('link') ?? '').trim();
		const pub = tag('pubDate');
		if (!link || !pub) continue;
		const url = link.replace(/\?.*$/, '').replace(/\/$/, '');
		const dur = tag('itunes:duration');
		items.push({
			slug: slugOf(url),
			title: decodeEntities(tag('title') ?? ''),
			url,
			publishedAt: new Date(pub).toISOString(),
			durationSec: dur ? parseClock(dur) : undefined,
			audioUrl: /<enclosure url="([^"]+)"/.exec(it)?.[1],
			description: tag('description') ?? '',
		});
	}
	return items;
}
