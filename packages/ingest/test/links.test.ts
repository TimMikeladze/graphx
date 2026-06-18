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
		extractLinks('[x](./b.md) [y](../d.md) [s](https://e.com) [h](http://e.com) [a](#frag)'),
	).toEqual([
		{ kind: 'path', target: './b.md' },
		{ kind: 'path', target: '../d.md' },
	]);
});

test('extractLinks: image embeds are not treated as links', () => {
	expect(
		extractLinks('![alt](./pic.png) and ![[embed.md]] but [real](./b.md)'),
	).toEqual([{ kind: 'path', target: './b.md' }]);
});

test('extractLinks: none', () => {
	expect(extractLinks('plain text, no links')).toEqual([]);
});

test('extractLinks: inline Dataview typed wikilink sets rel', () => {
	expect(extractLinks('[cites:: [[paper-a]]]')).toEqual([
		{ kind: 'wiki', target: 'paper-a', rel: 'cites' },
	]);
});

test('extractLinks: inline Dataview typed path link sets rel', () => {
	expect(extractLinks('[seealso:: [b](./b.md)]')).toEqual([
		{ kind: 'path', target: './b.md', rel: 'seealso' },
	]);
});

test('extractLinks: plain wikilink stays rel-less', () => {
	expect(extractLinks('[[b]]')).toEqual([{ kind: 'wiki', target: 'b' }]);
});

test('extractLinks: mixed typed and plain links', () => {
	expect(extractLinks('[cites:: [[paper-a]]] and [[b]]')).toEqual([
		{ kind: 'wiki', target: 'paper-a', rel: 'cites' },
		{ kind: 'wiki', target: 'b' },
	]);
});
