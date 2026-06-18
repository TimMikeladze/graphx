/** A link found in a node body. `wiki` resolves by basename; `path` by relative path. */
export interface Link {
	kind: 'wiki' | 'path';
	target: string;
	/** Set when the link is preceded by a Dataview inline field `[key:: link]`. */
	rel?: string;
}

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const MDLINK = /\[[^\]]*\]\(([^)]+)\)/g;

/**
 * Matches a Dataview inline typed link: `[key:: [[wikilink]]]` or `[key:: [text](path)]`.
 * Group 1: key, group 2: wikilink target (wiki form), group 3: path target (path form).
 */
const TYPED_LINK =
	/\[([A-Za-z][\w-]*):: (?:\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)]+)\))\]/g;

/** A match preceded by `!` is an image embed (`![alt](img)` / `![[embed]]`), not a link. */
function isEmbed(body: string, index: number): boolean {
	return index > 0 && body[index - 1] === '!';
}

/**
 * Extract `[[wikilinks]]` and relative `[text](path)` links; skip external/anchor links
 * and image embeds (`!`-prefixed). Recognizes Dataview inline fields `[key:: link]` and
 * sets `rel` on the resulting link.
 */
export function extractLinks(body: string): Link[] {
	// Collect typed links and record their span [start, end) to suppress plain-link matches inside.
	const entries: Array<{ link: Link; start: number }> = [];
	const typedSpans: Array<[number, number]> = [];

	for (const m of body.matchAll(TYPED_LINK)) {
		if (isEmbed(body, m.index)) continue;
		const rel = m[1]!;
		const start = m.index;
		const end = start + m[0].length;
		if (m[2] !== undefined) {
			// wiki form: [[target]]
			const target = m[2].trim();
			if (target) {
				entries.push({ link: { kind: 'wiki', target, rel }, start });
				typedSpans.push([start, end]);
			}
		} else if (m[3] !== undefined) {
			// path form: [text](target)
			const target = m[3].trim();
			if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
			if (target.startsWith('#')) continue;
			entries.push({ link: { kind: 'path', target, rel }, start });
			typedSpans.push([start, end]);
		}
	}

	/** Returns true if `idx` falls within any typed-link span. */
	function inTypedSpan(idx: number): boolean {
		for (const [s, e] of typedSpans) {
			if (idx >= s && idx < e) return true;
		}
		return false;
	}

	for (const m of body.matchAll(WIKILINK)) {
		if (isEmbed(body, m.index)) continue;
		if (inTypedSpan(m.index)) continue;
		const target = m[1]!.split('|')[0]!.trim();
		if (target) entries.push({ link: { kind: 'wiki', target }, start: m.index });
	}
	for (const m of body.matchAll(MDLINK)) {
		if (isEmbed(body, m.index)) continue;
		if (inTypedSpan(m.index)) continue;
		const target = m[1]!.trim();
		if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
		if (target.startsWith('#')) continue;
		entries.push({ link: { kind: 'path', target }, start: m.index });
	}

	entries.sort((a, b) => a.start - b.start);
	return entries.map((e) => e.link);
}

/**
 * Extract embeds — the `!`-prefixed forms `![[target]]` / `![alt](target)` that
 * {@link extractLinks} deliberately skips. Used (opt-in) to turn embedded assets into nodes.
 * External (`http(s)://`) and anchor (`#`) targets are skipped.
 */
export function extractEmbeds(body: string): Link[] {
	const out: Link[] = [];
	for (const m of body.matchAll(WIKILINK)) {
		if (!isEmbed(body, m.index)) continue;
		const target = m[1]!.split('|')[0]!.trim();
		if (target) out.push({ kind: 'wiki', target });
	}
	for (const m of body.matchAll(MDLINK)) {
		if (!isEmbed(body, m.index)) continue;
		const target = m[1]!.trim();
		if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
		if (target.startsWith('#')) continue;
		out.push({ kind: 'path', target });
	}
	return out;
}
