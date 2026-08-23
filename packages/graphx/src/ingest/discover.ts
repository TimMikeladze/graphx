import { readdir } from 'node:fs/promises';
import { sep } from 'node:path';
import { extname } from 'node:path/posix';

export const DEFAULT_INCLUDE: string[] = ['.md', '.markdown', '.yml', '.yaml'];

/**
 * True if any path segment starts with `.` — a dot-file or a dot-directory.
 *
 * These are tool state, never vault content, and ingesting them is actively harmful: Obsidian's
 * `.trash/` holds notes the user DELETED, and since `.trash` sorts before most folders, a trashed
 * copy sharing a frontmatter `id` with its live original claims that identity first and the live
 * file is skipped as a duplicate — the deleted text silently replaces the current one.
 */
function isHidden(key: string): boolean {
	return key.split('/').some((seg) => seg.startsWith('.'));
}

/**
 * Recursively list files under `dir` whose extension is in `include`, as sorted POSIX keys.
 * Hidden paths are always skipped. Further filtering is `ingestDir`'s `exclude` option, applied
 * to every Source's key list rather than only this one.
 */
export async function discover(dir: string, include: string[]): Promise<string[]> {
	const exts = new Set(include.map((e) => e.toLowerCase()));
	const entries = await readdir(dir, { recursive: true });
	return entries
		.map((e) => e.split(sep).join('/'))
		.filter((e) => exts.has(extname(e).toLowerCase()))
		.filter((e) => !isHidden(e))
		.sort();
}
