import { runCheck } from './check.ts';
import type { DbClient } from 'graphx-core';
import type { AuthModel } from './model.ts';

/** Max candidate objects scanned per page call (governance bound; full §19.2 wiring is P6). */
const SCAN_CAP = 10000;
/** Default page size when `opts.limit` is omitted. */
const DEFAULT_LIMIT = 100;

/** Options for {@link Auth.listObjects}. */
export interface ListObjectsOpts {
	/** Evaluate as-of this epoch-ms instant. Omit ⇒ live (now). */
	asOf?: number;
	/** Page size (max objects returned). Default 100. */
	limit?: number;
	/** Opaque cursor from a prior page's `nextCursor` (the last object id). Omit for page 1. */
	cursor?: string;
}

/** One page of {@link Auth.listObjects}. */
export interface ListObjectsPage {
	objects: string[];
	/**
	 * `null` when this is the last page. NOTE: a non-null cursor does NOT imply `objects` is
	 * non-empty — a page can scan only ungranted candidates (or hit the scan cap) and return
	 * `objects: []` with a cursor. Keep paging until `nextCursor` is `null`.
	 */
	nextCursor: string | null;
}

/**
 * Forward-reachable nodes of `type = type` from `subject` (recursive CTE over `src→dst`
 * edges; `UNION` dedups so cycles terminate). Returns ids `> after`, sorted ascending,
 * capped at `SCAN_CAP`. `asOf` undefined ⇒ live views; else the temporal `_versions`
 * tables with the half-open interval.
 */
async function reachableOfType(
	raw: DbClient,
	asOf: number | undefined,
	subject: string,
	type: string,
	after: string,
): Promise<string[]> {
	const sql =
		asOf === undefined
			? `WITH RECURSIVE reach(id) AS (
					SELECT ?
					UNION
					SELECT e.dst FROM edges e JOIN reach r ON e.src = r.id
				)
				SELECT n.id AS id FROM reach r JOIN nodes n ON n.id = r.id
				WHERE n.type = ? AND n.id <> ? AND n.id > ?
				ORDER BY n.id LIMIT ?`
			: `WITH RECURSIVE reach(id) AS (
					SELECT ?
					UNION
					SELECT e.dst FROM edge_versions e JOIN reach r ON e.src = r.id
						WHERE e.valid_from <= ? AND e.valid_to > ?
				)
				SELECT n.id AS id FROM reach r JOIN node_versions n ON n.id = r.id
				WHERE n.type = ? AND n.valid_from <= ? AND n.valid_to > ? AND n.id <> ? AND n.id > ?
				ORDER BY n.id LIMIT ?`;
	const args =
		asOf === undefined
			? [subject, type, subject, after, SCAN_CAP]
			: [subject, asOf, asOf, type, asOf, asOf, subject, after, SCAN_CAP];
	const r = await raw.execute({ sql, args });
	return r.rows.map((row) => String(row.id));
}

/**
 * List the objects of `type` on which `subject` has `relation`. Candidates = objects
 * forward-reachable from the subject (an over-approximation); each is confirmed with
 * `check` (exact — applies exclusion/intersection). Keyset-paginated by object id.
 */
export async function runListObjects(
	raw: DbClient,
	model: AuthModel,
	subject: string,
	relation: string,
	type: string,
	opts: ListObjectsOpts = {},
): Promise<ListObjectsPage> {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const after = opts.cursor ?? '';
	const candidates = await reachableOfType(raw, opts.asOf, subject, type, after);

	const objects: string[] = [];
	let nextCursor: string | null = null;
	for (const id of candidates) {
		if (await runCheck(raw, model, id, relation, subject, opts.asOf)) {
			objects.push(id);
			if (objects.length === limit) {
				nextCursor = id; // page full; resume after this id
				break;
			}
		}
	}
	// Scanned the whole window without filling the page, but the window was capped —
	// more candidates may exist beyond it, so hand back a cursor to continue.
	if (nextCursor === null && candidates.length === SCAN_CAP) {
		nextCursor = candidates[candidates.length - 1] ?? null;
	}
	return { objects, nextCursor };
}
