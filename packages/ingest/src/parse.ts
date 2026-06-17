import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { ParsedFile } from './types.ts';

const YAML_EXT = /\.ya?ml$/i;

/**
 * Parse a source file into frontmatter + body. Markdown files use gray-matter's
 * `---` frontmatter; pure-YAML files are wrapped so their whole content is parsed as
 * frontmatter (body empty). `hash` is sha256 of the raw bytes (the change-detection key).
 */
export function parseFile(key: string, raw: string): ParsedFile {
	const isYaml = YAML_EXT.test(key);
	const src = isYaml ? `---\n${raw}\n---\n` : raw;
	const parsed = matter(src);
	return {
		key,
		raw,
		hash: createHash('sha256').update(raw).digest('hex'),
		frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
		body: isYaml ? '' : parsed.content,
	};
}
