import { expect, test } from 'bun:test';
import { buildPathIndex, resolveLink } from '../src/resolve.ts';

const index = buildPathIndex(['notes/a.md', 'notes/b.md', 'people/bob.yaml']);

test('resolveLink: relative path link resolves against the source file dir', () => {
	expect(resolveLink({ kind: 'path', target: './b.md' }, 'notes/a.md', index)).toBe('notes/b.md');
	expect(resolveLink({ kind: 'path', target: '../people/bob.yaml' }, 'notes/a.md', index)).toBe(
		'people/bob.yaml',
	);
});

test('resolveLink: wikilink resolves by unique basename (ext/case-insensitive)', () => {
	expect(resolveLink({ kind: 'wiki', target: 'b' }, 'notes/a.md', index)).toBe('notes/b.md');
	expect(resolveLink({ kind: 'wiki', target: 'Bob' }, 'notes/a.md', index)).toBe('people/bob.yaml');
});

test('resolveLink: missing target and ambiguous basename return null', () => {
	expect(resolveLink({ kind: 'path', target: './missing.md' }, 'notes/a.md', index)).toBeNull();
	const dup = buildPathIndex(['x/a.md', 'y/a.md']);
	expect(resolveLink({ kind: 'wiki', target: 'a' }, 'x/a.md', dup)).toBeNull();
});
