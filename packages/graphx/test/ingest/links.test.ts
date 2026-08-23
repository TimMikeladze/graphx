import { expect, test } from 'bun:test';
import { extractEmbeds, extractLinks } from '../../src/ingest/links.ts';

test('extractEmbeds: returns only the `!`-prefixed embeds (wiki + path), skips plain links', () => {
	expect(
		extractEmbeds('![[pic.png]] and ![alt](./img/p.jpg) but [real](./b.md) and [[note]]'),
	).toEqual([
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
	expect(extractLinks('![alt](./pic.png) and ![[embed.md]] but [real](./b.md)')).toEqual([
		{ type: 'path', target: './b.md' },
	]);
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

test('extractLinks: a heading fragment is split off the wikilink target', () => {
	expect(extractLinks('[[beta#Intro]]')).toEqual([
		{ type: 'wiki', target: 'beta', fragment: 'Intro' },
	]);
});

test('extractLinks: a block-ref fragment is split off the wikilink target', () => {
	expect(extractLinks('[[beta#^abc123]]')).toEqual([
		{ type: 'wiki', target: 'beta', fragment: '^abc123' },
	]);
});

test('extractLinks: display text is stripped before the fragment is split', () => {
	expect(extractLinks('[[beta#Intro|see intro]]')).toEqual([
		{ type: 'wiki', target: 'beta', fragment: 'Intro' },
	]);
});

test('extractLinks: a path link keeps its fragment separate from the target', () => {
	expect(extractLinks('[b](./b.md#Intro)')).toEqual([
		{ type: 'path', target: './b.md', fragment: 'Intro' },
	]);
});

test('extractLinks: a typed link carries both rel and fragment', () => {
	expect(extractLinks('[cites:: [[beta#Intro]]]')).toEqual([
		{ type: 'wiki', target: 'beta', rel: 'cites', fragment: 'Intro' },
	]);
});

test('extractLinks: a fragment-only link is still skipped as an in-page anchor', () => {
	expect(extractLinks('[here](#Intro)')).toEqual([]);
	expect(extractLinks('[[#Intro]]')).toEqual([]);
});

test('extractEmbeds: a transclusion fragment is split off the target', () => {
	expect(extractEmbeds('![[beta#Intro]]')).toEqual([
		{ type: 'wiki', target: 'beta', fragment: 'Intro' },
	]);
	expect(extractEmbeds('![[beta#^abc123]]')).toEqual([
		{ type: 'wiki', target: 'beta', fragment: '^abc123' },
	]);
});

test('extractLinks: a percent-encoded path link is decoded to the real filename', () => {
	// Obsidian writes markdown-style links percent-encoded: `[my note](my%20note.md)`.
	expect(extractLinks('[my note](my%20note.md)')).toEqual([{ type: 'path', target: 'my note.md' }]);
	expect(extractLinks('[n](sub%20folder/my%20note.md)')).toEqual([
		{ type: 'path', target: 'sub folder/my note.md' },
	]);
});

test('extractLinks: the fragment is split before decoding, so %23 stays part of the name', () => {
	// `%23` is a literal `#` in the FILENAME; only an unencoded `#` starts a fragment.
	expect(extractLinks('[n](a%23b.md)')).toEqual([{ type: 'path', target: 'a#b.md' }]);
	expect(extractLinks('[n](my%20note.md#Some%20Heading)')).toEqual([
		{ type: 'path', target: 'my note.md', fragment: 'Some Heading' },
	]);
});

test('extractLinks: a malformed escape is left verbatim rather than throwing', () => {
	expect(extractLinks('[n](100%discount.md)')).toEqual([
		{ type: 'path', target: '100%discount.md' },
	]);
});

test('extractEmbeds: a percent-encoded embed target is decoded', () => {
	expect(extractEmbeds('![alt](my%20image.png)')).toEqual([
		{ type: 'path', target: 'my image.png' },
	]);
});
