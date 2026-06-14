import { expect, test } from 'bun:test';
import { defineAuthModel, rel } from '../src/model.ts';

test('P2: bare rel() is still self', () => {
	const m = defineAuthModel({ user: {}, doc: { viewer: rel() } });
	expect(m.rewrite('doc', 'viewer')).toEqual({ kind: 'self' });
});

test('P2: .or(rel) compiles to union(self, computed)', () => {
	const m = defineAuthModel({ user: {}, doc: { editor: rel(), viewer: rel().or('editor') } });
	expect(m.rewrite('doc', 'viewer')).toEqual({
		kind: 'union',
		children: [{ kind: 'self' }, { kind: 'computed', relation: 'editor' }],
	});
});

test('P2: .self().or(rel) equals .or(rel)', () => {
	const m = defineAuthModel({ user: {}, doc: { editor: rel(), viewer: rel().self().or('editor') } });
	expect(m.rewrite('doc', 'viewer')).toEqual({
		kind: 'union',
		children: [{ kind: 'self' }, { kind: 'computed', relation: 'editor' }],
	});
});

test('P2: defineAuthModel rejects a computed ref to an undeclared relation', () => {
	expect(() => defineAuthModel({ user: {}, doc: { viewer: rel().or('editor') } })).toThrow(
		/references unknown relation/,
	);
});
