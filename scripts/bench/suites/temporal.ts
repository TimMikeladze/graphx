/**
 * Time travel and the pattern engine.
 *
 * The pairing that matters here is `retrieve` live against `retrieve` as-of-past. They are two
 * different SQL programs: live reads compare `valid_to` for equality against FOREVER and seed
 * straight off the partial vector index, while an as-of-past read swaps in half-open interval
 * predicates everywhere and has to over-fetch its seeds by 4x and filter them down, because the
 * live index cannot see historical rows. The ratio between the two is the price of time travel,
 * and nothing else in the harness reports it.
 */
import { match, retrieve } from '../../../packages/graphx/src/core/index.ts';
import { changeFeed, diff, history } from '../../../packages/graphx/src/core/index.ts';
import { demoSchema } from '../../seed/schema.ts';
import { BENCH_NOW, DAY_MS, embed, WINDOW_DAYS } from '../corpus.ts';
import { defineCase, pick, type Suite } from '../types.ts';

/** As-of points spread across the corpus's temporal window, newest first. */
const AS_OF: number[] = Array.from(
	{ length: 12 },
	(_, i) => BENCH_NOW - Math.round(((i + 1) / 12) * WINDOW_DAYS * DAY_MS),
);

export const temporalSuite: Suite = {
	name: 'temporal',
	cases: [
		defineCase<void>({
			name: 'retrieve depth=2 (live)',
			async run(ctx, i) {
				await retrieve(ctx.client, embed, { query: pick(ctx.queries, i), k: 10, maxDepth: 2 });
			},
		}),

		defineCase<void>({
			name: 'retrieve depth=2 (asOf past)',
			async run(ctx, i) {
				await retrieve(ctx.client, embed, {
					query: pick(ctx.queries, i),
					k: 10,
					maxDepth: 2,
					asOf: pick(AS_OF, i),
				});
			},
		}),

		defineCase<void>({
			name: 'history (one node)',
			async run(ctx, i) {
				await history(ctx.client, pick(ctx.nodeIds, i));
			},
		}),

		defineCase<void>({
			name: 'diff (7-day window)',
			async run(ctx, i) {
				const t2 = pick(AS_OF, i);
				await diff(ctx.client, t2 - 7 * DAY_MS, t2);
			},
		}),

		defineCase<void>({
			name: 'changeFeed (first page, limit=1000)',
			async run(ctx) {
				await changeFeed(ctx.client, {}, { limit: 1_000 });
			},
		}),

		defineCase<void>({
			name: 'match 3-hop chain (page limit=200)',
			async run(ctx) {
				// person -authored-> document -mentions-> person: two joins over the live views, the
				// shape a real query would use and the one where a missing index would show.
				const query = await match(demoSchema, ctx.client)
					.node('a', 'person')
					.out('authored')
					.node('b', 'document')
					.out('mentions')
					.node('c', 'person')
					.select('a', 'c');
				await query.page({ limit: 200 });
			},
		}),

		defineCase<void>({
			name: 'match 3-hop chain (asOf past)',
			async run(ctx, i) {
				const query = await match(demoSchema, ctx.client)
					.node('a', 'person')
					.out('authored')
					.node('b', 'document')
					.out('mentions')
					.node('c', 'person')
					.asOf(pick(AS_OF, i))
					.select('a', 'c');
				await query.page({ limit: 200 });
			},
		}),
	],
};
