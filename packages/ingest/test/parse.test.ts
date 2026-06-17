import { expect, test } from 'bun:test';
import { parseFile } from '../src/parse.ts';

test('parseFile: markdown splits frontmatter and body, hashes raw', () => {
	const raw = '---\nkind: note\ntitle: Hello\n---\nbody text\n';
	const f = parseFile('notes/a.md', raw);
	expect(f.key).toBe('notes/a.md');
	expect(f.frontmatter).toEqual({ kind: 'note', title: 'Hello' });
	expect(f.body.trim()).toBe('body text');
	expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
});

test('parseFile: pure YAML file becomes all-frontmatter, empty body', () => {
	const f = parseFile('people/bob.yaml', 'kind: person\nname: Bob\n');
	expect(f.frontmatter).toEqual({ kind: 'person', name: 'Bob' });
	expect(f.body).toBe('');
});

test('parseFile: same bytes hash identically, different bytes differ', () => {
	expect(parseFile('a.md', 'x').hash).toBe(parseFile('a.md', 'x').hash);
	expect(parseFile('a.md', 'x').hash).not.toBe(parseFile('a.md', 'y').hash);
});
