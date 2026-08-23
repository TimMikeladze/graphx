/**
 * Graph eventing (§ eventing) — the reactive seam over the temporal store. graphx mutations
 * write version rows silently; the CDC {@link import('./temporal.ts').changeFeed} is a
 * `valid_from`-only poll that is structurally BLIND to pure closes (decision A.3). This module
 * is the fix: a typed event emitted from the public `Graph` mutation methods (`graph.ts`), the
 * one altitude that knows op + id + type + close-vs-insert. A pure close/supersede/delete emits
 * an explicit `shape:'close'` event the feed can never see.
 *
 * The sink is a pluggable, dependency-free interface threaded per-`Graph` (like {@link
 * import('./governance.ts').MetricsSink} — never a module global, so multi-tenant safe). Layer 1
 * (in-proc): attach a {@link GraphEventBus}. Layer 2 (durable): set `outbox: true` and every
 * event is co-written into the `graph_outbox` table in the SAME atomic unit as the version rows,
 * tailed by {@link import('./temporal.ts').outboxTail}.
 *
 * Delivery caveat: the in-proc {@link GraphEventSink} emit is POST-commit and best-effort. If a DB
 * commit lands durably but the driver's ack is lost (the mutation call throws AFTER the write
 * committed), the co-written outbox row is durable yet the in-proc emit is skipped — so Layer 1
 * (the {@link GraphEventBus}) can miss an event Layer 2 recorded. The durable outbox is the source
 * of truth; a consumer that must not miss events tails {@link import('./temporal.ts').outboxTail}
 * rather than relying on the in-proc bus alone.
 */

/** The mutation an event describes. `*.supersede`/`*.delete` are the pure closes the CDC feed misses. */
export type GraphEventOp =
	| 'node.create'
	| 'node.update'
	| 'node.delete'
	| 'edge.create'
	| 'edge.delete'
	| 'edge.supersede';

/** A single graph mutation event. `src`/`dst` are set for edges only; `seq`/`tenant`/`project` are stamped downstream. */
export interface GraphEvent {
	/** Outbox-assigned total order (Layer 2+, from {@link import('./temporal.ts').outboxTail}); absent for pure in-proc emits. */
	seq?: number;
	op: GraphEventOp;
	entity: 'node' | 'edge';
	/** The mutated node/edge ULID. For `edge.supersede` this is the CLOSED prior edge's id (not the new one). */
	id: string;
	/** Node type OR edge rel. */
	label: string;
	/** `'insert'` wrote a new `valid_from` row; `'close'` only moved an existing row's `valid_to` (the feed-blind case). */
	shape: 'insert' | 'close';
	/** `valid_from` for inserts, `valid_to` for closes (epoch ms, the monotonic write clock). */
	ts: number;
	/** Edge source node id (edges only; carried on closes too so consumers can invalidate the endpoint). */
	src?: string;
	/** Edge destination node id (edges only). */
	dst?: string;
	/** Provenance: absent on a user write, `trigger:<name>` on a write made by a trigger action. */
	source?: string;
	/** Stamped by {@link scopeEvents} at the HTTP edge (serve.ts). */
	tenant?: string;
	/** Stamped by {@link scopeEvents} at the HTTP edge (serve.ts). */
	project?: string;
}

/** A pluggable event sink threaded into a `Graph`. `emit` MUST NOT throw or block (the `Graph` guards it anyway). */
export interface GraphEventSink {
	emit(event: GraphEvent): void;
}

/** Options for a `Graph`'s eventing (the 4th constructor arg). */
export interface GraphEventOptions {
	/** In-proc sink — a {@link GraphEventBus}, an adapter, or a test double. Omit ⇒ {@link NOOP_EVENTS}. */
	sink?: GraphEventSink;
	/** Co-write every event into the durable `graph_outbox` table in the mutation's own transaction (Layer 2). */
	outbox?: boolean;
	/**
	 * Stamp every event from this `Graph` with a provenance tag (e.g. `trigger:reembed`). Set via
	 * {@link import('./graph.ts').Graph.withEventSource}; the trigger matcher excludes tagged
	 * events by default so a trigger never consumes its own writes.
	 */
	source?: string;
}

/** Zero-overhead default sink: `emit` is a no-op (absent eventing ⇒ this). */
export const NOOP_EVENTS: GraphEventSink = { emit() {} };

/** In-memory {@link GraphEventSink} for tests: records every event in order. */
export class InMemoryEvents implements GraphEventSink {
	readonly events: GraphEvent[] = [];
	emit(event: GraphEvent): void {
		this.events.push(event);
	}
	/** Events matching an op (all, when omitted). */
	byOp(op?: GraphEventOp): GraphEvent[] {
		return op ? this.events.filter((e) => e.op === op) : this.events;
	}
}

/** A listener registered on a {@link GraphEventBus}. */
export type GraphEventListener = (event: GraphEvent) => void;

/**
 * In-process event bus (Layer 1). Register per-op or catch-all listeners; each fires synchronously
 * on `emit`. A throwing listener is swallowed so one bad consumer can't break a sibling consumer or
 * the mutation that emitted the event. `on`/`onAny` return an unsubscribe thunk.
 */
export class GraphEventBus implements GraphEventSink {
	private readonly byOpListeners = new Map<GraphEventOp, Set<GraphEventListener>>();
	private readonly anyListeners = new Set<GraphEventListener>();

	emit(event: GraphEvent): void {
		for (const fn of this.anyListeners) {
			try {
				fn(event);
			} catch {
				/* a listener must never break emit or its siblings */
			}
		}
		const set = this.byOpListeners.get(event.op);
		if (set) {
			for (const fn of set) {
				try {
					fn(event);
				} catch {
					/* swallow */
				}
			}
		}
	}

	/** Subscribe to one op. Returns an unsubscribe thunk. */
	on(op: GraphEventOp, fn: GraphEventListener): () => void {
		let set = this.byOpListeners.get(op);
		if (!set) {
			set = new Set();
			this.byOpListeners.set(op, set);
		}
		set.add(fn);
		return () => {
			set.delete(fn);
		};
	}

	/** Subscribe to every event. Returns an unsubscribe thunk. */
	onAny(fn: GraphEventListener): () => void {
		this.anyListeners.add(fn);
		return () => {
			this.anyListeners.delete(fn);
		};
	}
}

/**
 * Wrap a sink so every emitted event is stamped with `{tenant, project}` — the HTTP edge (serve.ts)
 * decorates the app-level sink per request so a shared sink can attribute events to their namespace.
 */
export function scopeEvents(
	sink: GraphEventSink,
	ctx: { tenant?: string; project?: string },
): GraphEventSink {
	return {
		emit(event: GraphEvent): void {
			sink.emit({ ...event, tenant: ctx.tenant, project: ctx.project });
		},
	};
}
