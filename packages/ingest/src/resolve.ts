import { basename, dirname, extname, join } from 'node:path/posix';
import type { Link } from './links.ts';

export interface PathIndex {
	byPath: Set<string>;
	byBasename: Map<string, string[]>;
}

function baseKey(key: string): string {
	return basename(key, extname(key)).toLowerCase();
}

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

/** Resolve a link to a vault key, or `null` if unresolved/ambiguous. */
export function resolveLink(link: Link, fromKey: string, index: PathIndex): string | null {
	if (link.kind === 'path') {
		const resolved = join(dirname(fromKey), link.target);
		return index.byPath.has(resolved) ? resolved : null;
	}
	const hits = index.byBasename.get(baseKey(link.target));
	return hits && hits.length === 1 ? hits[0]! : null;
}
