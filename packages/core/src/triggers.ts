/**
 * Declarative triggers (eventing Layer 3) — "when this happens to the graph, run this".
 *
 * Triggers ride the DURABLE outbox ({@link import('./temporal.ts').outboxTail}), never the in-proc
 * {@link import('./events.ts').GraphEventBus}. `events.ts` spells out why: the in-proc emit is
 * post-commit and best-effort, and is skipped when a commit lands durably but the driver's ack is
 * lost. The outbox row is written inside the mutation's own transaction and cannot be lost that
 * way. The consequence is at-least-once delivery — `seq` is the dedupe key and actions must be
 * idempotent.
 *
 * Cascade safety comes from provenance: the runner hands each action a `Graph` tagged
 * `trigger:<name>` (see {@link import('./graph.ts').Graph.withEventSource}), and a
 * {@link TriggerMatch} that omits `source` matches only untagged user writes. A trigger therefore
 * cannot consume its own output unless it opts in with `source: 'any'`.
 *
 * State is per-`Graph` and per-subscription — no module globals — so one tenant's stalled trigger
 * spins its own loop and its own cursor and cannot stall another's.
 */

import type { DbClient, SqlValue } from './dialect.ts';
import type { GraphEvent } from './events.ts';

/** One event whose action exhausted its retries, as stored in `trigger_dead_letters`. */
export interface DeadLetter {
	id: string;
	/** The runner name that failed to deliver it. */
	subscription: string;
	/** The trigger whose action threw. */
	triggerName: string;
	/** Outbox `seq` of the undelivered event. */
	seq: number;
	event: GraphEvent;
	/** The last attempt's stack (or message). */
	error: string;
	/** How many attempts were made before giving up. */
	attempts: number;
	createdAt: number;
}

/** Filters for {@link deadLetters}. */
export interface DeadLetterOpts {
	subscription?: string;
	/** Page size, newest first. Default 100. */
	limit?: number;
	/** Only rows with `created_at >= since` (epoch ms). */
	since?: number;
}

/** Read dead letters newest-first — the operator's window into what failed and why. */
export async function deadLetters(
	raw: DbClient,
	opts: DeadLetterOpts = {},
): Promise<DeadLetter[]> {
	const conds: string[] = [];
	const args: SqlValue[] = [];
	if (opts.subscription !== undefined) {
		conds.push('subscription = ?');
		args.push(opts.subscription);
	}
	if (opts.since !== undefined) {
		conds.push('created_at >= ?');
		args.push(opts.since);
	}
	const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
	args.push(opts.limit ?? 100);
	const r = await raw.execute({
		sql: `SELECT id, subscription, trigger_name, seq, event, error, attempts, created_at
			FROM trigger_dead_letters${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
		args,
	});
	return r.rows.map((row) => ({
		id: String(row.id),
		subscription: String(row.subscription),
		triggerName: String(row.trigger_name),
		seq: Number(row.seq),
		event: JSON.parse(String(row.event)) as GraphEvent,
		error: String(row.error),
		attempts: Number(row.attempts),
		createdAt: Number(row.created_at),
	}));
}

/**
 * Drop dead letters older than `beforeMs`. Retention is the caller's policy — this is just the
 * mechanism, matching {@link import('./temporal.ts').pruneOutbox}. Returns rows deleted.
 */
export async function pruneDeadLetters(raw: DbClient, beforeMs: number): Promise<number> {
	if (!Number.isInteger(beforeMs)) {
		throw new Error(`pruneDeadLetters: beforeMs must be an integer, got ${beforeMs}`);
	}
	const r = await raw.execute({
		sql: 'DELETE FROM trigger_dead_letters WHERE created_at < ?',
		args: [beforeMs],
	});
	return r.rowsAffected;
}
