/**
 * The podcast graph's schema — driver-free (`graphx/core` only). `graphx.config.ts` re-exports it
 * for the CLI and the scripts.
 *
 * Every show is a `podcast` node, and every conversation an `episode` of it. People, topics and
 * sponsors are shared across shows by natural key, so a guest who sat with Lex Fridman and with
 * Sean Carroll is one `person` with appearances on both, and a host is a person too. Every node
 * and edge is valid from the episode that introduced it, so `asOf` reads the shows as they stood on
 * any date since 2018.
 */
import { defineGraphSchema } from 'graphx/core';
import { z } from 'zod';

const episode = z.object({
	/** The show's key (`lex`, `mindscape`); `slug` is unique within it. */
	podcast: z.string(),
	slug: z.string(),
	number: z.number().int().optional(),
	kind: z.enum(['interview', 'solo', 'ama', 'announcement', 'bonus']),
	title: z.string(),
	/** Denormalized from `appearedOn` and `about`, so a hit reads without a second query. */
	guests: z.array(z.string()),
	topics: z.array(z.string()),
	tagline: z.string().optional(),
	publishedAt: z.string(),
	durationSec: z.number().int().optional(),
	url: z.string(),
	youtubeUrl: z.string().optional(),
	transcriptUrl: z.string().optional(),
	audioUrl: z.string().optional(),
	summary: z.string(),
	chapters: z.array(z.object({ startSec: z.number().int(), title: z.string() })),
});

export const podcastSchema = defineGraphSchema({
	nodes: {
		podcast: z.object({
			key: z.string(),
			name: z.string(),
			short: z.string(),
			host: z.string(),
			url: z.string(),
			image: z.string().optional(),
		}),
		episode,
		person: z.object({ key: z.string(), name: z.string(), tagline: z.string().optional() }),
		topic: z.object({ key: z.string(), name: z.string() }),
		sponsor: z.object({ key: z.string(), name: z.string() }),
		/** One node: where the data came from, and the newest episode it holds. */
		dataset: z.object({ sources: z.array(z.string()), latestEpisode: z.string() }),
	},
	edges: {
		episodeOf: { from: 'episode', to: 'podcast' },
		hosts: { from: 'person', to: 'podcast' },
		appearedOn: { from: 'person', to: 'episode' },
		about: { from: 'episode', to: 'topic' },
		sponsoredBy: { from: 'episode', to: 'sponsor' },
		/** A chapter of the episode names a person from another episode ("(2:27:05) – Joe Rogan"). */
		mentions: {
			from: 'episode',
			to: 'person',
			data: z.object({ chapter: z.string(), startSec: z.number().int() }),
		},
	},
});

export type PodcastSchema = typeof podcastSchema;
export type EpisodeData = z.infer<typeof episode>;

/** An episode's `body`, which is what it is embedded from and full-text indexed on: who, what, and the chapter list. */
export function episodeText(d: {
	title: string;
	guests: string[];
	summary: string;
	chapters: Array<{ title: string }>;
}): string {
	return [d.guests.join(', '), d.title, d.summary, d.chapters.map((c) => c.title).join(' · ')]
		.filter(Boolean)
		.join('\n');
}

/** libSQL file `podcasts.db` beside the scripts. */
export const NAMESPACE = 'podcasts';
