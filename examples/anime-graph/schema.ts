/**
 * The anime graph's schema — driver-free (`graphx/core` only), so the web app can bundle it
 * without libSQL. `graphx.config.ts` re-exports it for the CLI and the scripts.
 *
 * Built from manami-project's anime-offline-database (ODbL v1.0 + DbCL v1.0). One `anime` node per
 * entry in the release; studios, producers and tags are nodes of their own so they can be traversed
 * and ranked; `dataset` is a single provenance node carrying the release's `lastUpdate` and license.
 */
import { defineGraphSchema } from 'graphx/core';
import { z } from 'zod';

/** Every metadata site the release links to, keyed by the field its id lands in. */
export const SITES = {
	malId: 'myanimelist.net',
	anilistId: 'anilist.co',
	kitsuId: 'kitsu.app',
	anidbId: 'anidb.net',
	animePlanetId: 'anime-planet.com',
	anisearchId: 'anisearch.com',
	animeCountdownId: 'animecountdown.com',
	simklId: 'simkl.com',
	annId: 'animenewsnetwork.com',
	livechartId: 'livechart.me',
} as const;

export type SiteField = keyof typeof SITES;

const externalIds = Object.fromEntries(
	Object.keys(SITES).map((k) => [k, z.string().optional()]),
) as Record<SiteField, z.ZodOptional<z.ZodString>>;

const anime = z.object({
	/** The stable identity: the MAL url, else the AniList url, else the first source. */
	key: z.string(),
	title: z.string(),
	type: z.enum(['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'UNKNOWN']),
	episodes: z.number().int().nonnegative(),
	status: z.enum(['FINISHED', 'ONGOING', 'UPCOMING', 'UNKNOWN']),
	season: z.enum(['SPRING', 'SUMMER', 'FALL', 'WINTER', 'UNDEFINED']),
	year: z.number().int().optional(),
	/** Per-episode runtime in seconds. */
	durationSec: z.number().optional(),
	/** Median of the scores the sites report, on the release's 1–10 `scoreRange`. */
	score: z.number().optional(),
	picture: z.string(),
	thumbnail: z.string(),
	synonyms: z.array(z.string()),
	tags: z.array(z.string()),
	/** Every source url — how a later release finds this node again if its preferred url moved. */
	sources: z.array(z.string()),
	...externalIds,
});

export const animeSchema = defineGraphSchema({
	nodes: {
		anime,
		studio: z.object({ name: z.string() }),
		producer: z.object({ name: z.string() }),
		tag: z.object({ name: z.string() }),
		/** One node: which release the graph holds, and under what license. */
		dataset: z.object({
			lastUpdate: z.string(),
			license: z.string(),
			licenseUrl: z.string(),
			repository: z.string(),
		}),
	},
	edges: {
		relatedTo: { from: 'anime', to: 'anime' },
		animatedBy: { from: 'anime', to: 'studio' },
		producedBy: { from: 'anime', to: 'producer' },
		taggedWith: { from: 'anime', to: 'tag' },
	},
	// Anime embed from titles + tags; every other type embeds its `body` (its name).
	embedding: { anime: { text: (d: z.infer<typeof anime>) => animeText(d) } },
});

export type AnimeSchema = typeof animeSchema;

/** What an anime is embedded from and full-text indexed on: its titles and tags. */
export function animeText(d: { title: string; synonyms: string[]; tags: string[] }): string {
	return [d.title, ...d.synonyms, ...d.tags].join(' · ');
}

/** libSQL file `anime.db` beside the scripts, or the Postgres schema `anime`. */
export const NAMESPACE = 'anime';
