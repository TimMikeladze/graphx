import { expect, test } from 'bun:test';
import { extractLinks } from '../src/links.ts';

test('extractLinks: wikilinks (with alias stripped)', () => {
	expect(extractLinks('see [[Bob]] and [[notes/c|C]]')).toEqual([
		{ kind: 'wiki', target: 'Bob' },
		{ kind: 'wiki', target: 'notes/c' },
	]);
});

test('extractLinks: relative markdown links, external/anchor ignored', () => {
	expect(
		extractLinks('[x](./b.md) [y](../d.md) [ext](https://e.com) [a](#frag)'),
	).toEqual([
		{ kind: 'path', target: './b.md' },
		{ kind: 'path', target: '../d.md' },
	]);
});

test('extractLinks: none', () => {
	expect(extractLinks('plain text, no links')).toEqual([]);
});
