import { expect, test } from 'bun:test';
import { metricKey, toMetrics } from './benchable.ts';

test('metricKey: squashes case names into stable dotted segments', () => {
	expect(
		metricKey({ suite: 'traversal', case: 'neighbors (forward, rel-filtered)', variant: '100k' }),
	).toBe('bench.traversal.neighbors_forward_rel_filtered.100k.ms');
});

test('toMetrics: carries mean/stddev/samples and skips empty cases', () => {
	const stats = {
		p50: 2,
		p95: 8,
		min: 1,
		max: 8,
		mean: 3.75,
		stddev: 3.1,
		iters: 4,
		opsPerSec: 500,
	};
	const metrics = toMetrics({
		meta: { driver: 'libsql', startedAt: '', scales: ['1k'] },
		results: [
			{ suite: 'write', case: 'upsert', variant: '1k', scale: '1k', stats, corpus: {} as never },
			{
				suite: 'write',
				case: 'empty',
				variant: '1k',
				scale: '1k',
				stats: { ...stats, p50: Number.NaN },
				corpus: {} as never,
			},
		],
	});
	expect(Object.keys(metrics)).toEqual(['bench.write.upsert.1k.ms']);
	expect(metrics['bench.write.upsert.1k.ms']).toMatchObject({
		value: 2,
		mean: 3.75,
		stddev: 3.1,
		samples: 4,
		direction: 'lower',
	});
});
