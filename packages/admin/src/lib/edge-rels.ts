import type { SchemaEdgeRel } from './types';

/**
 * Which relations may join two nodes, per the declared schema. A rel with `from`/`to` constrains
 * its endpoints to those node types; a rel with neither accepts any pair.
 *
 * This is what the edge editor offers, so it fails fast and locally instead of letting the user
 * pick a rel the server will reject. It is a filter, not a guarantee — the server still validates,
 * and it also enforces things this cannot see (single-valued rels, per-rel data schemas).
 */
export function relsFor(
	rels: SchemaEdgeRel[],
	srcType?: string,
	dstType?: string,
): SchemaEdgeRel[] {
	return rels.filter((rel) => accepts(rel.from, srcType) && accepts(rel.to, dstType));
}

/** `null` ⇒ unconstrained. An unknown endpoint type cannot be ruled out, so it passes. */
function accepts(allowed: string[] | null, type?: string): boolean {
	if (allowed === null || type === undefined) return true;
	return allowed.includes(type);
}

/**
 * Why no rel fits a pair — the message the editor shows instead of an empty dropdown. `undefined`
 * when at least one rel matches.
 */
export function noRelReason(
	rels: SchemaEdgeRel[],
	srcType?: string,
	dstType?: string,
): string | undefined {
	if (relsFor(rels, srcType, dstType).length > 0) return undefined;
	if (rels.length === 0) return 'This project declares no relations.';
	return `No declared relation goes from ${srcType ?? 'this type'} to ${dstType ?? 'that type'}.`;
}
