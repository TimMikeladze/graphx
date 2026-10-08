/**
 * Scrape every show in `podcasts/` into `data/<podcast>/episodes.json`.
 *
 *   bun run scrape.ts [--podcast lex|mindscape] [--offline]
 *
 * Each show keeps its raw responses beside its output (`data/lex/feed.xml`, `data/lex/podcast.html`,
 * `data/mindscape/feed.xml`, …); `--offline` re-parses those instead of fetching, which is how a
 * parser change is checked without touching the sites.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Episode } from './parse.ts';
import { PODCASTS, podcastOf } from './podcasts/index.ts';

export const DATA_DIR = join(import.meta.dir, 'data');
export const episodesFile = (podcast: string) => join(DATA_DIR, podcast, 'episodes.json');

export async function scrape(podcast: string, offline = false): Promise<Episode[]> {
	const p = podcastOf(podcast);
	const dir = join(DATA_DIR, p.key);
	await mkdir(dir, { recursive: true });
	const episodes = await p.scrape(dir, { offline });
	await Bun.write(episodesFile(p.key), `${JSON.stringify(episodes, null, '\t')}\n`);

	const guests = new Set(episodes.flatMap((e) => e.guests));
	console.log(
		`[${p.key}] ${episodes.length} episodes (${episodes[0]?.publishedAt.slice(0, 10)} → ${episodes.at(-1)?.publishedAt.slice(0, 10)}), ` +
			`${guests.size} distinct guests; without guests: ` +
			`${episodes.filter((e) => e.kind === 'interview' && !e.guests.length).length} interviews, ` +
			`without topics: ${episodes.filter((e) => e.kind === 'interview' && !e.topics.length).length}`,
	);
	console.log(`[${p.key}] wrote ${episodesFile(p.key)}`);
	return episodes;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			podcast: { type: 'string' },
			offline: { type: 'boolean', default: false },
		},
	});
	const keys = values.podcast ? [values.podcast] : PODCASTS.map((p) => p.key);
	for (const key of keys) await scrape(key, values.offline);
}
