import type { Client } from '@libsql/client';
import type { AuthModel, RewriteExpr } from './model.ts';
import { typeOf } from './types.ts';

/** Per-check context: one `asOf` snapshot, shared memo + cycle-guard across the recursion. */
interface CheckCtx {
	raw: Client;
	model: AuthModel;
	asOf?: number;
	memo: Map<string, boolean>;
	stack: Set<string>;
}

/** Edges pointing INTO (object, relation): `subjectRelation` is null for direct grants. */
export async function edgesInto(
	raw: Client,
	asOf: number | undefined,
	object: string,
	relation: string,
): Promise<Array<{ src: string; subjectRelation: string | null }>> {
	const sql =
		asOf === undefined
			? `SELECT src, json_extract(props, '$.subjectRelation') AS sr FROM edges WHERE dst = ? AND rel = ?`
			: `SELECT src, json_extract(props, '$.subjectRelation') AS sr FROM edge_versions
				WHERE dst = ? AND rel = ? AND valid_from <= ? AND valid_to > ?`;
	const args = asOf === undefined ? [object, relation] : [object, relation, asOf, asOf];
	const r = await raw.execute({ sql, args });
	return r.rows.map((row) => ({
		src: String(row.src),
		subjectRelation: row.sr === null ? null : String(row.sr),
	}));
}

/** `self`: a direct edge `subject→object`, or a userset edge whose members include `subject`. */
async function evalSelf(
	ctx: CheckCtx,
	object: string,
	relation: string,
	subject: string,
): Promise<boolean> {
	for (const { src, subjectRelation } of await edgesInto(ctx.raw, ctx.asOf, object, relation)) {
		if (subjectRelation === null) {
			if (src === subject) return true;
		} else if (await check(ctx, src, subjectRelation, subject)) {
			return true;
		}
	}
	return false;
}

/** Evaluate one rewrite node under (object, relation, subject). */
async function evalExpr(
	ctx: CheckCtx,
	object: string,
	relation: string,
	subject: string,
	expr: RewriteExpr,
): Promise<boolean> {
	switch (expr.kind) {
		case 'self':
			return evalSelf(ctx, object, relation, subject);
		case 'computed':
			return check(ctx, object, expr.relation, subject);
		case 'ttu': {
			// Parents = objects this object's `tupleset` edges point to; check `computed` on each.
			for (const { src } of await edgesInto(ctx.raw, ctx.asOf, object, expr.tupleset)) {
				if (await check(ctx, src, expr.computed, subject)) return true;
			}
			return false;
		}
		case 'union': {
			for (const child of expr.children) {
				if (await evalExpr(ctx, object, relation, subject, child)) return true;
			}
			return false;
		}
		case 'intersection': {
			for (const child of expr.children) {
				if (!(await evalExpr(ctx, object, relation, subject, child))) return false;
			}
			return true;
		}
		case 'exclusion':
			return (
				(await evalExpr(ctx, object, relation, subject, expr.base)) &&
				!(await evalExpr(ctx, object, relation, subject, expr.subtract))
			);
		default:
			throw new Error(`auth: unhandled rewrite '${(expr as { kind: string }).kind}'`);
	}
}

/** `check(object, relation, subject)` with memoization + cycle guard. */
async function check(
	ctx: CheckCtx,
	object: string,
	relation: string,
	subject: string,
): Promise<boolean> {
	const key = `${object}#${relation}@${subject}`;
	const cached = ctx.memo.get(key);
	if (cached !== undefined) return cached;
	if (ctx.stack.has(key)) return false; // cycle on this path → not granted
	ctx.stack.add(key);
	const expr = ctx.model.rewrite(typeOf(object), relation); // throws on unknown type/relation
	const ok = await evalExpr(ctx, object, relation, subject, expr);
	ctx.stack.delete(key);
	ctx.memo.set(key, ok);
	return ok;
}

/** Entry point: evaluate a check against a fresh context (one `asOf` snapshot). */
export function runCheck(
	raw: Client,
	model: AuthModel,
	object: string,
	relation: string,
	subject: string,
	asOf?: number,
): Promise<boolean> {
	return check({ raw, model, asOf, memo: new Map(), stack: new Set() }, object, relation, subject);
}
