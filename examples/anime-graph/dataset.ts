/**
 * The release file and the pure half of the loader: parse anime-offline-database JSON, then turn
 * it into the graph it should become — nodes keyed by a stable identity, edges keyed by
 * `rel|src|dst`. No database here, so the plan is testable on a fixture slice.
 *
 * Shape checked against the release's own JSON schema
 * (`schemas/anime-offline-database-minified.schema.json`); `score` appears in the data but not in
 * that schema, so it is optional here.
 */
import { z } from 'zod';
import { SITES, type SiteField } from './graphx.config.ts';

const AnimeEntry = z.object({
	sources: z.array(z.string()),
	title: z.string(),
	type: z.enum(['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', 'UNKNOWN']),
	episodes: z.number().nonnegative(),
	status: z.enum(['FINISHED', 'ONGOING', 'UPCOMING', 'UNKNOWN']),
	animeSeason: z.object({
		season: z.enum(['SPRING', 'SUMMER', 'FALL', 'WINTER', 'UNDEFINED']),
		year: z.number().optional(),
	}),
	picture: z.string(),
	thumbnail: z.string(),
	duration: z.object({ value: z.number(), unit: z.literal('SECONDS') }).optional(),
	score: z
		.object({ arithmeticGeometricMean: z.number(), arithmeticMean: z.number(), median: z.number() })
		.optional(),
	synonyms: z.array(z.string()),
	studios: z.array(z.string()),
	producers: z.array(z.string()),
	relatedAnime: z.array(z.string()),
	tags: z.array(z.string()),
});

export const RELEASE_URL =
	'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
export const RELEASE_FILE = 'anime-offline-database-minified.json';

export const Release = z.object({
	$schema: z.string().optional(),
	license: z.object({ name: z.string(), url: z.string() }),
	repository: z.string(),
	scoreRange: z.object({ minInclusive: z.number(), maxInclusive: z.number() }),
	lastUpdate: z.string(),
	data: z.array(AnimeEntry),
});

export type AnimeEntry = z.infer<typeof AnimeEntry>;
export type Release = z.infer<typeof Release>;

const HOST_TO_FIELD = new Map<string, SiteField>(
	Object.entries(SITES).map(([field, host]) => [host, field as SiteField]),
);

/**
 * `https://myanimelist.net/anime/51478` → `{ field: 'malId', id: '51478' }`. Anime News Network
 * puts its id in the query string; every other site ends the path with it.
 */
export function parseSource(url: string): { field: SiteField; id: string } | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	const field = HOST_TO_FIELD.get(u.hostname.replace(/^www\./, ''));
	if (!field) return null;
	const id = u.searchParams.get('id') ?? u.pathname.split('/').filter(Boolean).pop();
	return id ? { field, id } : null;
}

/** The identity a node keeps across releases: MAL, then AniList, then the first source. */
export function identityOf(entry: Pick<AnimeEntry, 'sources'>): string {
	const pick = (host: string) => entry.sources.find((s) => new URL(s).hostname === host);
	return pick('myanimelist.net') ?? pick('anilist.co') ?? (entry.sources[0] as string);
}

export type NodeType = 'anime' | 'studio' | 'producer' | 'tag' | 'dataset';
export type Rel = 'relatedTo' | 'animatedBy' | 'producedBy' | 'taggedWith';

export interface PlanNode {
	/** Unique per node in the plan: `anime:<identity url>`, `studio:<name>`, `dataset`. */
	key: string;
	type: NodeType;
	data: Record<string, unknown>;
	body?: string;
	/** Source urls, for anime — what a later load matches existing nodes on. */
	sources?: string[];
}

export interface PlanEdge {
	rel: Rel;
	src: string;
	dst: string;
}

export interface Plan {
	nodes: PlanNode[];
	edges: PlanEdge[];
	/** relatedAnime urls that point at no entry in this release. */
	unresolved: { urls: number; distinct: number };
}

