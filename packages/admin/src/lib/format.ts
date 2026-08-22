/** Presentation helpers for graph ids + timestamps (kept pure + trivially testable). */

/** libSQL FOREVER sentinel — an open (live) version's `valid_to`. */
export const FOREVER = 8640000000000000;

/**
 * Abbreviate a ULID/opaque id for dense display: keep the leading chars (timestamp prefix) and
 * the trailing chars (the distinguishing random tail), eliding the middle. Short ids pass through.
 */
export function shortId(id: string, head = 6, tail = 4): string {
	if (id.length <= head + tail + 1) return id;
	return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Format an as-of/version epoch; the FOREVER sentinel reads as `live`. */
export function fmtTime(epoch: number): string {
	return epoch >= FOREVER ? 'live' : new Date(epoch).toLocaleString();
}

/** Property keys, in priority order, that carry a human-readable node label. */
const LABEL_KEYS = ['name', 'title', 'label', 'displayName', 'display_name', 'heading', 'slug'];

/**
 * Pull the best human-readable label out of a node's `data` — so lists/inspectors can lead with
 * "Bletchley Park" instead of an opaque ULID. Returns undefined when nothing suitable exists
 * (callers fall back to {@link shortId}).
 */
export function bestLabel(data: Record<string, unknown> | undefined | null): string | undefined {
	if (!data) return undefined;
	for (const k of LABEL_KEYS) {
		const v = data[k];
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return undefined;
}
