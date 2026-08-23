import { expect, test } from 'bun:test';
import { extractTags } from '../../src/ingest/links.ts';

test('extractTags: finds a plain inline tag', () => {
	expect(extractTags('a #theory note')).toEqual(['theory']);
});

test('extractTags: finds nested and punctuated tags', () => {
	expect(extractTags('#project/active and #well-being and #snake_case')).toEqual([
		'project/active',
		'well-being',
		'snake_case',
	]);
});

test('extractTags: de-duplicates case-insensitively, keeping first-seen spelling', () => {
	expect(extractTags('#Theory then #theory then #THEORY')).toEqual(['Theory']);
});

test('extractTags: a markdown heading is not a tag', () => {
	expect(extractTags('# Heading\n## Sub heading\ntext')).toEqual([]);
});

test('extractTags: a purely numeric tag is not a tag (issue refs like #123)', () => {
	expect(extractTags('fixes #123 but #v2 counts')).toEqual(['v2']);
});

test('extractTags: a mid-word hash is not a tag', () => {
	expect(extractTags('color #fff vs abc#def')).toEqual(['fff']);
});

test('extractTags: a wikilink heading fragment is NOT a tag', () => {
	// The single most important exclusion: `[[note#Intro]]` must not mint an `Intro` tag.
	expect(extractTags('see [[beta#Intro]] and [[b#^abc123]] and ![[x#y]]')).toEqual([]);
});

test('extractTags: a markdown link fragment is NOT a tag', () => {
	expect(extractTags('see [b](./b.md#Intro)')).toEqual([]);
});

test('extractTags: tags inside fenced code are ignored', () => {
	expect(extractTags('before #real\n```\n#notatag\n```\nafter')).toEqual(['real']);
});

test('extractTags: tags inside inline code are ignored', () => {
	expect(extractTags('use `#include <stdio.h>` but #cpp is real')).toEqual(['cpp']);
});

test('extractTags: a bare hash or hash-space yields nothing', () => {
	expect(extractTags('# \n#\nnothing')).toEqual([]);
});
