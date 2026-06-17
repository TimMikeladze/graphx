/** A link found in a node body. `wiki` resolves by basename; `path` by relative path. */
export interface Link {
	kind: 'wiki' | 'path';
	target: string;
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const MDLINK = /\[[^\]]*\]\(([^)]+)\)/g;

/** Extract `[[wikilinks]]` and relative `[text](path)` links; skip external/anchor links. */
export function extractLinks(body: string): Link[] {
	const out: Link[] = [];
	for (const m of body.matchAll(WIKILINK)) {
		const target = m[1]!.split('|')[0]!.trim();
		if (target) out.push({ kind: 'wiki', target });
	}
	for (const m of body.matchAll(MDLINK)) {
		const target = m[1]!.trim();
		if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
		if (target.startsWith('#')) continue;
		out.push({ kind: 'path', target });
	}
	return out;
}
