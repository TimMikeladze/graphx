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

test('resolveLink: a folder-qualified wikilink falls back to a path relative to the linking file', () => {
	// Obsidian resolution order: vault-root path, THEN relative to the linking file. `sub/dupe`
	// is not a root path, but `note/` + `sub/dupe` is — the form a real Obsidian vault emits.
	const nested = buildPathIndex(['note/alpha.md', 'note/sub/dupe.md']);
	expect(resolveLink({ type: 'wiki', target: 'sub/dupe' }, 'note/alpha.md', nested)).toEqual({
		status: 'resolved',
		key: 'note/sub/dupe.md',
	});
});

test('resolveLink: a root-relative match wins over a relative-to-file match', () => {
	// Both `x/a.md` (root) and `from/x/a.md` (relative to `from/here.md`) match `x/a`.
	// Root is tried first, so it wins — matching Obsidian's documented order.
	const both = buildPathIndex(['x/a.md', 'from/x/a.md', 'from/here.md']);
	expect(resolveLink({ type: 'wiki', target: 'x/a' }, 'from/here.md', both)).toEqual({
		status: 'resolved',
		key: 'x/a.md',
	});
});

test('resolveLink: an ambiguous relative-to-file match reports candidates', () => {
	const dup = buildPathIndex(['note/sub/dupe.md', 'note/sub/dupe.markdown']);
	expect(resolveLink({ type: 'wiki', target: 'sub/dupe' }, 'note/alpha.md', dup)).toEqual({
		status: 'ambiguous',
		candidates: ['note/sub/dupe.markdown', 'note/sub/dupe.md'],
	});
});

test('resolveLink: a folder-qualified wikilink that matches neither form is missing', () => {
	const nested = buildPathIndex(['note/alpha.md', 'note/sub/dupe.md']);
	expect(resolveLink({ type: 'wiki', target: 'other/ghost' }, 'note/alpha.md', nested)).toEqual({
		status: 'missing',
	});
});

test('resolveLink: a wikilink resolves through a frontmatter alias', () => {
	const aliased = buildPathIndex(['note/beta.md'], new Map([['note/beta.md', ['Bee', 'B-note']]]));
	expect(resolveLink({ type: 'wiki', target: 'Bee' }, 'note/alpha.md', aliased)).toEqual({
		status: 'resolved',
		key: 'note/beta.md',
	});
	expect(resolveLink({ type: 'wiki', target: 'b-NOTE' }, 'note/alpha.md', aliased)).toEqual({
		status: 'resolved',
		key: 'note/beta.md',
	});
});

test('resolveLink: a real basename beats an alias claiming the same name', () => {
	// `gamma.md` owns the name `gamma`; beta merely aliases it. Explicit file identity wins.
	const aliased = buildPathIndex(
		['note/beta.md', 'note/gamma.md'],
		new Map([['note/beta.md', ['gamma']]]),
	);
	expect(resolveLink({ type: 'wiki', target: 'gamma' }, 'note/alpha.md', aliased)).toEqual({
		status: 'resolved',
		key: 'note/gamma.md',
	});
});

test('resolveLink: two files sharing an alias are ambiguous, not a silent pick', () => {
	const aliased = buildPathIndex(
		['note/beta.md', 'note/gamma.md'],
		new Map([
			['note/beta.md', ['shared']],
			['note/gamma.md', ['shared']],
		]),
	);
	expect(resolveLink({ type: 'wiki', target: 'shared' }, 'note/alpha.md', aliased)).toEqual({
		status: 'ambiguous',
		candidates: ['note/beta.md', 'note/gamma.md'],
	});
});

test('resolveLink: a wikilink to a file whose NAME contains a dot resolves', () => {
	// `extname('v1.2')` is '.2', so stripping an extension off the LINK TARGET (rather than off
	// the indexed filename) turned `[[v1.2]]` into a lookup for `v1` and missed the file.
	const dotted = buildPathIndex(['note/v1.2.md', 'note/alpha.md']);
	expect(resolveLink({ type: 'wiki', target: 'v1.2' }, 'note/alpha.md', dotted)).toEqual({
		status: 'resolved',
		key: 'note/v1.2.md',
	});
});

test('resolveLink: an alias containing a dot resolves', () => {
	const dotted = buildPathIndex(['note/a.md', 'note/b.md'], new Map([['note/b.md', ['ver1.2']]]));
	expect(resolveLink({ type: 'wiki', target: 'ver1.2' }, 'note/a.md', dotted)).toEqual({
		status: 'resolved',
		key: 'note/b.md',
	});
});

test('resolveLink: a wikilink written WITH its extension resolves', () => {
	const idx = buildPathIndex(['note/beta.md', 'note/alpha.md']);
	expect(resolveLink({ type: 'wiki', target: 'beta.md' }, 'note/alpha.md', idx)).toEqual({
		status: 'resolved',
		key: 'note/beta.md',
	});
});

test('resolveLink: a folder-qualified wikilink with a dotted name resolves', () => {
	const dotted = buildPathIndex(['note/sub/v1.2.md', 'note/alpha.md']);
	expect(resolveLink({ type: 'wiki', target: 'sub/v1.2' }, 'note/alpha.md', dotted)).toEqual({
		status: 'resolved',
		key: 'note/sub/v1.2.md',
	});
});

test('buildPathIndex: an extension-less key is indexed once, not duplicated into ambiguity', () => {
	// `basename(k)` and `basename(stripExt(k))` coincide when there is no extension; indexing both
	// blindly would put the key in its own bucket twice and report a phantom `ambiguous`.
	const idx = buildPathIndex(['note/LICENSE']);
	expect(idx.byBasename.get('license')).toEqual(['note/LICENSE']);
	expect(idx.byPathName.get('note/license')).toEqual(['note/LICENSE']);
	expect(resolveLink({ type: 'wiki', target: 'LICENSE' }, 'note/a.md', idx)).toEqual({
		status: 'resolved',
		key: 'note/LICENSE',
	});
});

test('buildPathIndex: a repeated alias on one file does not duplicate it into ambiguity', () => {
	const idx = buildPathIndex(['note/b.md'], new Map([['note/b.md', ['Bee', 'bee', ' Bee ']]]));
	expect(idx.byAlias.get('bee')).toEqual(['note/b.md']);
	expect(resolveLink({ type: 'wiki', target: 'Bee' }, 'note/a.md', idx)).toEqual({
		status: 'resolved',
		key: 'note/b.md',
	});
});
