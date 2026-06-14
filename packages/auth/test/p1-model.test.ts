import { expect, test } from 'bun:test';
import { defineAuthModel, rel } from '../src/model.ts';
import { parseRef, typeOf } from '../src/types.ts';

test('P1: parseRef splits on first colon', () => {
	expect(parseRef('doc:42')).toEqual({ type: 'doc', id: '42' });
	expect(parseRef('user:alice:eu')).toEqual({ type: 'user', id: 'alice:eu' });
	expect(typeOf('group:eng')).toBe('group');
});

test('P1: parseRef rejects refs without a type', () => {
	expect(() => parseRef('doc')).toThrow();
	expect(() => parseRef(':42')).toThrow();
});

const MODEL = defineAuthModel({
	user: {},
	group: { member: rel() },
	doc: { editor: rel(), viewer: rel() },
});

test('P1: model exposes types and relations', () => {
	expect(new Set(MODEL.types)).toEqual(new Set(['user', 'group', 'doc']));
	expect(MODEL.relationsOf('doc')).toEqual(['editor', 'viewer']);
	expect(MODEL.relationsOf('user')).toEqual([]);
});

test('P1: rewrite returns self for a declared relation', () => {
	expect(MODEL.rewrite('doc', 'viewer')).toEqual({ kind: 'self' });
});

test('P1: rewrite throws on unknown type or relation', () => {
	expect(() => MODEL.rewrite('doc', 'owner')).toThrow(/unknown relation/);
	expect(() => MODEL.rewrite('widget', 'viewer')).toThrow(/unknown type/);
});

test('P1: compiled schema has a node kind per type and one edge per relation', () => {
	expect(Object.keys(MODEL.schema.nodes).sort()).toEqual(['doc', 'group', 'user']);
	// `member`, `editor`, `viewer` — deduped across types
	expect(Object.keys(MODEL.schema.edges).sort()).toEqual(['editor', 'member', 'viewer']);
});
