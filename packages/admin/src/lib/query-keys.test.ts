import { describe, expect, it } from 'bun:test';
import { qk } from './query-keys';

describe('query keys', () => {
	it('distinguishes a live read from an as-of read', () => {
		expect(qk.node('t', 'p', 'n')).not.toEqual(qk.node('t', 'p', 'n', { asOf: 5 }));
		expect(qk.neighbors('t', 'p', 'n')).not.toEqual(qk.neighbors('t', 'p', 'n', { asOf: 5 }));
		expect(qk.nodeContent('t', 'p', 'n')).not.toEqual(qk.nodeContent('t', 'p', 'n', { asOf: 5 }));
		// the two axes are different reads
		expect(qk.node('t', 'p', 'n', { asOf: 5 })).not.toEqual(
			qk.node('t', 'p', 'n', { recordedAsOf: 5 }),
		);
	});

	it('exposes an asOf-agnostic prefix that every as-of key extends', () => {
		// A write must evict the live entry AND every as-of entry, so the mutations invalidate this
		// prefix rather than a leaf key. TanStack matches partial prefixes, so both are covered.
		const prefix = qk.allNode('t', 'p', 'n');
		for (const key of [qk.node('t', 'p', 'n'), qk.node('t', 'p', 'n', { asOf: 5 })]) {
			expect(key.slice(0, prefix.length)).toEqual([...prefix]);
		}
		expect(qk.allNeighbors('t', 'p', 'n').length).toBe(4);
		expect(qk.allNodeContent('t', 'p', 'n').length).toBe(4);
	});
});
