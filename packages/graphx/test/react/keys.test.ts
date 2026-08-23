import { expect, test } from 'bun:test';
import { graphKeys } from '../../src/react/keys.ts';

test('graphKeys: project-scoped, op-tagged keys', () => {
	const k = graphKeys('p1');
	expect(k.all).toEqual(['graphx', 'p1']);
	expect(k.node('n1')).toEqual(['graphx', 'p1', 'node', 'n1']);
	expect(k.history('n1')).toEqual(['graphx', 'p1', 'history', 'n1']);
	expect(k.diff(1, 2)).toEqual(['graphx', 'p1', 'diff', 1, 2]);
	expect(k.changes()).toEqual(['graphx', 'p1', 'changes']);
});

test('graphKeys: neighbors without opts is a prefix of neighbors with opts (invalidation)', () => {
	const k = graphKeys('p1');
	const prefix = k.neighbors('n1');
	const full = k.neighbors('n1', { direction: 'forward' });
	expect(prefix).toEqual(['graphx', 'p1', 'neighbors', 'n1']);
	// the full key starts with the prefix, so invalidating the prefix matches it
	expect(full.slice(0, prefix.length)).toEqual(prefix);
});

test('graphKeys: two projects never collide', () => {
	expect(graphKeys('a').node('x')).not.toEqual(graphKeys('b').node('x'));
});