/**
 * Tags that mark an entry as hentai or pornography. Entries carrying any of them are left out of
 * the graph entirely; a reload retracts any that an earlier load wrote.
 */
export const EXCLUDED_TAGS: ReadonlySet<string> = new Set([
	'hentai',
	'pornography',
	'borderline porn',
	'plot with porn',
	'erotica',
	'18 restricted',
]);

export const isExcluded = (entry: Pick<AnimeEntry, 'tags'>) =>
	entry.tags.some((t) => EXCLUDED_TAGS.has(t));

const named = (type: 'studio' | 'producer' | 'tag', name: string) => `${type}:${name}`;

export function planRelease(full: Release): Plan {
	const release = { ...full, data: full.data.filter((e) => !isExcluded(e)) };
	const nodes: PlanNode[] = [];
	const edges: PlanEdge[] = [];
	const edgeSeen = new Set<string>();
	const edge = (rel: Rel, src: string, dst: string) => {
		const k = `${rel}|${src}|${dst}`;
		if (src === dst || edgeSeen.has(k)) return;
		edgeSeen.add(k);
		edges.push({ rel, src, dst });
	};

	nodes.push({
		key: 'dataset',
		type: 'dataset',
		data: {
			lastUpdate: release.lastUpdate,
			license: release.license.name,
			licenseUrl: release.license.url,
			repository: release.repository,
		},
		body: `anime-offline-database ${release.lastUpdate} — ${release.license.name}`,
	});

	// Every source url → the entry's key, so relatedAnime (which lists urls, not ids) resolves.
	const byUrl = new Map<string, string>();
	const excludedUrls = new Set(full.data.filter(isExcluded).flatMap((e) => e.sources));
	const keys = release.data.map((entry) => {
		const key = `anime:${identityOf(entry)}`;
		for (const s of entry.sources) byUrl.set(s, key);
		return key;
	});

	const names = { studio: new Set<string>(), producer: new Set<string>(), tag: new Set<string>() };
	const unresolvedUrls = new Set<string>();
	let unresolved = 0;

	release.data.forEach((entry, i) => {
		const key = keys[i] as string;
		const ids: Partial<Record<SiteField, string>> = {};
		for (const s of entry.sources) {
			const parsed = parseSource(s);
			if (parsed) ids[parsed.field] ??= parsed.id;
		}
		const data = {
			key: key.slice('anime:'.length),
			title: entry.title,
			type: entry.type,
			episodes: entry.episodes,
			status: entry.status,
			season: entry.animeSeason.season,
			year: entry.animeSeason.year,
			durationSec: entry.duration?.value,
			score: entry.score?.median,
			picture: entry.picture,
			thumbnail: entry.thumbnail,
			synonyms: entry.synonyms,
			tags: entry.tags,
			sources: entry.sources,
			...ids,
		};
		nodes.push({
			key,
			type: 'anime',
			data,
			body: [entry.title, ...entry.synonyms, ...entry.tags].join(' · '),
			sources: entry.sources,
		});

		for (const [type, list, rel] of [
			['studio', entry.studios, 'animatedBy'],
			['producer', entry.producers, 'producedBy'],
			['tag', entry.tags, 'taggedWith'],
		] as const) {
			for (const name of list) {
				names[type].add(name);
				edge(rel, key, named(type, name));
			}
		}

		// One relation usually arrives as several urls (MAL, AniList, Kitsu… for the same target);
		// `edge` keeps the first.
		for (const url of entry.relatedAnime) {
			if (excludedUrls.has(url)) continue;
			const dst = byUrl.get(url);
			if (dst) edge('relatedTo', key, dst);
			else {
				unresolved++;
				unresolvedUrls.add(url);
			}
		}
	});

	for (const type of ['studio', 'producer', 'tag'] as const) {
		for (const name of [...names[type]].sort()) {
			nodes.push({ key: named(type, name), type, data: { name }, body: name });
		}
	}

	return { nodes, edges, unresolved: { urls: unresolved, distinct: unresolvedUrls.size } };
}
