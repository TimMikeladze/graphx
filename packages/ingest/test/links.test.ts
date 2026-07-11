import { expect, test } from 'bun:test';
import { extractEmbeds, extractLinks } from '../src/links.ts';

test('extractEmbeds: returns only the `!`-prefixed embeds (wiki + path), skips plain links', () => {
	expect(extractEmbeds('![[pic.png]] and ![alt](./img/p.jpg) but [real](./b.md) and [[note]]')).toEqual([
		{ type: 'wiki', target: 'pic.png' },
		{ type: 'path', target: './img/p.jpg' },
	]);
});

test('extractEmbeds: none when there are no embeds', () => {
	expect(extractEmbeds('just [a](./b.md) and [[c]]')).toEqual([]);
});

test('extractLinks: wikilinks (with alias stripped)', () => {
	expect(extractLinks('see [[Bob]] and [[notes/c|C]]')).toEqual([
		{ type: 'wiki', target: 'Bob' },
		{ type: 'wiki', target: 'notes/c' },
	]);
});

test('extractLinks: relative markdown links, external/anchor ignored', () => {
	expect(
		extractLinks('[x](./b.md) [y](../d.md) [s](https://e.com) [h](http://e.com) [a](#frag)'),
	).toEqual([
		{ type: 'path', target: './b.md' },
		{ type: 'path', target: '../d.md' },
	]);
});

test('extractLinks: image embeds are not treated as links', () => {
	expect(
		extractLinks('![alt](./pic.png) and ![[embed.md]] but [real](./b.md)'),
	).toEqual([{ type: 'path', target: './b.md' }]);
});

test('extractLinks: none', () => {
	expect(extractLinks('plain text, no links')).toEqual([]);
});

test('extractLinks: inline Dataview typed wikilink sets rel', () => {
	expect(extractLinks('[cites:: [[paper-a]]]')).toEqual([
		{ type: 'wiki', target: 'paper-a', rel: 'cites' },
	]);
});

test('extractLinks: inline Dataview typed path link sets rel', () => {
	expect(extractLinks('[seealso:: [b](./b.md)]')).toEqual([
		{ type: 'path', target: './b.md', rel: 'seealso' },
	]);
});

test('extractLinks: plain wikilink stays rel-less', () => {
	expect(extractLinks('[[b]]')).toEqual([{ type: 'wiki', target: 'b' }]);
});

test('extractLinks: mixed typed and plain links', () => {
	expect(extractLinks('[cites:: [[paper-a]]] and [[b]]')).toEqual([
		{ type: 'wiki', target: 'paper-a', rel: 'cites' },
		{ type: 'wiki', target: 'b' },
	]);
});
