import { readdir } from 'node:fs/promises';
import { sep } from 'node:path';
import { extname } from 'node:path/posix';

export const DEFAULT_INCLUDE: string[] = ['.md', '.markdown', '.yml', '.yaml'];

/** Recursively list files under `dir` whose extension is in `include`, as sorted POSIX keys. */
export async function discover(dir: string, include: string[]): Promise<string[]> {
	const exts = new Set(include.map((e) => e.toLowerCase()));
	const entries = await readdir(dir, { recursive: true });
	return entries
		.map((e) => e.split(sep).join('/'))
		.filter((e) => exts.has(extname(e).toLowerCase()))
		.sort();
}
