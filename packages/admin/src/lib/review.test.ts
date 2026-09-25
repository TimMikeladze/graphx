import { expect, test } from 'bun:test';
import { acceptedData, judgmentOf, outcomeOf, promoteRels, reviewRels } from './review';
import type { SchemaDoc } from './types';

const rel = (r: string, from = ['deity'], to = ['deity']) => ({
	rel: r,
	from,
	to,
	single: false,
	jsonSchema: null,
});
const schema: SchemaDoc = {
	nodes: [],
	edges: [
		rel('parent_of'),
		rel('same_as'),
		rel('maybe_same_as'),
		rel('belongs_to', ['deity'], ['pantheon']),
	],
};

test('reviewRels puts rels that read as a queue first', () => {
	expect(reviewRels(schema)[0]).toBe('maybe_same_as');
	expect(reviewRels(undefined)).toEqual([]);
});

test('promoteRels offers rels joining the same types, the un-maybe name first', () => {
	expect(promoteRels(schema, 'maybe_same_as')).toEqual(['same_as', 'parent_of']);
	expect(
		promoteRels({ nodes: [], edges: [rel('maybeSameAs'), rel('sameAs')] }, 'maybeSameAs'),
	).toEqual(['sameAs']);
	expect(promoteRels(schema, 'nope')).toEqual([]);
});

test('judgmentOf reads what Jev wrote, weakest field first, and tolerates a hand-written edge', () => {
	expect(
		judgmentOf({
			method: 'jev',
			model: 'jev-1.13.0',
			score: 1.1,
			confidence: 0.4,
			fields: { name: 0.98, pantheon: 0.2 },
		}),
	).toEqual({
		score: 1.1,
		confidence: 0.4,
		model: 'jev-1.13.0',
		fields: [
			{ field: 'pantheon', agreement: 0.2 },
			{ field: 'name', agreement: 0.98 },
		],
	});
	expect(judgmentOf({})).toEqual({ score: null, confidence: null, model: null, fields: [] });
	expect([0.2, 1, 1.7].map(outcomeOf)).toEqual(['different', 'review', 'same']);
	expect(acceptedData({ method: 'jev', score: 1 })).toEqual({ method: 'curator', score: 1 });
});
