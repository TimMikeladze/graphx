import { basename, dirname, extname, join } from 'node:path/posix';
import type { Link } from './links.ts';

export interface PathIndex {
	byPath: Set<string>;
	byBasename: Map<string, string[]>;
}

function baseKey(key: string): string {
	return basename(key, extname(key)).toLowerCase();
}

/** Drop a trailing file extension, if any. */
function stripExt(key: string): string {
	const e = extname(key);
	return e ? key.slice(0, -e.length) : key;
}

/** Resolution outcome — distinguishes a genuine miss from an ambiguous basename. */
export type Resolution =
	| { status: 'resolved'; key: string }
	| { status: 'missing' }
	| { status: 'ambiguous'; candidates: string[] };

/** Index keys for link resolution: exact-path set + basename → keys (for wikilinks). */
export function buildPathIndex(keys: string[]): PathIndex {
	const byPath = new Set<string>(keys);
	const byBasename = new Map<string, string[]>();
	for (const key of keys) {
		const b = baseKey(key);
		const list = byBasename.get(b);
		if (list) list.push(key);
		else byBasename.set(b, [key]);
	}
	return { byPath, byBasename };
}

/**
 * Resolve a link to a vault key. Disambiguation, in order:
 * - `path` link → exact path relative to the source dir.
 * - folder-qualified wikilink (`[[dir/Note]]`, contains `/`) → exact path match (ext-insensitive).
 * - bare wikilink → unique basename; on a basename collision, prefer a same-folder match;
 *   otherwise `ambiguous` with the candidates (never a silent guess).
 */
export function resolveLink(link: Link, fromKey: string, index: PathIndex): Resolution {
	if (link.type === 'path') {
		const resolved = join(dirname(fromKey), link.target);
		return index.byPath.has(resolved) ? { status: 'resolved', key: resolved } : { status: 'missing' };
	}
	if (link.target.includes('/')) {
		const t = stripExt(link.target).toLowerCase();
		const cands = [...index.byPath].filter((k) => stripExt(k).toLowerCase() === t);
		if (cands.length === 1) return { status: 'resolved', key: cands[0]! };
		if (cands.length > 1) return { status: 'ambiguous', candidates: cands.sort() };
		return { status: 'missing' };
	}
	const hits = index.byBasename.get(baseKey(link.target));
	if (!hits || hits.length === 0) return { status: 'missing' };
	if (hits.length === 1) return { status: 'resolved', key: hits[0]! };
	const fromDir = dirname(fromKey);
	const sameFolder = hits.filter((k) => dirname(k) === fromDir);
	if (sameFolder.length === 1) return { status: 'resolved', key: sameFolder[0]! };
	return { status: 'ambiguous', candidates: [...hits].sort() };
}
