import { ulid } from 'ulidx';
import {
	type DbClient,
	dialectOf,
	FOREVER,
	type Graph,
	type GraphSchema,
	insertOrIgnore,
	jsonField,
} from '../core/index.ts';
import type { Tuple } from './types.ts';
import { typeOf } from './types.ts';

/**
 * Ensure an object/subject exists as a bare node (id = ref, type = type, data `{}`).
 * Idempotent: INSERT-OR-IGNORE the identity row, then insert a live version only if
 * none exists. Existence is binary — no temporal versioning of objects themselves.
 */
export async function ensureObject(raw: DbClient, ref: string): Promise<void> {
	const type = typeOf(ref);
	const d = dialectOf(raw);
	const now = Date.now();
	// Idempotent: the NOT EXISTS guard runs inside the single write batch (Postgres ON
	// CONFLICT / SQLite OR IGNORE on the identity row; the version insert guards on NOT EXISTS).
	await raw.batch(
		[
			{ sql: insertOrIgnore(d, 'node_identity', 'id', '(?)'), args: [ref] },
			{
				sql: `INSERT INTO node_versions (id, type, data, valid_from, recorded_from)
					SELECT ?, ?, '{}', ?, ?
					WHERE NOT EXISTS (SELECT 1 FROM node_versions WHERE id = ? AND valid_to = ? AND recorded_to = ?)`,
				args: [ref, type, now, now, ref, FOREVER, FOREVER],
			},
		],
		'write',
	);
}

/** Is there a live edge `src --rel--> dst`? (P1 direct-tuple existence check.) */
export async function liveTupleExists(
	raw: DbClient,
	src: string,
	rel: string,
	dst: string,
): Promise<boolean> {
	const r = await raw.execute({
		sql: 'SELECT 1 FROM edges WHERE src = ? AND rel = ? AND dst = ? LIMIT 1',
		args: [src, rel, dst],
	});
	return r.rows.length > 0;
}

/**
 * Write a tuple as an edge `subject --relation--> object`. A `subjectRelation` (userset
 * subject, e.g. `group:eng#member`) is stored in `data.subjectRelation`. Ensures both
 * endpoints exist, then inserts atomically + idempotently: the NOT EXISTS guard (matched
 * on subjectRelation too) runs inside the single write batch, so a concurrent identical
 * write (which SQLite serializes) skips.
 */
export async function writeTuple(g: Graph<GraphSchema>, tuple: Tuple): Promise<void> {
	await ensureObject(g.raw, tuple.object);
	await ensureObject(g.raw, tuple.subject);

	const id = ulid();
	const d = dialectOf(g.raw);
	const now = Date.now();
	const dataJson =
		tuple.subjectRelation !== undefined
			? JSON.stringify({ subjectRelation: tuple.subjectRelation })
			: '{}';
	const srField = jsonField(d, 'data', 'subjectRelation');
	const srPred = tuple.subjectRelation === undefined ? `${srField} IS NULL` : `${srField} = ?`;
	const srArgs: string[] = tuple.subjectRelation === undefined ? [] : [tuple.subjectRelation];
	const guard = `NOT EXISTS (SELECT 1 FROM edges WHERE src = ? AND rel = ? AND dst = ? AND ${srPred})`;

	await g.raw.batch(
		[
			{
				sql: `INSERT INTO edge_identity (id) SELECT ? WHERE ${guard}`,
				args: [id, tuple.subject, tuple.relation, tuple.object, ...srArgs],
			},
			{
				sql: `INSERT INTO edge_versions (id, src, dst, rel, weight, data, valid_from, recorded_from)
					SELECT ?, ?, ?, ?, 1.0, ?, ?, ? WHERE ${guard}`,
				args: [
					id,
					tuple.subject,
					tuple.object,
					tuple.relation,
					dataJson,
					now,
					now,
					tuple.subject,
					tuple.relation,
					tuple.object,
					...srArgs,
				],
			},
		],
		'write',
	);
}

/**
 * Revoke a tuple: the live edge stops holding from now (a retraction over `[now, FOREVER)`,
 * the portion primitive's semantics), matched on `subjectRelation` so a userset tuple and a
 * same-endpoint direct tuple are revoked independently. History is retained (`asOf` past
 * still sees the grant). `now` is bumped past the edge's start to keep the interval non-empty
 * (M6). No-op if nothing live matches.
 */
export async function deleteTuple(
	raw: DbClient,
	src: string,
	rel: string,
	dst: string,
	subjectRelation?: string,
): Promise<void> {
	const srField = jsonField(dialectOf(raw), 'data', 'subjectRelation');
	const srPred = subjectRelation === undefined ? `${srField} IS NULL` : `${srField} = ?`;
	const srArgs: string[] = subjectRelation === undefined ? [] : [subjectRelation];
	const live = (
		await raw.execute({
			sql: `SELECT ver, valid_from, recorded_from FROM edge_versions
				WHERE src = ? AND rel = ? AND dst = ? AND valid_to = ? AND recorded_to = ? AND ${srPred}`,
			args: [src, rel, dst, FOREVER, FOREVER, ...srArgs],
		})
	).rows;
	if (live.length === 0) return;
	let ts = Date.now();
	for (const r of live) ts = Math.max(ts, Number(r.valid_from) + 1, Number(r.recorded_from) + 1);
	// One atomic batch per row: supersede the open row, then record its part before `ts` as
	// history, copied from the row just superseded — so if a concurrent revoke got there first,
	// the close matches nothing and neither does the copy.
	const cols = 'id, src, dst, rel, weight, data, source';
	await raw.batch(
		live.flatMap((r) => [
			{
				sql: `UPDATE edge_versions SET recorded_to = ? WHERE ver = ? AND recorded_to = ?`,
				args: [ts, r.ver as number, FOREVER],
			},
			{
				sql: `INSERT INTO edge_versions (${cols}, valid_from, valid_to, recorded_from)
					SELECT ${cols}, valid_from, ?, ? FROM edge_versions WHERE ver = ? AND recorded_to = ?`,
				args: [ts, ts, r.ver as number, ts],
			},
		]),
		'write',
	);
}
