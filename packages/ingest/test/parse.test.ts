import { expect, test } from 'bun:test';
import { parseFile } from '../src/parse.ts';

test('parseFile: markdown splits frontmatter and body, hashes raw', () => {
	const raw = '---\ntype: note\ntitle: Hello\n---\nbody text\n';
	const f = parseFile('notes/a.md', raw);
	expect(f.key).toBe('notes/a.md');
	expect(f.frontmatter).toEqual({ type: 'note', title: 'Hello' });
	expect(f.body.trim()).toBe('body text');
	expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
});

test('parseFile: pure YAML file becomes all-frontmatter, empty body', () => {
	const f = parseFile('people/bob.yaml', 'type: person\nname: Bob\n');
	expect(f.frontmatter).toEqual({ type: 'person', name: 'Bob' });
	expect(f.body).toBe('');
});

test('parseFile: same bytes hash identically, different bytes differ', () => {
	expect(parseFile('a.md', 'x').hash).toBe(parseFile('a.md', 'x').hash);
	expect(parseFile('a.md', 'x').hash).not.toBe(parseFile('a.md', 'y').hash);
});

test('parseFile: embedHash is sha256(body) and differs from hash when frontmatter is present', () => {
	const raw = '---\ntype: note\ntitle: Hello\n---\nbody text\n';
	const f = parseFile('notes/a.md', raw);
	// hash covers the full raw file; embedHash covers only the body
	expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
	expect(f.embedHash).toMatch(/^[0-9a-f]{64}$/);
	// They differ because the raw includes frontmatter, the embed input is body-only
	expect(f.embedHash).not.toBe(f.hash);
});
