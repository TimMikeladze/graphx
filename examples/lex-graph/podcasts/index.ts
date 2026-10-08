/**
 * The shows this graph holds. Adding one is a module in this directory that exports a `Podcast`
 * (its scrape and its parsing rules) and a line here; the schema, loader, API and app are generic.
 */
import { lex } from './lex.ts';
import { mindscape } from './mindscape.ts';
import type { Podcast } from './source.ts';

export type { Podcast } from './source.ts';

export const PODCASTS: Podcast[] = [lex, mindscape];

export function podcastOf(key: string): Podcast {
	const p = PODCASTS.find((x) => x.key === key);
	if (!p)
		throw new Error(`unknown podcast '${key}' — one of ${PODCASTS.map((x) => x.key).join(', ')}`);
	return p;
}
