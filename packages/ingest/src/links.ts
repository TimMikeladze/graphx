/** A link found in a node body. `wiki` resolves by basename; `path` by relative path. */
export interface Link {
	type: 'wiki' | 'path';
	target: string;
	/** Set when the link is preceded by a Dataview inline field `[key:: link]`. */
	rel?: string;
	/**
	 * Subdocument target from an Obsidian `#` suffix — a heading (`[[note#Intro]]`) or a block
	 * ref (`[[note#^abc123]]`, leading `^` retained). The edge still points at the whole note;
	 * the fragment rides along as edge data.
	 */
	fragment?: string;
}

/**
 * Split an Obsidian `#` suffix off a link target. A target that is only a fragment
 * (`[[#Intro]]`, `[here](#Intro)`) is an in-page anchor and yields an empty target,
 * which callers drop.
 */
function splitFragment(target: string): { target: string; fragment?: string } {
	const i = target.indexOf('#');
	if (i === -1) return { target };
	const fragment = target.slice(i + 1).trim();
	const base = target.slice(0, i).trim();
	return fragment ? { target: base, fragment } : { target: base };
}

/**
 * Percent-decode a markdown-style link target — Obsidian writes `[my note](my%20note.md)`, and
 * spaces in note names are the norm, so an undecoded target matches no file. A malformed escape
 * (a literal `%` in a filename, `100%discount.md`) is left verbatim rather than throwing.
 *
 * Only ever applied AFTER {@link splitFragment}: decoding first would turn a `%23` that belongs to
 * the filename into a `#` and split the name in half.
 */
function decodePath(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

/** Split a path-link target's fragment, then decode both halves. Wikilinks are never encoded. */
function splitPathTarget(raw: string): { target: string; fragment?: string } {
	const { target, fragment } = splitFragment(raw);
	return { target: decodePath(target), ...(fragment ? { fragment: decodePath(fragment) } : {}) };
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
			const { target, fragment } = splitFragment(m[2].trim());
			if (target) {
				entries.push({ link: { type: 'wiki', target, rel, ...(fragment ? { fragment } : {}) }, start });
				typedSpans.push([start, end]);
			}
		} else if (m[3] !== undefined) {
			// path form: [text](target)
			const raw = m[3].trim();
			if (!raw || raw.startsWith('http://') || raw.startsWith('https://')) continue;
			if (raw.startsWith('#')) continue;
			const { target, fragment } = splitPathTarget(raw);
			if (!target) continue;
			entries.push({ link: { type: 'path', target, rel, ...(fragment ? { fragment } : {}) }, start });
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
		const { target, fragment } = splitFragment(m[1]!.split('|')[0]!.trim());
		if (target) {
			entries.push({ link: { type: 'wiki', target, ...(fragment ? { fragment } : {}) }, start: m.index });
		}
	}
	for (const m of body.matchAll(MDLINK)) {
		if (isEmbed(body, m.index)) continue;
		if (inTypedSpan(m.index)) continue;
		const raw = m[1]!.trim();
		if (!raw || raw.startsWith('http://') || raw.startsWith('https://')) continue;
		if (raw.startsWith('#')) continue;
		const { target, fragment } = splitPathTarget(raw);
		if (!target) continue;
		entries.push({ link: { type: 'path', target, ...(fragment ? { fragment } : {}) }, start: m.index });
	}

	entries.sort((a, b) => a.start - b.start);
	return entries.map((e) => e.link);
}

/** Spans that can contain a `#` which is NOT a tag: code, wikilinks, and markdown link targets. */
const TAG_MASKS = [
	/```[\s\S]*?```/g, // fenced code
	/`[^`\n]*`/g, // inline code
	/!?\[\[[^\]]*\]\]/g, // wikilinks + embeds — `[[note#Intro]]` must not mint an `Intro` tag
	/\]\([^)]*\)/g, // markdown link targets — `[b](./b.md#Intro)`
];

/**
 * An Obsidian tag: `#` then letters/digits/`_`/`-`/`/`, with at least one non-digit so an issue
 * reference (`#123`) is not a tag. The `#` must not follow a word character (`abc#def`) or another
 * `#` (`## Heading`), and a heading is excluded anyway by the space that follows its hashes.
 */
const TAG = /(?<![\w#/])#([\w/-]*[A-Za-z_/-][\w/-]*)/g;

/**
 * Extract inline `#tags` from a body, in first-seen order, de-duplicated case-insensitively
 * (the first spelling wins). Masked regions are blanked — not removed — so no two neighbouring
 * fragments are accidentally joined into a new match.
 */
export function extractTags(body: string): string[] {
	let masked = body;
	for (const re of TAG_MASKS) masked = masked.replace(re, (m) => ' '.repeat(m.length));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of masked.matchAll(TAG)) {
		const tag = m[1]!;
		const k = tag.toLowerCase();
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(tag);
	}
	return out;
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
		const { target, fragment } = splitFragment(m[1]!.split('|')[0]!.trim());
		if (target) out.push({ type: 'wiki', target, ...(fragment ? { fragment } : {}) });
	}
	for (const m of body.matchAll(MDLINK)) {
		if (!isEmbed(body, m.index)) continue;
		const raw = m[1]!.trim();
		if (!raw || raw.startsWith('http://') || raw.startsWith('https://')) continue;
		if (raw.startsWith('#')) continue;
		const { target, fragment } = splitPathTarget(raw);
		if (!target) continue;
		out.push({ type: 'path', target, ...(fragment ? { fragment } : {}) });
	}
	return out;
}
