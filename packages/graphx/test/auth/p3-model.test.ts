import { expect, test } from 'bun:test';
import { defineAuthModel, rel, tupleToUserset } from '../../src/auth/model.ts';

test('P3: tupleToUserset compiles to a ttu node inside the union', () => {
	const m = defineAuthModel({
		user: {},
		folder: { parent: rel(), editor: rel(), viewer: rel().or(tupleToUserset('parent', 'viewer')) },
	});
	expect(m.rewrite('folder', 'viewer')).toEqual({
		kind: 'union',
		children: [{ kind: 'self' }, { kind: 'ttu', tupleset: 'parent', computed: 'viewer' }],
	});
});

test('P3: full chain — (self ∪ editor ∪ ttu) − banned', () => {
	const m = defineAuthModel({
		user: {},
		folder: { parent: rel(), editor: rel(), viewer: rel().or('editor') },
		doc: {
			parent: rel(),
			editor: rel(),
			banned: rel(),
			viewer: rel().self().or('editor').or(tupleToUserset('parent', 'viewer')).minus('banned'),
		},
	});
	expect(m.rewrite('doc', 'viewer')).toEqual({
		kind: 'exclusion',
		base: {
			kind: 'union',
			children: [
				{ kind: 'self' },
				{ kind: 'computed', relation: 'editor' },
				{ kind: 'ttu', tupleset: 'parent', computed: 'viewer' },
			],
		},
		subtract: { kind: 'computed', relation: 'banned' },
	});
});

test('P3: .and compiles to intersection', () => {
	const m = defineAuthModel({ user: {}, doc: { reviewer: rel(), gated: rel().and('reviewer') } });
	expect(m.rewrite('doc', 'gated')).toEqual({
		kind: 'intersection',
		children: [{ kind: 'self' }, { kind: 'computed', relation: 'reviewer' }],
	});
});

test('P3: validation — ttu with an unknown tupleset relation throws', () => {
	expect(() =>
		defineAuthModel({ user: {}, doc: { viewer: rel().or(tupleToUserset('parent', 'viewer')) } }),
	).toThrow(/unknown tupleset relation/);
});

test('P3: validation — computed operand to an unknown relation still throws', () => {
	expect(() => defineAuthModel({ user: {}, doc: { gated: rel().and('reviewer') } })).toThrow(
		/references unknown relation/,
	);
});

test('P3: builder operator order does not matter (fixed precedence)', () => {
	const a = rel().minus('banned').or('editor').rewrite;
	const b = rel().or('editor').minus('banned').rewrite;
	expect(a).toEqual(b);
	expect(a).toEqual({
		kind: 'exclusion',
		base: { kind: 'union', children: [{ kind: 'self' }, { kind: 'computed', relation: 'editor' }] },
		subtract: { kind: 'computed', relation: 'banned' },
	});
});
