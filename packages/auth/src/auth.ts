import type { DbClient, Graph, GraphSchema } from 'graphx-core';
import { runCheck } from './check.ts';
import { runExpand, type UsersetTree } from './expand.ts';
import { type ListObjectsOpts, type ListObjectsPage, runListObjects } from './list.ts';
import type { AuthModel } from './model.ts';
import { deleteTuple, writeTuple } from './store.ts';
import type { Tuple } from './types.ts';
import { typeOf } from './types.ts';

/** Options for a {@link Auth.check}. */
export interface CheckOpts {
	/** Evaluate as-of this epoch-ms instant (temporal snapshot). Omit ⇒ live (now). */
	asOf?: number;
}

/**
 * The ReBAC engine (L2 — see auth-rebac-spec.md). Wires an {@link AuthModel} to the
 * tuple store and the recursive check evaluator. P2: direct tuples, computed usersets,
 * and group usersets (including nested membership). P3 adds tuple-to-userset + set-ops.
 */
export class Auth {
	constructor(
		private readonly g: Graph<GraphSchema>,
		private readonly model: AuthModel,
	) {}

	private get raw(): DbClient {
		return this.g.raw;
	}

	/**
	 * Add relationship tuples. Validates the object's relation and, for a userset subject,
	 * that `subjectRelation` is a declared relation on the subject's type.
	 */
	async write(tuples: Tuple[]): Promise<void> {
		for (const t of tuples) {
			this.model.rewrite(typeOf(t.object), t.relation);
			if (t.subjectRelation !== undefined) {
				this.model.rewrite(typeOf(t.subject), t.subjectRelation);
			}
			await writeTuple(this.g, t);
		}
	}

	/** Revoke relationship tuples (temporal close), matched on `subjectRelation`. */
	async delete(tuples: Tuple[]): Promise<void> {
		for (const t of tuples) {
			this.model.rewrite(typeOf(t.object), t.relation);
			await deleteTuple(this.raw, t.subject, t.relation, t.object, t.subjectRelation);
		}
	}

	/**
	 * Does `subject` have `relation` on `object`? Recursively evaluates the relation's
	 * rewrite tree (self / computed / union) against tuples, at one `asOf` snapshot.
	 */
	check(object: string, relation: string, subject: string, opts: CheckOpts = {}): Promise<boolean> {
		return runCheck(this.raw, this.model, object, relation, subject, opts.asOf);
	}

	/**
	 * Expand (object, relation) into its userset tree (Zanzibar Expand). Mirrors the rewrite
	 * structure; leaf usersets (`group:eng#member`) are references, not recursively resolved.
	 */
	expand(object: string, relation: string, opts: CheckOpts = {}): Promise<UsersetTree> {
		return runExpand(this.raw, this.model, object, relation, opts.asOf);
	}

	/**
	 * List the objects of `type` on which `subject` has `relation`. Candidates are found by
	 * reachability and confirmed with `check` (exact). Keyset-paginated via `opts.limit`/`cursor`.
	 */
	listObjects(
		subject: string,
		relation: string,
		type: string,
		opts: ListObjectsOpts = {},
	): Promise<ListObjectsPage> {
		return runListObjects(this.raw, this.model, subject, relation, type, opts);
	}
}
