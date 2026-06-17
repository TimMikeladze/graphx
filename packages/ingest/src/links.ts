/** A link found in a node body. `wiki` resolves by basename; `path` by relative path. */
export interface Link {
	kind: 'wiki' | 'path';
	target: string;
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const MDLINK = /\[[^\]]*\]\(([^)]+)\)/g;

/** A match preceded by `!` is an image embed (`![alt](img)` / `![[embed]]`), not a link. */
function isEmbed(body: string, index: number): boolean {
	return index > 0 && body[index - 1] === '!';
}

/**
 * Extract `[[wikilinks]]` and relative `[text](path)` links; skip external/anchor links
 * and image embeds (`!`-prefixed).
 */
export function extractLinks(body: string): Link[] {
	const out: Link[] = [];
	for (const m of body.matchAll(WIKILINK)) {
		if (isEmbed(body, m.index)) continue;
		const target = m[1]!.split('|')[0]!.trim();
		if (target) out.push({ kind: 'wiki', target });
	}
	for (const m of body.matchAll(MDLINK)) {
		if (isEmbed(body, m.index)) continue;
		const target = m[1]!.trim();
		if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
		if (target.startsWith('#')) continue;
		out.push({ kind: 'path', target });
	}
	return out;
}
