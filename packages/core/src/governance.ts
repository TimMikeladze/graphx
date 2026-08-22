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
		throw new Error(
			`resolveLimits: maxRows must be a positive finite number, got ${limits.maxRows}`,
		);
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

/**
 * P15 — observability (§19.6). A pluggable, dependency-free metrics sink threaded per-call
 * (like {@link QueryLimits}, never a module global — multi-tenant safety). Minimal structural
 * interface: a counter ({@link MetricsSink.inc}), a histogram ({@link MetricsSink.observe}),
 * and a gauge ({@link MetricsSink.gauge}). Adapt it to prom-client/OTel at the edge; the
 * portable core never imports a metrics backend.
 */
export interface MetricsSink {
	/** Increment a labelled counter by one (per-tenant query counts, slow-query totals). */
	inc(name: string, labels?: Record<string, string>): void;
	/** Record a histogram observation (traversal depth/fan-out, slow-query elapsed ms). */
	observe(name: string, value: number, labels?: Record<string, string>): void;
	/**
	 * Set a gauge. Infra-bound gauges are DEFERRED (they need signals not available in-process):
	 * `graphx_replica_sync_lag_ms`, `graphx_write_queue_depth`, `graphx_ann_recall`. Wire them
	 * at the operator edge (off sqld replication state / the write path) — not faked here.
	 */
	gauge(name: string, value: number, labels?: Record<string, string>): void;
}

/** A sink plus the labels for one operation — threaded into reads for slow-query + traversal metrics. */
export interface MetricsContext {
	sink: MetricsSink;
	/** Operation label (e.g. `journey`, `retrieve`) for the emitted records. */
	op: string;
	/** Optional tenant label for per-tenant attribution. */
	tenant?: string;
}

/** Zero-overhead default sink: every method is a no-op (absent metrics ⇒ this). */
export const NOOP_METRICS: MetricsSink = {
	inc() {},
	observe() {},
	gauge() {},
};

/** In-memory {@link MetricsSink} for tests: records every call with its labels, plus query helpers. */
export class InMemoryMetrics implements MetricsSink {
	readonly counters: Array<{ name: string; labels?: Record<string, string> }> = [];
	readonly histograms: Array<{ name: string; value: number; labels?: Record<string, string> }> = [];
	readonly gauges: Array<{ name: string; value: number; labels?: Record<string, string> }> = [];

	inc(name: string, labels?: Record<string, string>): void {
		this.counters.push({ name, labels });
	}
	observe(name: string, value: number, labels?: Record<string, string>): void {
		this.histograms.push({ name, value, labels });
	}
	gauge(name: string, value: number, labels?: Record<string, string>): void {
		this.gauges.push({ name, value, labels });
	}

	/** Count `inc` calls for `name` whose labels are a superset of every key in `match`. */
	count(name: string, match?: Record<string, string>): number {
		return this.counters.filter(
			(c) =>
				c.name === name &&
				(match === undefined || Object.entries(match).every(([k, v]) => c.labels?.[k] === v)),
		).length;
	}
	/** All histogram values observed for `name`, in order. */
	observations(name: string): number[] {
		return this.histograms.filter((h) => h.name === name).map((h) => h.value);
	}
}

/** Build the `{op, tenant?}` label bag for a {@link MetricsContext} (omits an absent tenant). */
export function metricLabels(ctx: MetricsContext): Record<string, string> {
	return ctx.tenant ? { op: ctx.op, tenant: ctx.tenant } : { op: ctx.op };
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
 *
 * P15 (§19.6): when `ctx` carries a sink, emits ONE structured slow-query record
 * (`graphx_query_slow_ms`, labelled by op/tenant) iff the query outlives `ms/2` — on either
 * the success path (slow but completed) or the abandonment path (timer fired). Absent `ctx`
 * ⇒ identical to the pre-P15 behavior (zero overhead, no extra observation).
 */
export function withTimeout<T>(work: Promise<T>, ms: number, ctx?: MetricsContext): Promise<T> {
	// No sink ⇒ EXACTLY the pre-P15 path: zero added allocation, byte-identical behavior. This
	// is the additive guarantee — every prior call site (no `ctx`) keeps its original semantics.
	if (!ctx?.sink) {
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

	// Sink present: instrument the §19.6 slow-query log. Emit ONE record iff elapsed > ms/2 — on
	// the success path (slow but completed) or the abandonment path (timer fired); `emitted`
	// makes it at-most-once. A disabled budget (ms ≤ 0 / non-finite) has no slow threshold.
	const sink = ctx.sink;
	const labels = metricLabels(ctx);
	const slowThreshold = Number.isFinite(ms) && ms > 0 ? ms / 2 : Number.POSITIVE_INFINITY;
	const start = Date.now();
	let emitted = false;
	const emitIfSlow = (): void => {
		if (emitted) return;
		const elapsed = Date.now() - start;
		if (elapsed > slowThreshold) {
			emitted = true;
			sink.observe('graphx_query_slow_ms', elapsed, labels);
		}
	};

	if (!Number.isFinite(ms) || ms <= 0) {
		return work.then(
			(v) => {
				emitIfSlow();
				return v;
			},
			(e) => {
				emitIfSlow();
				throw e;
			},
		);
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			emitIfSlow(); // elapsed ≈ ms > ms/2 → records the abandonment as slow
			reject(new QueryTimeoutError(ms));
		}, ms);
		work.then(
			(v) => {
				clearTimeout(timer);
				emitIfSlow();
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				emitIfSlow();
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
