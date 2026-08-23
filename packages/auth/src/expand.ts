import { edgesInto } from './check.ts';
import type { DbClient } from 'graphx-core';
import type { AuthModel, RewriteExpr } from './model.ts';
import { typeOf } from './types.ts';

/** A userset tree (Zanzibar Expand). Leaf usersets are references — not recursively resolved. */
export type UsersetTree =
	| { type: 'leaf'; subjects: string[]; usersets: Array<{ object: string; relation: string }> }
	| { type: 'union'; children: UsersetTree[] }
	| { type: 'intersection'; children: UsersetTree[] }
	| { type: 'exclusion'; base: UsersetTree; subtract: UsersetTree };

interface ExpandCtx {
	raw: DbClient;
	model: AuthModel;
	asOf?: number;
	visited: Set<string>;
}

/** `self`: a leaf of direct subjects + userset references read from the tuples on (object, relation). */
async function expandSelf(ctx: ExpandCtx, object: string, relation: string): Promise<UsersetTree> {
	const subjects: string[] = [];
	const usersets: Array<{ object: string; relation: string }> = [];
	for (const { src, subjectRelation } of await edgesInto(ctx.raw, ctx.asOf, object, relation)) {
		if (subjectRelation === null) subjects.push(src);
		else usersets.push({ object: src, relation: subjectRelation });
	}
	subjects.sort();
	usersets.sort((a, b) => `${a.object}#${a.relation}`.localeCompare(`${b.object}#${b.relation}`));
	return { type: 'leaf', subjects, usersets };
}

/** Expand one rewrite node under (object, relation). */
async function expandExpr(
	ctx: ExpandCtx,
	object: string,
	relation: string,
	expr: RewriteExpr,
): Promise<UsersetTree> {
	switch (expr.kind) {
		case 'self':
			return expandSelf(ctx, object, relation);
		case 'computed':
			return expand(ctx, object, expr.relation);
		case 'ttu': {
			const parents = (await edgesInto(ctx.raw, ctx.asOf, object, expr.tupleset))
				.map((e) => e.src)
				.sort();
			const children: UsersetTree[] = [];
			for (const parent of parents) children.push(await expand(ctx, parent, expr.computed));
			return { type: 'union', children };
		}
		case 'union': {
			const children: UsersetTree[] = [];
			for (const c of expr.children) children.push(await expandExpr(ctx, object, relation, c));
			return { type: 'union', children };
		}
		case 'intersection': {
			const children: UsersetTree[] = [];
			for (const c of expr.children) children.push(await expandExpr(ctx, object, relation, c));
			return { type: 'intersection', children };
		}
		case 'exclusion':
			return {
				type: 'exclusion',
				base: await expandExpr(ctx, object, relation, expr.base),
				subtract: await expandExpr(ctx, object, relation, expr.subtract),
			};
		default:
			throw new Error(`auth: unhandled rewrite '${(expr as { kind: string }).kind}'`);
	}
}

/** Expand (object, relation) with a cycle guard (a revisited node yields an empty leaf). */
async function expand(ctx: ExpandCtx, object: string, relation: string): Promise<UsersetTree> {
	const key = `${object}#${relation}`;
	if (ctx.visited.has(key)) return { type: 'leaf', subjects: [], usersets: [] };
	ctx.visited.add(key);
	const expr = ctx.model.rewrite(typeOf(object), relation); // throws on unknown type/relation
	const tree = await expandExpr(ctx, object, relation, expr);
	ctx.visited.delete(key);
	return tree;
}

/** Entry point: expand (object, relation) into a userset tree at one `asOf` snapshot. */
export function runExpand(
	raw: DbClient,
	model: AuthModel,
	object: string,
	relation: string,
	asOf?: number,
): Promise<UsersetTree> {
	return expand({ raw, model, asOf, visited: new Set() }, object, relation);
}
