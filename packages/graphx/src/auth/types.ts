/** A ReBAC relationship tuple `⟨object, relation, subject⟩` (Zanzibar). */
export interface Tuple {
	/** Object ref, `type:id` (e.g. `doc:42`). */
	object: string;
	/** Relation name defined on the object's type (e.g. `viewer`). */
	relation: string;
	/** Subject ref, `type:id` (e.g. `user:alice` or `group:eng`). */
	subject: string;
	/** Userset subject relation (e.g. `member` for `group:eng#member`). P2+ — rejected in P1. */
	subjectRelation?: string;
}

/** Split a ref `type:id` on the FIRST colon. Throws if either side is empty. */
export function parseRef(ref: string): { type: string; id: string } {
	const i = ref.indexOf(':');
	if (i <= 0 || i >= ref.length - 1) {
		throw new Error(`auth: invalid ref '${ref}' (expected 'type:id')`);
	}
	return { type: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** The type segment of a ref (`doc:42` → `doc`). */
export function typeOf(ref: string): string {
	return parseRef(ref).type;
}
