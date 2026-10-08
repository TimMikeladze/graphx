/**
 * The pure half of the loader: turn the scraped episodes of every show into the graph they should
 * become — nodes keyed by a natural key, edges keyed by `rel|src|dst`, each with the instant it
 * became true. No database here, so the plan is testable on the fixtures.
 */
import { z } from 'zod';
import { type EpisodeData, episodeText, podcastSchema } from './graphx.config.ts';
import { Episode, escapeRe, keyOf, sponsorKey } from './parse.ts';
import { type Podcast, PODCASTS } from './podcasts/index.ts';

export const Episodes = z.array(Episode);

export type NodeType = keyof typeof podcastSchema.nodes;
export type Rel = keyof typeof podcastSchema.edges;

export interface PlanNode {
	/** `podcast:<key>`, `episode:<podcast>/<slug>`, `person:<key>`, `topic:<key>`, `sponsor:<key>`, or `dataset`. */
	key: string;
	type: NodeType;
	data: Record<string, unknown>;
	body?: string;
	/** When it entered the graph: the first episode it belongs to (epoch ms). */
	validFrom: number;
}

export interface PlanEdge {
	rel: Rel;
	/** Plan keys, resolved to node ids by the loader. */
	src: string;
	dst: string;
	data?: Record<string, unknown>;
	validFrom: number;
}

export interface Plan {
	nodes: PlanNode[];
	edges: PlanEdge[];
}

/** An episode's plan key: slugs are unique within a show, not across shows. */
export const episodeKey = (ep: { podcast: string; slug: string }) =>
	`episode:${ep.podcast}/${ep.slug}`;

/**
 * A matcher for every multi-word name, so a chapter titled "Joe Rogan" or "Elon Musk and Tesla"
 * links to that person. One-word names ("Destiny", "Grimes") are too ambiguous to match.
 */
function personMatchers(people: Map<string, string>): Array<{ key: string; re: RegExp }> {
	return [...people]
		.filter(([, name]) => /\s/.test(name))
		.map(([key, name]) => ({
			key,
			re: new RegExp(`(^|[^\\p{L}])${escapeRe(name)}($|[^\\p{L}])`, 'iu'),
		}));
}

export function planEpisodes(episodes: Episode[], podcasts: Podcast[] = PODCASTS): Plan {
	const sorted = [...episodes].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
	const nodes = new Map<string, PlanNode>();
	const edges = new Map<string, PlanEdge>();
	const addEdge = (e: PlanEdge) => {
		const k = `${e.rel}|${e.src}|${e.dst}`;
		if (!edges.has(k)) edges.set(k, e);
	};
	// The first spelling of a person, topic or sponsor names its node; later episodes only link.
	const firstSeen = (key: string, type: NodeType, data: Record<string, unknown>, at: number) => {
		if (!nodes.has(key))
			nodes.set(key, { key, type, data, body: String(data.name), validFrom: at });
		return nodes.get(key) as PlanNode;
	};

	const people = new Map<string, string>();
	const person = (name: string, at: number) => {
		const key = keyOf(name);
		const node = firstSeen(`person:${key}`, 'person', { key, name }, at);
		people.set(key, node.data.name as string);
		return node;
	};
	for (const ep of sorted) {
		const at = Date.parse(ep.publishedAt);
		const epKey = episodeKey(ep);
		const showKey = `podcast:${ep.podcast}`;
		// A show, and its host, enter with its first episode.
		if (!nodes.has(showKey)) {
			const show = podcasts.find((p) => p.key === ep.podcast);
			if (!show) throw new Error(`episode ${epKey} of unknown podcast '${ep.podcast}'`);
			const { key, name, short, host, url, image } = show;
			nodes.set(showKey, {
				key: showKey,
				type: 'podcast',
				data: { key, name, short, host, url, image },
				body: `${name} — hosted by ${host}`,
				validFrom: at,
			});
			person(host, at);
			addEdge({ rel: 'hosts', src: `person:${keyOf(host)}`, dst: showKey, validFrom: at });
		}
		const data: EpisodeData = {
			podcast: ep.podcast,
			slug: ep.slug,
			number: ep.number ?? undefined,
			kind: ep.kind,
			title: ep.title,
			guests: ep.guests,
			topics: ep.topics,
			tagline: ep.tagline,
			publishedAt: ep.publishedAt,
			durationSec: ep.durationSec,
			url: ep.url,
			youtubeUrl: ep.youtubeUrl,
			transcriptUrl: ep.transcriptUrl,
			audioUrl: ep.audioUrl,
			summary: ep.summary,
			chapters: ep.chapters,
		};
		nodes.set(epKey, { key: epKey, type: 'episode', data, body: episodeText(data), validFrom: at });
		addEdge({ rel: 'episodeOf', src: epKey, dst: showKey, validFrom: at });

		for (const name of ep.guests) {
			const key = keyOf(name);
			const node = person(name, at);
			// A person's tagline is the one from their latest single-guest episode, on any show.
			if (ep.tagline && ep.guests.length === 1) {
				node.data = { ...node.data, tagline: ep.tagline };
				node.body = `${node.data.name} — ${ep.tagline}`;
			}
			addEdge({ rel: 'appearedOn', src: `person:${key}`, dst: epKey, validFrom: at });
		}
		for (const name of ep.topics) {
			const key = keyOf(name);
			if (!key) continue;
			firstSeen(`topic:${key}`, 'topic', { key, name }, at);
			addEdge({ rel: 'about', src: epKey, dst: `topic:${key}`, validFrom: at });
		}
		for (const name of ep.sponsors) {
			const key = sponsorKey(name);
			firstSeen(`sponsor:${key}`, 'sponsor', { key, name }, at);
			addEdge({ rel: 'sponsoredBy', src: epKey, dst: `sponsor:${key}`, validFrom: at });
		}
	}

	// Mentions need every person known first: an early chapter can name someone who came on later,
	// or who only ever sat on another show.
	const matchers = personMatchers(people);
	for (const ep of sorted) {
		// Neither the episode's own guests nor its host are "brought up" by it.
		const host = podcasts.find((p) => p.key === ep.podcast)?.host ?? '';
		const own = new Set([...ep.guests, host].map(keyOf));
		for (const ch of ep.chapters) {
			for (const { key, re } of matchers) {
				if (own.has(key) || !re.test(ch.title)) continue;
				addEdge({
					rel: 'mentions',
					src: episodeKey(ep),
					dst: `person:${key}`,
					data: { chapter: ch.title, startSec: ch.startSec },
					validFrom: Date.parse(ep.publishedAt),
				});
			}
		}
	}

	const latest = sorted.at(-1);
	const shows = podcasts.filter((p) => nodes.has(`podcast:${p.key}`));
	nodes.set('dataset', {
		key: 'dataset',
		type: 'dataset',
		data: {
			sources: shows.flatMap((p) => p.sources),
			latestEpisode: latest ? `${latest.podcast}/${latest.slug}` : '',
		},
		body: shows.map((p) => p.name).join(', '),
		validFrom: latest ? Date.parse(latest.publishedAt) : 0,
	});
	return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
