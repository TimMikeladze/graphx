import { z } from 'zod';
import { defineGraphSchema, type EdgeDef, type GraphSchema, type ZObj } from '../core/index.ts';

/**
 * A userset rewrite expression.
 * - `self`         — direct tuples on (object, relation)
 * - `computed`     — same object, another relation
 * - `ttu`          — follow `tupleset` edges to parent objects, then `computed` on each
 * - `union` / `intersection` / `exclusion` — set operators
 */
export type RewriteExpr =
	| { kind: 'self' }
	| { kind: 'computed'; relation: string }
	| { kind: 'ttu'; tupleset: string; computed: string }
	| { kind: 'union'; children: RewriteExpr[] }
	| { kind: 'intersection'; children: RewriteExpr[] }
	| { kind: 'exclusion'; base: RewriteExpr; subtract: RewriteExpr };

/** An operand to a set operator: a relation name (computed userset) or a {@link tupleToUserset}. */
export type Operand = string | RewriteExpr;

/**
 * One relation's definition and builder. A bare `rel()` is direct tuples (`self`).
 * Operators combine with fixed precedence: `(self ∪ or) ∩ and − minus`.
 */
export interface Relation {
	rewrite: RewriteExpr;
	/** Mark direct tuples included (default). */
	self(): Relation;
	/** Union: also holders of `term` on the same object (string) or via a ttu. */
	or(term: Operand): Relation;
	/** Intersection: must ALSO satisfy `term`. */
	and(term: Operand): Relation;
	/** Exclusion: must NOT satisfy `term`. */
	minus(term: Operand): Relation;
}

/** Model spec: object type → its relations. A type with no relations (e.g. `user`) is `{}`. */
export type ModelSpec = Record<string, Record<string, Relation>>;

/** A compiled authorization model: lookups + the graphx schema its tuples are stored under. */
export interface AuthModel {
	spec: ModelSpec;
	types: string[];
	relationsOf(type: string): string[];
	rewrite(type: string, relation: string): RewriteExpr;
	schema: GraphSchema;
}

/** Follow `tupleset` edges from the object to parent objects, then evaluate `computed` on each. */
export function tupleToUserset(tupleset: string, computed: string): RewriteExpr {
	return { kind: 'ttu', tupleset, computed };
}

function toExpr(term: Operand): RewriteExpr {
	return typeof term === 'string' ? { kind: 'computed', relation: term } : term;
}

class RelationBuilder implements Relation {
	private readonly orTerms: RewriteExpr[] = [];
	private readonly andTerms: RewriteExpr[] = [];
	private readonly minusTerms: RewriteExpr[] = [];
	self(): Relation {
		return this;
	}
	or(term: Operand): Relation {
		this.orTerms.push(toExpr(term));
		return this;
	}
	and(term: Operand): Relation {
		this.andTerms.push(toExpr(term));
		return this;
	}
	minus(term: Operand): Relation {
		this.minusTerms.push(toExpr(term));
		return this;
	}
	get rewrite(): RewriteExpr {
		// `self` (direct tuples) is always a positive term — a relation is at least its own
		// direct grants. Pure set-op-only relations (no direct tuples) are not expressible by design.
		const positives: RewriteExpr[] = [{ kind: 'self' }, ...this.orTerms];
		let expr: RewriteExpr =
			positives.length === 1 ? { kind: 'self' } : { kind: 'union', children: positives };
		if (this.andTerms.length > 0) {
			expr = { kind: 'intersection', children: [expr, ...this.andTerms] };
		}
		for (const m of this.minusTerms) {
			expr = { kind: 'exclusion', base: expr, subtract: m };
		}
		return expr;
	}
}

/** Declare a relation. Chain `.or`/`.and`/`.minus` (with `tupleToUserset` operands) for set rewrites. */
export function rel(): Relation {
	return new RelationBuilder();
}

/** Validate every same-type reference in a rewrite tree; throws on an unknown relation/tupleset. */
function validateRefs(
	expr: RewriteExpr,
	type: string,
	byType: Record<string, Relation>,
	relation: string,
): void {
	switch (expr.kind) {
		case 'self':
			return;
		case 'computed':
			if (!byType[expr.relation]) {
				throw new Error(
					`auth: relation '${relation}' on type '${type}' references unknown relation '${expr.relation}'`,
				);
			}
			return;
		case 'ttu':
			if (!byType[expr.tupleset]) {
				throw new Error(
					`auth: relation '${relation}' on type '${type}' references unknown tupleset relation '${expr.tupleset}'`,
				);
			}
			// `computed` is evaluated on the parent object's type at runtime — not checked here.
			return;
		case 'union':
		case 'intersection':
			for (const c of expr.children) validateRefs(c, type, byType, relation);
			return;
		case 'exclusion':
			validateRefs(expr.base, type, byType, relation);
			validateRefs(expr.subtract, type, byType, relation);
			return;
	}
}

/** Build an {@link AuthModel}, validate references, and compile its graphx schema. */
export function defineAuthModel(spec: ModelSpec): AuthModel {
	const types = Object.keys(spec);

	const nodes: Record<string, ZObj> = {};
	const edges: Record<string, EdgeDef<string>> = {};
	for (const type of types) {
		nodes[type] = z.object({});
		const byType = spec[type] ?? {};
		for (const relation of Object.keys(byType)) {
			edges[relation] = {};
			validateRefs(byType[relation]!.rewrite, type, byType, relation);
		}
	}
	const schema = defineGraphSchema({ nodes, edges }) as GraphSchema;

	return {
		spec,
		types,
		relationsOf: (type: string): string[] => Object.keys(spec[type] ?? {}),
		rewrite: (type: string, relation: string): RewriteExpr => {
			const byType = spec[type];
			if (!byType) throw new Error(`auth: unknown type '${type}'`);
			const r = byType[relation];
			if (!r) throw new Error(`auth: unknown relation '${relation}' on type '${type}'`);
			return r.rewrite;
		},
		schema,
	};
}
