import { Buffer } from 'node:buffer';

/**
 * P14 — query governance (§19.2) + pagination cursor codec (§19.7).
 *
 * Three server-side caps make a single tenant unable to starve the box or OOM the
 * process: a **row cap** (`LIMIT :maxRows` on every generated read), a traversal
 * **fan-out guard** (walks skip expanding supernodes — enforced in the recursive SQL
 * of retrieve/hybrid/journey, not here), and a fail-safe **timeout**.
 *
 * M7 (overrides the §19.2 snippet): the client timeout is fail-safe ABANDONMENT, not
 * cancellation. There is no `interrupt()` over HTTP, so {@link withTimeout} only stops
 * the CALLER waiting — the statement keeps running server-side until it finishes or
 * `busy_timeout` trips. The real protection is `busy_timeout` (P0, per-connection) +
 * the row cap + the fan-out guard, all of which bound work IN the database.
 */

/** The three §19.2 caps. Defaults are the spec's `LIMITS`; override per-call/per-tenant. */
export interface QueryLimits {
	/** Hard `LIMIT` appended to every generated read. */
	maxRows: number;
	/** A walk will not expand a node whose live degree exceeds this (supernode guard). */
	maxFanout: number;
	/** Caller-side abandonment budget in ms (M7 — not a statement interrupt). */
	timeoutMs: number;
}

/** The §19.2 `LIMITS` constants. */
export const DEFAULT_LIMITS: QueryLimits = { maxRows: 10_000, maxFanout: 1000, timeoutMs: 5000 };

/**
 * Merge a partial override (per-call or per-tenant) over {@link DEFAULT_LIMITS} and
 * validate the SQL-inlined caps. `maxRows`/`maxFanout` are inlined into generated SQL
 * (see {@link applyLimit}/{@link fanoutJoin}), so a non-finite/degenerate value is
 * rejected here at the single chokepoint every read path passes through — fail fast
 * instead of emitting `<= NaN`/`LIMIT Infinity` into SQL. `timeoutMs` is NOT inlined
 * (it only feeds {@link withTimeout}), and `Infinity`/non-finite is its documented
 * "disable the abandonment guard" sentinel, so it is intentionally left unvalidated.
 */
export function resolveLimits(partial?: Partial<QueryLimits>): QueryLimits {
	const limits = { ...DEFAULT_LIMITS, ...partial };
	if (!Number.isFinite(limits.maxRows) || limits.maxRows < 1) {
		throw new Error(`resolveLimits: maxRows must be a positive finite number, got ${limits.maxRows}`);
	}
	if (!Number.isFinite(limits.maxFanout) || limits.maxFanout < 0) {
		throw new Error(
			`resolveLimits: maxFanout must be a non-negative finite number, got ${limits.maxFanout}`,
		);
	}
	return limits;
}

/**
 * Append `LIMIT <n>` to generated SQL. `n` is validated to a positive integer and
 * inlined (not bound) so it can sit after a recursive-CTE final SELECT without
 * disturbing the carefully ordered positional args; the integer-only guard keeps it
 * free of any injection surface.
 */
export function applyLimit(sql: string, maxRows: number): string {
	if (!Number.isFinite(maxRows) || maxRows < 1) {
		throw new Error(`applyLimit: maxRows must be a positive finite number, got ${maxRows}`);
	}
	return `${sql}\nLIMIT ${Math.floor(maxRows)}`;
}

/**
 * Supernode fan-out guard SQL (§19.2), shared by the retrieve/hybrid recursive walks
 * (which both name their adjacency CTE `adj` and their recursive CTE `walk`). The
 * per-source out-degree CTE {@link FANOUT_DEG_CTE} sits in the `WITH` list; the
 * {@link fanoutJoin} JOIN in the recursive step refuses to expand any node whose degree
 * exceeds `maxFanout`. A reached supernode is still emitted, only not *expanded*, so one
 * fat node can't blow the traversal up. `maxFanout` is a validated integer inlined into
 * the SQL so the carefully ordered positional args stay undisturbed.
 */
export const FANOUT_DEG_CTE: string = 'adj_deg AS (SELECT a, COUNT(*) AS deg FROM adj GROUP BY a)';

/** The recursive-step JOIN that drops over-fan-out nodes from expansion (see {@link FANOUT_DEG_CTE}). */
export function fanoutJoin(maxFanout: number): string {
	return `JOIN adj_deg ON adj_deg.a = walk.id AND adj_deg.deg <= ${Math.floor(maxFanout)}`;
}

/** Thrown by {@link withTimeout} when the work outlives its budget (M7 abandonment). */
export class QueryTimeoutError extends Error {
	constructor(ms: number) {
		super(`query abandoned after ${ms}ms (fail-safe; statement not interrupted)`);
		this.name = 'QueryTimeoutError';
	}
}

/**
 * Race `work` against a `ms` abandonment timer. On timeout the returned promise
 * rejects with {@link QueryTimeoutError} while `work` keeps running server-side (M7).
 * A non-positive / non-finite budget disables the guard (pass-through). The timer is
 * always cleared on settle so no handle dangles.
 */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	if (!Number.isFinite(ms) || ms <= 0) return work;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new QueryTimeoutError(ms)), ms);
		work.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/**
 * Encode a keyset cursor (§19.7): the ordered id tuple of the last row on a page,
 * base64'd JSON. Opaque to the caller — they pass it back verbatim as `cursor` to get
 * the next page. A tuple (not a scalar) so a multi-alias `match` page keysets on the
 * full row-value; consumers `GROUP BY` that tuple so each distinct tuple is one stable
 * keyset row (see `PatternBuilder.page`).
 */
export function encodeCursor(key: string[]): string {
	return Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
}

/**
 * Decode an opaque {@link encodeCursor} cursor back to its id tuple. Validates the
 * decoded shape (a non-empty array of strings) so a tampered/stale/wrong-arity cursor
 * fails with a clear `invalid cursor` error (HTTP-400-mappable) instead of a cryptic
 * downstream `TypeError`/`SQLITE_ERROR`. Values are bound as SQL params (no injection).
 */
export function decodeCursor(cursor: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
	} catch {
		throw new Error('invalid cursor');
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((v) => typeof v !== 'string')) {
		throw new Error('invalid cursor');
	}
	return parsed as string[];
}
