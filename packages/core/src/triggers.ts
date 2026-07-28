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

import { setTimeout as sleep } from 'node:timers/promises';
import { ulid } from 'ulidx';
import type { DbClient, SqlValue } from './dialect.ts';
import type { GraphEvent, GraphEventOp } from './events.ts';
import type { Graph, GraphSchema } from './graph.ts';
import { outboxHead, outboxTail } from './temporal.ts';

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

/**
 * A predicate over {@link GraphEvent}. Plain serializable data on purpose: triggers are declared in
 * code today, and keeping the predicate free of functions is what lets schema- or database-declared
 * triggers land later as a pure addition. An absent field matches anything — except `source`, whose
 * default is the cascade guard.
 */
export interface TriggerMatch {
	op?: GraphEventOp | GraphEventOp[];
	entity?: 'node' | 'edge';
	/** Node type or edge rel. */
	label?: string | string[];
	/** `'close'` selects the pure closes the CDC feed is blind to (deletes and supersedes). */
	shape?: 'insert' | 'close';
	/**
	 * `'user'` (the default) matches only untagged writes; `'any'` matches everything and opts into
	 * cascades; any other string matches that provenance tag exactly.
	 */
	source?: 'user' | 'any' | (string & {});
}

/** Does `event` satisfy every clause of `match`? */
export function matchesTrigger(event: GraphEvent, match: TriggerMatch): boolean {
	if (match.op !== undefined) {
		const ops = Array.isArray(match.op) ? match.op : [match.op];
		if (!ops.includes(event.op)) return false;
	}
	if (match.entity !== undefined && match.entity !== event.entity) return false;
	if (match.label !== undefined) {
		const labels = Array.isArray(match.label) ? match.label : [match.label];
		if (!labels.includes(event.label)) return false;
	}
	if (match.shape !== undefined && match.shape !== event.shape) return false;
	const source = match.source ?? 'user';
	if (source === 'any') return true;
	if (source === 'user') return event.source === undefined;
	return event.source === source;
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

/**
 * What a trigger does. Receives the event and a `Graph` whose writes are tagged
 * `trigger:<name>`, so derived writes are attributable and excluded from the trigger's own match.
 * Throwing signals failure: the runner retries, then dead-letters.
 */
export type TriggerAction<S extends GraphSchema> = (
	event: GraphEvent,
	graph: Graph<S>,
) => Promise<void> | void;

/** A rule: match some subset of events, run an action. */
export interface Trigger<S extends GraphSchema> {
	/** Stable — it keys the dead-letter rows and the provenance tag on derived writes. */
	name: string;
	match: TriggerMatch;
	action: TriggerAction<S>;
	/** Attempts before dead-lettering. Overrides the runner default. */
	retries?: number;
}

/** Construction options for a {@link TriggerRunner}. */
export interface TriggerRunnerOptions<S extends GraphSchema> {
	/** Subscription name — the `trigger_cursors` key. Two runners over one DB need distinct names. */
	name: string;
	triggers: Trigger<S>[];
	/** Events dispatched at once within a page. `1` (the default) means strict `seq` order. */
	concurrency?: number;
	/** `outboxTail` page size. Default 100. */
	batchSize?: number;
	/** Sleep between polls once drained. Default 1000. */
	pollIntervalMs?: number;
	/** Attempts per (event, trigger) before dead-lettering. Default 3. */
	retries?: number;
	/** Full-jitter exponential backoff base. Default 100. */
	backoffMs?: number;
	/**
	 * Cursor seed when none is persisted: `'now'` (the default) seeds from the outbox head as of
	 * the FIRST POLL (the first `runOnce()` call), not as of construction — events written between
	 * constructing the runner and first polling it are not delivered. `'beginning'` replays all history.
	 */
	start?: 'beginning' | 'now';
}

/** The outcome of one {@link TriggerRunner.runOnce} cycle. */
export interface TriggerBatchResult {
	/** (event, trigger) pairs whose action succeeded. */
	delivered: number;
	/** (event, trigger) pairs that exhausted their retries. */
	deadLettered: number;
	/** The persisted cursor after the cycle. */
	cursor: number;
	/** True when the outbox had nothing more to read. */
	drained: boolean;
}

/**
 * Polls the durable outbox and runs matching triggers, resuming from a persisted cursor after a
 * restart. Delivery is at-least-once; `event.seq` is the dedupe key.
 *
 * Drive it with {@link start}/{@link stop} in a worker, or call {@link runOnce} directly for one
 * deterministic cycle (which is what the tests do — no timers involved).
 */
export class TriggerRunner<S extends GraphSchema> {
	private readonly triggers: Trigger<S>[];
	private readonly name: string;
	private readonly concurrency: number;
	private readonly batchSize: number;
	private readonly pollIntervalMs: number;
	private readonly retries: number;
	private readonly backoffMs: number;
	private readonly startAt: 'beginning' | 'now';
	/** Source-tagged sibling graphs, one per trigger, built lazily and reused. */
	private readonly graphs = new Map<string, Graph<S>>();
	/** `null` until the first cycle reads (or seeds) the persisted cursor. */
	private cursor: number | null = null;

	constructor(
		private readonly graph: Graph<S>,
		opts: TriggerRunnerOptions<S>,
	) {
		if (opts.concurrency !== undefined && (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)) {
			throw new Error(`TriggerRunner: concurrency must be a positive integer, got ${opts.concurrency}`);
		}
		this.name = opts.name;
		this.triggers = opts.triggers;
		this.concurrency = opts.concurrency ?? 1;
		this.batchSize = opts.batchSize ?? 100;
		this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
		this.retries = opts.retries ?? 3;
		this.backoffMs = opts.backoffMs ?? 100;
		this.startAt = opts.start ?? 'now';
	}

	/**
	 * One poll and dispatch. `concurrency === 1` checkpoints after each event, so an interrupted
	 * cycle resumes at exactly the first event it had not finished. Above 1, events dispatch in
	 * parallel under the bound and the cursor only advances once the whole page has resolved — see
	 * {@link pool} for why that trade is forced. If the page fails (an action's dead-letter write
	 * itself throws), {@link pool} guarantees every dispatched action has settled before the
	 * rejection reaches this method's caller — so a caller that reacts by retrying the same page
	 * never runs a redelivery alongside a still-running attempt from the failed cycle.
	 */
	async runOnce(): Promise<TriggerBatchResult> {
		if (this.cursor === null) this.cursor = await this.seedCursor();
		const page = await outboxTail(
			this.graph.raw,
			{ seq: this.cursor },
			{ limit: this.batchSize },
		);
		let delivered = 0;
		let deadLettered = 0;
		if (this.concurrency === 1) {
			// Serial: completions are already in `seq` order, so checkpointing per event is free
			// correctness — an interrupted cycle resumes at the first event it had not finished.
			for (const event of page.events) {
				const outcome = await this.dispatch(event);
				delivered += outcome.delivered;
				deadLettered += outcome.deadLettered;
				this.cursor = event.seq as number;
				await this.saveCursor(this.cursor);
			}
		} else if (page.events.length > 0) {
			// Parallel: completions are unordered, so the cursor can only move once the whole page
			// has resolved. An interrupted cycle redelivers the page — at-least-once, `seq` dedupes.
			// `pool` never lets a rejection surface while siblings are still in flight, so a
			// redelivery here can never overlap a still-running attempt from the failed cycle.
			const outcomes = await pool(
				page.events.map((event) => () => this.dispatch(event)),
				this.concurrency,
			);
			for (const outcome of outcomes) {
				delivered += outcome.delivered;
				deadLettered += outcome.deadLettered;
			}
			this.cursor = page.events[page.events.length - 1]?.seq as number;
			await this.saveCursor(this.cursor);
		}
		return {
			delivered,
			deadLettered,
			cursor: this.cursor,
			drained: page.nextCursor === null,
		};
	}

	/**
	 * The persisted cursor, seeded and written on first use — i.e. at the first `runOnce()` call, not
	 * at construction. A `'now'` seed therefore reflects the outbox head as of the first poll: history
	 * written before construction is skipped, but so is anything written between construction and
	 * that first call. Seeding through {@link import('./temporal.ts').outboxHead} rather than
	 * `MAX(seq)` keeps the Postgres visibility gate — a bare max can start past a lower-seq row that
	 * has not committed yet, which would skip it forever. Persisting immediately means a restart
	 * before the first delivery does not re-seek to a different head.
	 */
	private async seedCursor(): Promise<number> {
		const r = await this.graph.raw.execute({
			sql: 'SELECT seq FROM trigger_cursors WHERE name = ?',
			args: [this.name],
		});
		const row = r.rows[0];
		if (row !== undefined) return Number(row.seq);
		const seq = this.startAt === 'beginning' ? 0 : await outboxHead(this.graph.raw);
		await this.saveCursor(seq);
		return seq;
	}

	private async saveCursor(seq: number): Promise<void> {
		await this.graph.raw.execute({
			sql: `INSERT INTO trigger_cursors (name, seq, updated_at) VALUES (?,?,?)
				ON CONFLICT(name) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`,
			args: [this.name, seq, Date.now()],
		});
	}

	/** Run every trigger that matches `event`. One trigger's failure never reaches another's. */
	private async dispatch(event: GraphEvent): Promise<{ delivered: number; deadLettered: number }> {
		let delivered = 0;
		let deadLettered = 0;
		for (const trigger of this.triggers) {
			if (!matchesTrigger(event, trigger.match)) continue;
			if (await this.deliver(trigger, event)) delivered++;
			else deadLettered++;
		}
		return { delivered, deadLettered };
	}

	/** Attempt one trigger with backoff. `false` ⇒ attempts exhausted and a dead letter written. */
	private async deliver(trigger: Trigger<S>, event: GraphEvent): Promise<boolean> {
		const attempts = trigger.retries ?? this.retries;
		let lastError = '';
		for (let attempt = 0; attempt < attempts; attempt++) {
			try {
				await trigger.action(event, this.graphFor(trigger.name));
				return true;
			} catch (e) {
				lastError = e instanceof Error ? (e.stack ?? e.message) : String(e);
				if (attempt < attempts - 1) await this.backoff(attempt);
			}
		}
		await this.recordDeadLetter(trigger, event, lastError, attempts);
		return false;
	}

	private graphFor(name: string): Graph<S> {
		let g = this.graphs.get(name);
		if (g === undefined) {
			g = this.graph.withEventSource(`trigger:${name}`);
			this.graphs.set(name, g);
		}
		return g;
	}

	/** Full-jitter exponential backoff, capped at 64× the base — mirrors graph.ts's write retry. */
	private backoff(attempt: number): Promise<void> {
		const base = this.backoffMs * Math.min(2 ** attempt, 64);
		return sleep(base + Math.random() * base);
	}

	private async recordDeadLetter(
		trigger: Trigger<S>,
		event: GraphEvent,
		error: string,
		attempts: number,
	): Promise<void> {
		await this.graph.raw.execute({
			sql: `INSERT INTO trigger_dead_letters
					(id, subscription, trigger_name, seq, event, error, attempts, created_at)
				VALUES (?,?,?,?,?,?,?,?)`,
			args: [
				ulid(),
				this.name,
				trigger.name,
				event.seq ?? 0,
				JSON.stringify(event),
				error,
				attempts,
				Date.now(),
			],
		});
	}
}

/**
 * Run `tasks` with at most `limit` in flight. Results keep input order; completion order does not,
 * which is exactly the ordering guarantee `concurrency > 1` gives up.
 *
 * If a task throws, no new tasks are claimed after it, but every already-in-flight task is still
 * awaited before `pool` rejects — so by the time the rejection reaches the caller, nothing from
 * this call is still running. Without that, `Promise.all` would reject as soon as one worker threw
 * and leave the other workers detached, still executing after the caller has already moved on
 * (e.g. retried the same page).
 */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	const out: T[] = Array.from({ length: tasks.length });
	let next = 0;
	let failure: { error: unknown } | undefined;
	const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
		for (let i = next++; i < tasks.length; i = next++) {
			try {
				out[i] = await (tasks[i] as () => Promise<T>)();
			} catch (error) {
				// Claim the rest so siblings stop starting new work, but never reject from a
				// worker: `Promise.all` would propagate immediately and leave the other workers
				// running detached, executing trigger actions after runOnce() has already
				// reported failure to its caller.
				failure ??= { error };
				next = tasks.length;
				return;
			}
		}
	});
	await Promise.all(workers);
	if (failure !== undefined) throw failure.error;
	return out;
}
