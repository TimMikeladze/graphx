/**
 * The Jev reranker this example uses: `jevRerank()` reading only what describes a title — its name,
 * format, year, alternative titles and tags — rather than the whole node, whose image urls and
 * site ids are noise to a relevance judgment.
 */
import type { RerankFn } from 'graphx/core';
import { jevRerank } from 'graphx/jev';

interface AnimeLike {
	title?: string;
	name?: string;
	type?: string;
	year?: number;
	synonyms?: string[];
	tags?: string[];
}

export function animeRerank(): RerankFn {
	return jevRerank({
		onError: 'keep',
		state: (query, c) => {
			const d = c.data as AnimeLike;
			return {
				query,
				candidate: {
					kind: c.type,
					title: d.title ?? d.name ?? '',
					format: d.type ?? null,
					year: d.year ?? null,
					alsoKnownAs: (d.synonyms ?? []).slice(0, 6),
					tags: (d.tags ?? []).slice(0, 40),
				},
			};
		},
	});
}

export const hasJevKey = (): boolean => Boolean(process.env.TYPESAFE_API_KEY);
