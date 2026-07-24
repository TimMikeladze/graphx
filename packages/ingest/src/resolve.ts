import { basename, dirname, extname, join } from 'node:path/posix';
import type { Link } from './links.ts';

export interface PathIndex {
	byPath: Set<string>;
	/**
	 * Lowercased basename → keys, indexed BOTH with and without the file extension, so a target
	 * is matched verbatim and never re-parsed at lookup time. `note/v1.2.md` indexes under both
	 * `v1.2` and `v1.2.md`; stripping an extension off the TARGET instead would read `[[v1.2]]`
	 * as `v1` (`extname('v1.2')` is `'.2'`) and miss the file.
	 */
	byBasename: Map<string, string[]>;
	/** Lowercased full path, with and without extension. Folder-qualified wikilinks only. */
	byPathName: Map<string, string[]>;
	/** Lowercased frontmatter alias → keys. Consulted only after `byBasename` misses. */
	byAlias: Map<string, string[]>;
}

/** Drop a trailing file extension, if any. */
function stripExt(key: string): string {
	const e = extname(key);
	return e ? key.slice(0, -e.length) : key;
}

/**
 * Append `key` under each of `names`. Names are de-duplicated per key BEFORE insertion — an
 * extension-less key yields the same name with and without `stripExt`, and a file may repeat an
 * alias. Scanning the bucket for an existing entry instead would be quadratic on a vault where
 * thousands of files share a basename (`index.md` per folder): 10k such files cost ~490ms.
 */
function addNames(map: Map<string, string[]>, names: string[], key: string): void {
	const seen = new Set<string>();
	for (const raw of names) {
		const n = raw.trim().toLowerCase();
		if (!n || seen.has(n)) continue;
		seen.add(n);
		const list = map.get(n);
		if (list) list.push(key);
		else map.set(n, [key]);
	}
}

/** Resolution outcome — distinguishes a genuine miss from an ambiguous basename. */
export type Resolution =
	| { status: 'resolved'; key: string }
	| { status: 'missing' }
	| { status: 'ambiguous'; candidates: string[] };

/** Look a normalized name up in one index. `null` — not `missing` — lets the caller try the next form. */
function lookup(map: Map<string, string[]>, name: string): Resolution | null {
	const cands = map.get(name.trim().toLowerCase());
	if (!cands || cands.length === 0) return null;
	if (cands.length === 1) return { status: 'resolved', key: cands[0]! };
	return { status: 'ambiguous', candidates: [...cands].sort() };
}

/**
 * Index keys for link resolution: exact-path set, basename → keys, full path → keys (for
 * folder-qualified wikilinks), plus optional frontmatter aliases (`aliases: [Bee]`) as secondary
 * wikilink names.
 *
 * Every name is normalized HERE rather than at lookup time. That keeps resolution a hash lookup
 * instead of a scan of every vault key — the difference between 0.1ms and 600ms per 200 links in
 * a 20k-note vault.
 */
export function buildPathIndex(keys: string[], aliases?: Map<string, string[]>): PathIndex {
	const byPath = new Set<string>(keys);
	const byBasename = new Map<string, string[]>();
	const byPathName = new Map<string, string[]>();
	for (const key of keys) {
		const noExt = stripExt(key);
		addNames(byBasename, [basename(key), basename(noExt)], key);
		addNames(byPathName, [key, noExt], key);
	}
	const byAlias = new Map<string, string[]>();
	for (const [key, names] of aliases ?? []) addNames(byAlias, names, key);
	return { byPath, byBasename, byPathName, byAlias };
}

/**
 * Resolve a link to a vault key. Disambiguation, in order:
 * - `path` link → exact path relative to the source dir.
 * - folder-qualified wikilink (`[[dir/Note]]`, contains `/`) → exact path match from the vault
 *   root (ext-insensitive), then relative to the linking file — Obsidian's own order.
 * - bare wikilink → unique basename, else a unique frontmatter alias; on a collision, prefer a
 *   same-folder match; otherwise `ambiguous` with the candidates (never a silent guess).
 */
export function resolveLink(link: Link, fromKey: string, index: PathIndex): Resolution {
	if (link.type === 'path') {
		const resolved = join(dirname(fromKey), link.target);
		return index.byPath.has(resolved) ? { status: 'resolved', key: resolved } : { status: 'missing' };
	}
	if (link.target.includes('/')) {
		// Obsidian order: vault-root path first, then a path relative to the linking file.
		return (
			lookup(index.byPathName, link.target) ??
			lookup(index.byPathName, join(dirname(fromKey), link.target)) ?? { status: 'missing' }
		);
	}
	// A real filename owns its name outright; aliases are only consulted when no file claims it,
	// so adding `aliases: [gamma]` to one note can never hijack links meant for `gamma.md`.
	const name = link.target.trim().toLowerCase();
	const hits = index.byBasename.get(name) ?? index.byAlias.get(name);
	if (!hits || hits.length === 0) return { status: 'missing' };
	if (hits.length === 1) return { status: 'resolved', key: hits[0]! };
	const fromDir = dirname(fromKey);
	const sameFolder = hits.filter((k) => dirname(k) === fromDir);
	if (sameFolder.length === 1) return { status: 'resolved', key: sameFolder[0]! };
	return { status: 'ambiguous', candidates: [...hits].sort() };
}
