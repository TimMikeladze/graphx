import { expect, test } from 'bun:test';
import { buildPathIndex, resolveLink } from '../src/resolve.ts';

const index = buildPathIndex(['notes/a.md', 'notes/b.md', 'people/bob.yaml']);

test('resolveLink: relative path link resolves against the source file dir', () => {
	expect(resolveLink({ type: 'path', target: './b.md' }, 'notes/a.md', index)).toEqual({
		status: 'resolved',
		key: 'notes/b.md',
	});
	expect(resolveLink({ type: 'path', target: '../people/bob.yaml' }, 'notes/a.md', index)).toEqual({
		status: 'resolved',
		key: 'people/bob.yaml',
	});
});

test('resolveLink: wikilink resolves by unique basename (ext/case-insensitive)', () => {
	expect(resolveLink({ type: 'wiki', target: 'b' }, 'notes/a.md', index)).toEqual({
		status: 'resolved',
		key: 'notes/b.md',
	});
	expect(resolveLink({ type: 'wiki', target: 'Bob' }, 'notes/a.md', index)).toEqual({
		status: 'resolved',
		key: 'people/bob.yaml',
	});
});

test('resolveLink: a missing target is reported missing (not ambiguous)', () => {
	expect(resolveLink({ type: 'path', target: './missing.md' }, 'notes/a.md', index)).toEqual({
		status: 'missing',
	});
	expect(resolveLink({ type: 'wiki', target: 'ghost' }, 'notes/a.md', index)).toEqual({
		status: 'missing',
	});
});

test('resolveLink: a colliding basename is reported ambiguous with sorted candidates', () => {
	const dup = buildPathIndex(['x/a.md', 'y/a.md']);
	expect(resolveLink({ type: 'wiki', target: 'a' }, 'z/from.md', dup)).toEqual({
		status: 'ambiguous',
		candidates: ['x/a.md', 'y/a.md'],
	});
});

test('resolveLink: a colliding basename prefers a same-folder match', () => {
	const dup = buildPathIndex(['x/a.md', 'y/a.md']);
	expect(resolveLink({ type: 'wiki', target: 'a' }, 'x/from.md', dup)).toEqual({
		status: 'resolved',
		key: 'x/a.md',
	});
});

test('resolveLink: a folder-qualified wikilink resolves by path, disambiguating the basename', () => {
	const dup = buildPathIndex(['x/a.md', 'y/a.md']);
	expect(resolveLink({ type: 'wiki', target: 'y/a' }, 'x/from.md', dup)).toEqual({
		status: 'resolved',
		key: 'y/a.md',
	});
});
