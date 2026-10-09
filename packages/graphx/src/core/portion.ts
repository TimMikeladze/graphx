import type { SqlResult, SqlRow, SqlStatement, SqlValue } from './dialect.ts';
import { FOREVER } from './runtime.ts';

/**
 * The one write primitive of the two-axis model (docs/bitemporal.md D2): replace what a
 * graph believes about one id over a portion of valid time, SQL:2011 `FOR PORTION OF` style.
 *
 * Every current belief (`recorded_to = FOREVER`) of the id whose valid interval overlaps
 * `[from, to)` stops being current (`recorded_to = recordedAt`), and the parts of it outside
 * the portion are re-inserted as new current beliefs with the same content. Rows are never
 * edited otherwise. The caller then inserts the new row for the portion (an assert) or nothing
 * (a retract). Run it inside the write's transaction.
 *
 * Statement order — close, remainders, then the caller's new row — keeps the one-live and
 * constraint indexes satisfied at every step: the closed row stops counting before anything
 * that could collide with it is written.
 */

/** Anything that can run a statement: a client or an open transaction. */
export type Executor = { execute(stmt: SqlStatement): Promise<SqlResult> };

export type VersionTable = 'node_versions' | 'edge_versions';

/** The content columns a remainder copies, per table (everything but identity and time). */
export const CONTENT_COLS: Record<VersionTable, readonly string[]> = {
	node_versions: ['type', 'body', 'uri', 'content_hash', 'content_type', 'data'],
	edge_versions: ['src', 'dst', 'rel', 'weight', 'data', 'source'],
};

/** What {@link supersedePortion} did. */
export interface PortionResult {
	/** `'superseded'` when a concurrent writer closed a row first: roll back and retry. */
	status: 'ok' | 'superseded';
	/** The current beliefs the portion overlapped, before the write (content + time columns). */
	overlapped: SqlRow[];
	/** The recorded instant actually used: `recordedAt`, bumped past every overlapped row. */
	recordedAt: number;
}

/** Current beliefs of `id` that overlap `[from, to)`, oldest first. */
export async function currentBeliefs(
	tx: Executor,
	table: VersionTable,
	id: string,
	from: number,
	to: number,
): Promise<SqlRow[]> {
	const cols = CONTENT_COLS[table].join(', ');
	const r = await tx.execute({
		sql: `SELECT ver, ${cols}, valid_from, valid_to, recorded_from FROM ${table}
		      WHERE id = ? AND recorded_to = ${FOREVER} AND valid_from < ? AND ? < valid_to
		      ORDER BY valid_from`,
		args: [id, to, from],
	});
	return r.rows;
}

/** Insert one version row of `id` from a source row's content, over `[from, to)`. */
export function versionInsert(
	table: VersionTable,
	id: string,
	content: Record<string, unknown>,
	from: number,
	to: number,
	recordedAt: number,
): SqlStatement {
	const cols = CONTENT_COLS[table];
	return {
		sql: `INSERT INTO ${table} (id, ${cols.join(', ')}, valid_from, valid_to, recorded_from)
		      VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
		args: [id, ...cols.map((c) => (content[c] ?? null) as SqlValue), from, to, recordedAt],
	};
}

/** See the module comment. */
export async function supersedePortion(
	tx: Executor,
	table: VersionTable,
	id: string,
	from: number,
	to: number,
	recordedAt: number,
): Promise<PortionResult> {
	const overlapped = await currentBeliefs(tx, table, id, from, to);
	let at = recordedAt;
	for (const r of overlapped) at = Math.max(at, Number(r.recorded_from) + 1);
	for (const r of overlapped) {
		const closed = await tx.execute({
			sql: `UPDATE ${table} SET recorded_to = ? WHERE ver = ? AND recorded_to = ${FOREVER}`,
			args: [at, r.ver as SqlValue],
		});
		if (closed.rowsAffected !== 1) return { status: 'superseded', overlapped, recordedAt: at };
	}
	for (const r of overlapped) {
		const vf = Number(r.valid_from);
		const vt = Number(r.valid_to);
		if (vf < from) await tx.execute(versionInsert(table, id, r, vf, from, at));
		if (to < vt) await tx.execute(versionInsert(table, id, r, to, vt, at));
	}
	return { status: 'ok', overlapped, recordedAt: at };
}

/**
 * D3, no future dating: a portion must be non-empty, start no later than `now`, and either stay
 * open or end no later than `now`. A finite end in the future would make a row stop being live
 * without any write, which the live views and one-live indexes cannot see.
 */
export function assertWriteTime(label: string, from: number, to: number, now: number): void {
	if (!Number.isFinite(from) || !Number.isInteger(from)) {
		throw new Error(`${label}: validFrom must be an integer epoch ms, got ${from}`);
	}
	if (!(from < to)) throw new Error(`${label}: validFrom must be < validTo, got ${from} >= ${to}`);
	if (from > now) {
		throw new Error(
			`${label}: validFrom ${from} is in the future (now ${now}); graphx does not future-date`,
		);
	}
	if (to !== FOREVER && (to > now || !Number.isInteger(to))) {
		throw new Error(
			`${label}: validTo must be FOREVER or an integer instant no later than now (${now}), got ${to}`,
		);
	}
}
