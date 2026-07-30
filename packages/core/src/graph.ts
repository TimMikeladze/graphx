import { setTimeout as sleep } from 'node:timers/promises';
import {
	type DbClient,
	type DbTransaction,
	dialectOf,
	type SqlRow,
	type SqlStatement,
	type SqlValue,
} from './dialect.ts';
import { distinctSelect, embFreshExpr, embRebindExpr, ftsWhere } from './dialect-sql.ts';
import { ftsArg } from './hybrid.ts';
import { ulid } from 'ulidx';
import type { z } from 'zod';
import { FOREVER, type FtsIndexOwner, ftsIndexOwner, type ManagedWriter, managedWriter } from './db.ts';
import { assertUniqueProps } from './duck-constraints.ts';
import { embParam } from './duck-value.ts';
import {
	type GraphEvent,
	type GraphEventOptions,
	type GraphEventSink,
	NOOP_EVENTS,
} from './events.ts';
import { asOfPredicate } from './temporal.ts';
import type { AnyNode, NodeType, NodeOf, Rel } from './define-graph-schema.ts';
import {
	applyLimit,
	decodeCursor,
	encodeCursor,
	type QueryLimits,
	resolveLimits,
} from './governance.ts';
import { Upcaster, type UpcasterRegistry } from './upcast.ts';

/**
 * P3 — data layer (§6). The temporal store front: ULID identity, close-and-insert
 * versioning, current reads through the live-only `nodes`/`edges` views (D3).
 *
 * `S` is the `defineGraphSchema(...)` value (P2). The constructor takes the raw
 * libSQL `Client` (PUBLIC — P4/P6/P7 read `graph.raw` directly) and that schema.
 */

/** Loosened schema shape; the `defineGraphSchema` types ride on `S` at call sites. */
export type GraphSchema = { nodes: Record<string, unknown>; edges: Record<string, unknown> };

/**
 * Zod INPUT prop type for node type `K` — the shape a caller passes to `addNode`
 * (defaults optional), as opposed to `DataOf` which is the parsed OUTPUT.
 */
export type DataInput<
	S extends GraphSchema,
	K extends NodeType<S>,
> = S['nodes'][K] extends z.ZodType ? z.input<S['nodes'][K]> : Record<string, unknown>;

/** Zod INPUT edge-prop type for rel `R` (or `undefined` when the rel has no data schema). */
export type EdgeDataInput<S extends GraphSchema, R extends Rel<S>> = S['edges'][R] extends {
	data: infer P;
}
	? P extends z.ZodType
		? z.input<P>
		: Record<string, unknown>
	: Record<string, unknown> | undefined;

/** Input to {@link Graph.addNode}. `data` is the unparsed prop object for the type. */
export interface AddNodeInput<S extends GraphSchema, K extends NodeType<S>> {
	type: K;
	data: DataInput<S, K>;
	emb?: number[];
	body?: string;
	uri?: string;
	content_hash?: string;
	embed_hash?: string;
	content_type?: string;
}

/** Input to {@link Graph.addEdge}. `src`/`dst` are ULID node ids. */
export interface AddEdgeInput<S extends GraphSchema, R extends Rel<S>> {
	rel: R;
	src: string;
	dst: string;
	weight?: number;
	data?: EdgeDataInput<S, R>;
	/**
	 * Optional provenance tag for the edge writer (e.g. `ingest:<source>:`). Stored verbatim in
	 * the `source` column; `null` when unset. Lets an authority (ingest) reconcile only the edges
	 * it authored and leave edges added by other writers (admin UI, enrichment) untouched.
	 */
	source?: string;
}

/** Result of {@link Graph.getNodeContent} — the live version's content payload + provenance. */
export interface NodeContent {
	/** The node's text/markdown content (`null` when the node carries none). */
	body: string | null;
	/** Where the content came from (an ingest source key), or `null` for UI/SDK-authored nodes. */
	uri: string | null;
	contentType: string | null;
	contentHash: string | null;
}

/** Result of {@link Graph.addEdge}. */
export interface EdgeRef {
	id: string;
	rel: string;
	src: string;
	dst: string;
}

/** Traversal options for {@link Graph.neighbors}. */
export interface NeighborOpts {
	direction?: 'forward' | 'reverse' | 'both';
	rels?: string[];
	/** As-of epoch ms (D3 half-open read). Omit ⇒ current (live) edges and nodes. */
	asOf?: number;
	/** §19.2 per-call governance caps; `maxRows` bounds the result (default 10k). */
	limits?: Partial<QueryLimits>;
}

/** Options for {@link Graph.neighborsPage} — keyset pagination over neighbor id (§19.7). */
export interface NeighborPageOpts extends NeighborOpts {
	/** Page size; clamped to `maxRows`. Defaults to `maxRows`. */
	limit?: number;
	/** Opaque cursor from a prior page's `nextCursor`; omit for the first page. */
	cursor?: string;
}

/** One page of {@link Graph.neighborsPage}: the rows + the cursor for the next page. */
export interface NeighborPage<S extends GraphSchema> {
	rows: AnyNode<S>[];
	/** `null` when this is the last page. */
	nextCursor: string | null;
}

/** Filter/pagination options for {@link Graph.listNodes}. */
export interface NodeListOpts {
	/** Restrict to one node type. */
	type?: string;
	/** Full-text query over `body` (FTS5). No usable tokens ⇒ empty page. */
	q?: string;
	/** As-of epoch ms (D3 half-open read). Omit ⇒ current (live) nodes. */
	asOf?: number;
	/** Page size; clamped to `maxRows`. Defaults to `maxRows`. */
	limit?: number;
	/** Opaque keyset cursor from a prior page's `nextCursor`; omit for the first page. */
	cursor?: string;
	/** §19.2 governance caps; `maxRows` bounds the page (default 10k). */
	limits?: Partial<QueryLimits>;
}

/** One page of {@link Graph.listNodes}: the rows + the cursor for the next page. */
export interface NodeListPage<S extends GraphSchema> {
	nodes: AnyNode<S>[];
	/** `null` when this is the last page. */
	nextCursor: string | null;
}

/** Filter options for {@link Graph.graphSlice}. */
export interface GraphSliceOpts {
	type?: string;
	q?: string;
	asOf?: number;
	limits?: Partial<QueryLimits>;
}

/** A canvas node in a {@link GraphSlice}. */
export interface GraphSliceNode {
	id: string;
	type: string;
	/**
	 * A human-readable label for rendering on the canvas — the first {@link LABEL_KEYS} property
	 * the node's data carries. Absent when it carries none, and callers fall back to the type or
	 * the id. This is the ONLY part of `data` the slice exposes: the canvas needs a caption, not
	 * the props (that is what `GET /nodes/:id` is for).
	 */
	label?: string;
	/**
	 * An avatar/thumbnail URL for rendering the node as a picture instead of a plain dot — the
	 * first {@link IMAGE_KEYS} property the node's data carries, and only when it passes
	 * {@link isRenderableImageUrl}. Absent when the node carries none.
	 */
	image?: string;
}

/** A canvas link in a {@link GraphSlice} (Cosmograph `source`/`target` naming). */
export interface GraphSliceLink {
	id: string;
	source: string;
	target: string;
	rel: string;
	weight: number;
}

/** A governed graph slice for the Cosmograph canvas: the filtered node set + edges among them. */
export interface GraphSlice {
	nodes: GraphSliceNode[];
	links: GraphSliceLink[];
	/** True when the node set hit the `maxRows` cap (UI shows a "narrow filters" banner). */
	truncated: boolean;
}

/**
 * Property keys, in priority order, that carry a human-readable node label. Kept in sync with
 * the admin UI's `bestLabel`, so a node reads the same on the canvas as in the node list.
 */
const LABEL_KEYS = ['name', 'title', 'label', 'displayName', 'display_name', 'heading', 'slug'];

/** Longest label the slice will carry — a canvas caption, not a body. */
const LABEL_MAX = 80;

/** Parse a `data` column, tolerating the impossible-but-cheap-to-guard malformed row. */
function parseData(raw: unknown): Record<string, unknown> {
	try {
		return JSON.parse(String(raw)) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** The first {@link LABEL_KEYS} property that holds a non-empty string, trimmed and capped. */
function sliceLabel(data: Record<string, unknown>): string | undefined {
	for (const k of LABEL_KEYS) {
		const v = data[k];
		if (typeof v === 'string' && v.trim()) return v.trim().slice(0, LABEL_MAX);
	}
	return undefined;
}

/**
 * Property keys, in priority order, that carry a node's avatar/thumbnail URL. Kept in sync with
 * the admin UI, so a node shows the same picture on either canvas.
 */
const IMAGE_KEYS = [
	'image',
	'imageUrl',
	'image_url',
	'avatar',
	'avatarUrl',
	'avatar_url',
	'thumbnail',
	'icon',
	'photo',
];

/**
 * Longest image URL the slice will carry. Also the reason `data:` URIs are not accepted: a real
 * inline image is orders of magnitude longer than this, and a slice may hold thousands of nodes.
 */
const IMAGE_URL_MAX = 512;

/**
 * Whether a URL is safe to hand a renderer. A node's `data` is author-controlled and its image
 * ends up in an `<img src>`, so only absolute http(s) URLs pass — `javascript:` and friends are
 * rejected here rather than trusted to the client.
 */
function isRenderableImageUrl(url: string): boolean {
	const scheme = url.slice(0, 8).toLowerCase();
	return scheme.startsWith('https://') || scheme.startsWith('http://');
}

/** The first {@link IMAGE_KEYS} property that holds a short, renderable http(s) URL. */
function sliceImage(data: Record<string, unknown>): string | undefined {
	for (const k of IMAGE_KEYS) {
		const v = data[k];
		if (typeof v !== 'string') continue;
		const url = v.trim();
		if (url.length > 0 && url.length <= IMAGE_URL_MAX && isRenderableImageUrl(url)) return url;
	}
	return undefined;
}

/** One edge def as carried by P2 (data/from/to/single all optional). */
interface RawEdgeDef {
	data?: { parse: (v: unknown) => unknown };
	from?: string | readonly string[];
	to?: string | readonly string[];
	single?: boolean;
}

/** One node prop schema as carried by P2 (a zod object). */
interface RawNodeDef {
	parse: (v: unknown) => unknown;
}

function toTypeSet(spec: string | readonly string[] | undefined): Set<string> | null {
	if (spec === undefined) return null;
	return new Set(typeof spec === 'string' ? [spec] : spec);
}

/**
 * Bound on the conditional-close retry loop (§19.1). The spec's "5-retry" covered only
 * supersession (a concurrent writer closed the row first); under genuine contention an
 * interactive `transaction('write')` can also fail fast with `SQLITE_BUSY` (its
 * connection never gets `busy_timeout`), so the loop must also retry that — with a
 * larger budget and a backoff so racing writers all make progress without overlap.
 */
const WRITE_MAX_RETRIES = 50;

/**
 * Transient write contention — safe to roll back + retry. libSQL: `SQLITE_BUSY`/`LOCKED`.
 * Postgres: SQLSTATE 40001 (serialization_failure, raised by SERIALIZABLE conflicts),
 * 40P01 (deadlock_detected), 55P03 (lock_not_available). DuckDB has neither a `.code` nor
 * a SQLSTATE: a write-write conflict is a plain `TransactionContext Error`. Without that,
 * every DuckDB conflict fell straight through the retry envelope to the caller.
 *
 * A lost commit race is deliberately NOT here. `SnapshotStore.commit` already absorbs it
 * by rebasing, and what escapes that loop — exhausted attempts, or a conflicting concurrent
 * writer — is not fixed by re-running the local write, which has already been applied.
 */
function isRetryableContention(e: unknown): boolean {
	const code = (e as { code?: unknown } | null)?.code;
	if (
		code === 'SQLITE_BUSY' ||
		code === 'SQLITE_BUSY_SNAPSHOT' ||
		code === 'SQLITE_LOCKED' ||
		code === '40001' ||
		code === '40P01' ||
		code === '55P03'
	) {
		return true;
	}
	const msg = String((e as { message?: unknown } | null)?.message ?? '');
	return /database (?:table )?is locked|SQLITE_BUSY|could not serialize|deadlock detected|Conflict on|transaction is aborted|TransactionContext Error/i.test(
		msg,
	);
}

/** Full-jitter exponential backoff (capped) between contended write attempts. */
function backoff(attempt: number): Promise<void> {
	const base = Math.min(2 ** attempt, 64);
	return sleep(base + Math.random() * base);
}

export class Graph<S extends GraphSchema> {
	/** Monotonic write clock high-water mark (M6) — avoids same-ms zero-width versions. */
	private lastTs = 0;
	/** id -> type cache, populated on write and on getNode/lookup (endpoint checks). */
	private typeCache = new Map<string, string>();
	/** P12 read-time upcaster (§15). Empty registry ⇒ identity (pre-P12 behavior). */
	private readonly upcaster: Upcaster;
	/** Eventing sink (Layer 1). {@link NOOP_EVENTS} when unconfigured ⇒ byte-identical to pre-eventing. */
	private readonly events: GraphEventSink;
	/** Co-write events into the durable `graph_outbox` in the mutation's own tx (Layer 2). */
	private readonly outbox: boolean;
	/** Retained so {@link withEventSource} can build a sibling without losing read-time upcasting. */
	private readonly upcasters: UpcasterRegistry;
	/** Provenance stamped on every emitted event and outbox row; `undefined` ⇒ a user write. */
	private readonly eventSource: string | undefined;
	/** Retained verbatim so {@link withEventSource} inherits the sink and outbox setting. */
	private readonly eventOpts: GraphEventOptions | undefined;
	/** The backend's writer serialization + snapshot publishing, when it has any. */
	private readonly writer: ManagedWriter | null;
	/** The backend's self-maintained full-text index, when it has any. */
	private readonly fts: FtsIndexOwner | null;
	/** Tables the open {@link write} session has touched, or undefined when none is open. */
	private session?: Set<string>;

	constructor(
		public raw: DbClient,
		public schema: S,
		upcasters?: UpcasterRegistry,
		events?: GraphEventOptions,
	) {
		this.upcasters = upcasters ?? {};
		this.upcaster = new Upcaster(schema, this.upcasters);
		this.events = events?.sink ?? NOOP_EVENTS;
		this.outbox = events?.outbox ?? false;
		this.eventSource = events?.source;
		this.eventOpts = events;
		this.writer = managedWriter(raw);
		this.fts = ftsIndexOwner(raw);
	}

	/**
	 * Group every mutation in `fn` into ONE snapshot commit.
	 *
	 * A commit is a set of object PUTs plus a manifest CAS, so committing per mutation is
	 * untenable for anything but a single write. A bare `addNode()` outside a session still
	 * commits on its own — the API is unchanged — but a batch of work belongs in here.
	 *
	 * A nested call joins the enclosing session, so the outermost one owns the commit. A
	 * body that throws commits nothing: the local database is a materialization of the last
	 * snapshot, so discarding it and reloading is the rollback.
	 *
	 * On libSQL and Postgres there is no snapshot chain to batch into, so this just runs
	 * `fn` — the durable state is already the database.
	 */
	async write<T>(fn: (g: Graph<S>) => Promise<T>): Promise<T> {
		if (this.session || !this.writer?.durable) return fn(this);
		const dirty = new Set<string>();
		this.session = dirty;
		try {
			const out = await fn(this);
			this.session = undefined;
			await this.writer.commit(dirty);
			return out;
		} catch (e) {
			this.session = undefined;
			await this.writer.reload();
			throw e;
		}
	}

	/**
	 * Record a mutation's tables as changed — into the open session, or, when there is
	 * none, as its own commit. A no-op on a backend whose durable state IS the database.
	 */
	private async touched(...tables: string[]): Promise<void> {
		if (tables.includes('node_versions')) this.fts?.markFtsStale();
		if (this.session) {
			for (const t of tables) this.session.add(t);
			return;
		}
		if (this.writer?.durable) await this.writer.commit(new Set(tables));
	}

	/**
	 * Run a write with every other write on this client held back. See
	 * {@link ManagedWriter.serializeWrite} for why DuckDB needs it and the other two
	 * backends do not: they reserve the writer in the database, so serializing here would
	 * only remove the contention their retry envelope exists to prove correct under.
	 */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		return this.writer ? this.writer.serializeWrite(fn) : fn();
	}

	/**
	 * A sibling `Graph` over the same client, schema and upcasters whose events carry `source`.
	 * The trigger runner hands one of these to every action, so a trigger's derived writes are
	 * attributable and the matcher's default predicate can exclude them.
	 */
	withEventSource(source: string): Graph<S> {
		return new Graph(this.raw, this.schema, this.upcasters, { ...this.eventOpts, source });
	}

	/**
	 * Deliver an event to the sink after the mutation has committed. Guarded: a throwing
	 * sink can never break (or roll back) the write that produced the event.
	 */
	private emit(event: GraphEvent): void {
		try {
			this.events.emit(
				this.eventSource === undefined ? event : { ...event, source: this.eventSource },
			);
		} catch {
			/* a sink must never break a committed mutation */
		}
	}

	/**
	 * The durable-outbox INSERT for an event, or `null` when the outbox is disabled (⇒ nothing
	 * appended, byte-identical to the pre-eventing write). Appended to the mutation's batch (insert
	 * paths) or `tx.execute`d before commit (conditional-close paths) so it commits atomically with
	 * the version rows. `seq` is assigned by the table (AUTOINCREMENT / IDENTITY), not bound here.
	 */
	private outboxStmt(event: GraphEvent): SqlStatement | null {
		if (!this.outbox) return null;
		return {
			sql: `INSERT INTO graph_outbox (op, entity, id, label, src, dst, shape, ts, source)
				VALUES (?,?,?,?,?,?,?,?,?)`,
			args: [
				event.op,
				event.entity,
				event.id,
				event.label,
				event.src ?? null,
				event.dst ?? null,
				event.shape,
				event.ts,
				this.eventSource ?? null,
			],
		};
	}

	/**
	 * Monotonic write clock (M6): strictly increasing across rapid writes so two
	 * mutations in the same millisecond never produce a zero-width `[T,T)` interval.
	 */
	private now(): number {
		const t = Math.max(Date.now(), this.lastTs + 1);
		this.lastTs = t;
		return t;
	}

	/**
	 * Insert a node: validate data (parsed output stored), mint a ULID, write the
	 * identity row + the first open version atomically. B5: omit-emb inserts SQL
	 * NULL (never `vector('[]')`, which throws on dim 0); a supplied embedding binds
	 * `vector(?)` with its JSON form.
	 */
	async addNode<K extends NodeType<S>>(n: AddNodeInput<S, K>): Promise<NodeOf<S, K>> {
		const def = (this.schema.nodes as Record<string, RawNodeDef | undefined>)[n.type];
		if (!def) throw new Error(`addNode: unknown type '${n.type}'`);
		const parsed = def.parse(n.data) as NodeOf<S, K>['data'];
		const id = ulid();
		const ts = this.now();

		// P12: stamp the type's current `_v` into the STORED data (so future readers
		// know which upcasters to run). The in-memory return stays the clean parsed
		// shape (no `_v`). An unregistered type stamps nothing — byte-identical to pre-P12;
		// a type that itself declares the reserved `_v` throws (no silent clobber).
		const storedData = this.upcaster.stamp(n.type, parsed as Record<string, unknown>);

		const common = [
			id,
			n.type,
			n.body ?? null,
			n.uri ?? null,
			n.content_hash ?? null,
			n.embed_hash ?? null,
			n.content_type ?? null,
			JSON.stringify(storedData),
		];
		// B5: emb present -> vector(?) with the JSON array; absent -> literal NULL.
		const versionStmt: SqlStatement = n.emb
			? {
					sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, embed_hash, content_type, data, emb, valid_from)
						VALUES (?,?,?,?,?,?,?,?, ${embFreshExpr(dialectOf(this.raw))}, ?)`,
					args: [...common, JSON.stringify(n.emb), ts],
				}
			: {
					sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, embed_hash, content_type, data, emb, valid_from)
						VALUES (?,?,?,?,?,?,?,?, NULL, ?)`,
					args: [...common, ts],
				};

		// foreign_keys is ON, so the identity row must land before the version row. The
		// batch is wrapped in the same contention-retry envelope as the close paths: an
		// interactive transaction() elsewhere on this client drops busy_timeout to 0, so a
		// later append BEGIN IMMEDIATE can fail fast with SQLITE_BUSY and must be retried,
		// not lost (§19.1, write-correctness).
		const event: GraphEvent = {
			op: 'node.create',
			entity: 'node',
			id,
			label: n.type,
			shape: 'insert',
			ts,
		};
		const stmts: SqlStatement[] = [
			{ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] },
			versionStmt,
		];
		const ob = this.outboxStmt(event);
		if (ob) stmts.push(ob); // co-write the event row in the same atomic batch (Layer 2)
		// DuckDB has no store-level backing for declared-unique props (see
		// duck-constraints.ts); libSQL/Postgres enforce it via their partial index instead.
		if (dialectOf(this.raw) === 'duckdb') {
			await assertUniqueProps(this.raw, n.type, parsed as Record<string, unknown>);
		}
		await this.runWriteBatch('addNode', () => this.raw.batch(stmts, 'write'));
		await this.touched('node_identity', 'node_versions', 'graph_outbox');

		this.typeCache.set(id, n.type);
		this.emit(event); // post-commit
		return { id, type: n.type, data: parsed };
	}

	/**
	 * Insert an edge: validate data per rel (when a data schema is defined), check
	 * src/dst types against the rel's `from`/`to`, mint a ULID, write identity + the
	 * first open version atomically. `valid_from` uses the monotonic clock.
	 */
	async addEdge<R extends Rel<S>>(e: AddEdgeInput<S, R>): Promise<EdgeRef> {
		const def = (this.schema.edges as Record<string, RawEdgeDef | undefined>)[e.rel];
		if (!def) throw new Error(`addEdge: unknown rel '${e.rel}'`);
		const parsedData = def.data ? def.data.parse(e.data ?? {}) : (e.data ?? {});

		const fromSet = toTypeSet(def.from);
		const toSet = toTypeSet(def.to);
		if (fromSet) {
			const srcType = await this.typeOf(e.src);
			if (srcType === null || !fromSet.has(srcType)) {
				throw new Error(
					`addEdge: rel '${e.rel}' src '${e.src}' has type '${srcType}', expected one of ${[...fromSet].join(', ')}`,
				);
			}
		}
		if (toSet) {
			const dstType = await this.typeOf(e.dst);
			if (dstType === null || !toSet.has(dstType)) {
				throw new Error(
					`addEdge: rel '${e.rel}' dst '${e.dst}' has type '${dstType}', expected one of ${[...toSet].join(', ')}`,
				);
			}
		}

		const id = ulid();
		const data = JSON.stringify(parsedData);
		const weight = e.weight ?? 1.0;
		const insertEdge = (ts: number): SqlStatement[] => [
			{ sql: 'INSERT INTO edge_identity (id) VALUES (?)', args: [id] },
			{
				sql: `INSERT INTO edge_versions (id, src, dst, rel, weight, data, source, valid_from)
						VALUES (?,?,?,?,?,?,?,?)`,
				args: [id, e.src, e.dst, e.rel, weight, data, e.source ?? null, ts],
			},
		];

		if (def.single) {
			// §19.5 single-valued cardinality: close any existing live (src, rel) edge and
			// insert the successor in ONE interactive write tx (BEGIN IMMEDIATE), mirroring
			// updateNode. The high-water-mark read MUST be inside the tx — an autocommit read
			// before a separate write lets a concurrent writer's newer edge be closed at a
			// stale ts, inverting its interval. Reading valid_from in-tx and bumping
			// ts = max(now, vf+1) keeps every closed interval real (M6); the BEGIN IMMEDIATE
			// serializes writers (last write wins) and a partial unique index hard-guarantees
			// exactly one live edge. Like updateNode/deleteEdge this needs a `file:` DB on
			// :memory: (transaction() detaches the connection).
			let events: GraphEvent[] = [];
			await this.runConditionalClose('addEdge', async (tx, rawNow) => {
				// Read EVERY live (src, rel) edge, not just the newest: the UPDATE below closes ALL of
				// them, so a supersede must be emitted per closed row. With the ux_single partial unique
				// index (materializeConstraints) there is <=1 live row and this is identical to before; when
				// the index was not materialized (or a race left >1 live edge) every close is still reported.
				const liveRows = (
					await tx.execute({
						sql: 'SELECT id, dst, valid_from AS vf FROM edge_versions WHERE src = ? AND rel = ? AND valid_to = ?',
						args: [e.src, e.rel, FOREVER],
					})
				).rows;
				let maxVf = 0;
				for (const r of liveRows) {
					const v = Number(r.vf);
					if (v > maxVf) maxVf = v;
				}
				const ts = liveRows.length > 0 ? Math.max(rawNow, maxVf + 1) : rawNow;
				const closed = await tx.execute({
					sql: 'UPDATE edge_versions SET valid_to = ? WHERE src = ? AND rel = ? AND valid_to = ?',
					args: [ts, e.src, e.rel, FOREVER],
				});
				for (const stmt of insertEdge(ts)) await tx.execute(stmt);
				const evs: GraphEvent[] = [];
				// A prior live (src, rel) edge was closed => an explicit supersede/close event the
				// valid_from CDC feed is structurally blind to. One event per row actually closed.
				// rowsAffected === liveRows.length always holds here: the read and the close share ONE
				// SERIALIZABLE / BEGIN IMMEDIATE tx, so the live set can't shift under us (a racing close
				// aborts this attempt, which retries). The equality guard states that invariant and can
				// never over-emit; length 0 (no prior live edge) emits nothing.
				if (closed.rowsAffected === liveRows.length) {
					for (const r of liveRows) {
						evs.push({
							op: 'edge.supersede',
							entity: 'edge',
							id: String(r.id),
							label: e.rel,
							shape: 'close',
							ts,
							src: e.src,
							dst: r.dst != null ? String(r.dst) : undefined,
						});
					}
				}
				evs.push({
					op: 'edge.create',
					entity: 'edge',
					id,
					label: e.rel,
					shape: 'insert',
					ts,
					src: e.src,
					dst: e.dst,
				});
				for (const ev of evs) {
					const stmt = this.outboxStmt(ev);
					if (stmt) await tx.execute(stmt); // co-write in the same tx (Layer 2)
				}
				await tx.commit();
				events = evs;
				return 'committed';
			});
			await this.touched('edge_identity', 'edge_versions', 'graph_outbox');
			for (const ev of events) this.emit(ev); // post-commit
			return { id, rel: e.rel, src: e.src, dst: e.dst };
		}

		// Normal (multi-valued) rel: a plain atomic append under the §19.1 contention-retry
		// envelope (an interactive transaction() elsewhere on this client drops busy_timeout
		// to 0, so a later batch BEGIN IMMEDIATE can fail fast and must be retried, not lost).
		const ts = this.now();
		const event: GraphEvent = {
			op: 'edge.create',
			entity: 'edge',
			id,
			label: e.rel,
			shape: 'insert',
			ts,
			src: e.src,
			dst: e.dst,
		};
		const stmts = insertEdge(ts);
		const ob = this.outboxStmt(event);
		if (ob) stmts.push(ob);
		await this.runWriteBatch('addEdge', () => this.raw.batch(stmts, 'write'));
		await this.touched('edge_identity', 'edge_versions', 'graph_outbox');
		this.emit(event); // post-commit
		return { id, rel: e.rel, src: e.src, dst: e.dst };
	}

	/**
	 * Read a node's version through the live `nodes` view (D3), or — when `asOf` names a past
	 * instant — the single `node_versions` row whose half-open interval contains it. Returns the
	 * typed `{ id, type, data }` shape with data parsed back to an object, or `null` when no
	 * version was live then.
	 */
	async getNode(id: string, opts: { asOf?: number } = {}): Promise<AnyNode<S> | null> {
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const r = await this.raw.execute(
			past
				? {
						sql: `SELECT id, type, data FROM node_versions nv WHERE nv.id = ? AND ${asOfPredicate('nv')}`,
						args: [id, opts.asOf as number, opts.asOf as number],
					}
				: { sql: 'SELECT id, type, data FROM nodes WHERE id = ?', args: [id] },
		);
		const row = r.rows[0];
		if (!row) return null;
		return this.rowToNode(row);
	}

	/**
	 * The live version's content columns — the markdown/text `body` and its provenance. Separate
	 * from {@link getNode} because `AnyNode` is the *typed* projection (`id`/`type`/`data`) that
	 * SDK consumers destructure; content is a bulkier, rarely-needed payload fetched on demand.
	 * Accepts the same `asOf` as {@link getNode} to read a past instant's body/provenance.
	 */
	async getNodeContent(id: string, opts: { asOf?: number } = {}): Promise<NodeContent | null> {
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const cols = 'body, uri, content_type, content_hash';
		const r = await this.raw.execute(
			past
				? {
						sql: `SELECT ${cols} FROM node_versions nv WHERE nv.id = ? AND ${asOfPredicate('nv')}`,
						args: [id, opts.asOf as number, opts.asOf as number],
					}
				: { sql: `SELECT ${cols} FROM nodes WHERE id = ?`, args: [id] },
		);
		const row = r.rows[0];
		if (!row) return null;
		return {
			body: (row.body as string | null) ?? null,
			uri: (row.uri as string | null) ?? null,
			contentType: (row.content_type as string | null) ?? null,
			contentHash: (row.content_hash as string | null) ?? null,
		};
	}

	/**
	 * Build the directional neighbor-id subquery (live `edges` view) + its args.
	 * forward: src=id→dst; reverse: dst=id→src; both: UNION (dedups nids). Shared by
	 * {@link neighbors} and {@link neighborsPage}.
	 */
	private neighborSubquery(
		id: string,
		opts: NeighborOpts,
	): { sql: string; args: (string | number)[] } {
		const direction = opts.direction ?? 'forward';
		const rels = opts.rels && opts.rels.length > 0 ? opts.rels : null;
		const relClause = rels ? ` AND e.rel IN (${rels.map(() => '?').join(',')})` : '';
		// Past reads walk the version table under the half-open predicate; live reads keep the
		// `edges` view (D3). The predicate's two binds follow that side's rel binds.
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const from = past ? 'edge_versions e' : 'edges e';
		const temporal = past ? ` AND ${asOfPredicate('e')}` : '';
		const side = (t: number | undefined) =>
			past ? [...(rels ?? []), t as number, t as number] : [...(rels ?? [])];
		const args: (string | number)[] = [];
		let sql: string;
		if (direction === 'forward') {
			sql = `SELECT e.dst AS nid FROM ${from} WHERE e.src = ?${relClause}${temporal}`;
			args.push(id, ...side(opts.asOf));
		} else if (direction === 'reverse') {
			sql = `SELECT e.src AS nid FROM ${from} WHERE e.dst = ?${relClause}${temporal}`;
			args.push(id, ...side(opts.asOf));
		} else {
			sql =
				`SELECT e.dst AS nid FROM ${from} WHERE e.src = ?${relClause}${temporal} ` +
				`UNION SELECT e.src AS nid FROM ${from} WHERE e.dst = ?${relClause}${temporal}`;
			args.push(id, ...side(opts.asOf), id, ...side(opts.asOf));
		}
		return { sql, args };
	}

	/**
	 * Neighbor nodes reached over the live `edges` view in the given direction
	 * (forward: src=id→dst; reverse: dst=id→src; both: union), optionally filtered
	 * to `rels`. Returns the neighbor nodes (live shape, AnyNode[]). The §19.2 row cap
	 * (`opts.limits.maxRows`, default 10k) bounds the result so a supernode can't OOM.
	 */
	async neighbors(id: string, opts: NeighborOpts = {}): Promise<AnyNode<S>[]> {
		const { sql: neighborSql, args } = this.neighborSubquery(id, opts);
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const join = past
			? `JOIN node_versions n ON n.id = nb.nid AND ${asOfPredicate('n')}`
			: 'JOIN nodes n ON n.id = nb.nid';
		const joinArgs = past ? [opts.asOf as number, opts.asOf as number] : [];
		const sql = applyLimit(
			`SELECT n.id AS id, n.type AS type, n.data AS data
			FROM (${neighborSql}) nb
			${join}
			ORDER BY n.id`,
			resolveLimits(opts.limits).maxRows,
		);
		const r = await this.raw.execute({ sql, args: [...args, ...joinArgs] });
		return r.rows.map((row) => this.rowToNode(row));
	}

	/**
	 * Keyset-paginated {@link neighbors} (§19.7). Orders by the stable neighbor id and
	 * pages with an opaque `cursor` (the last id of the previous page), so pages never
	 * overlap or skip even as new neighbors are inserted concurrently. Over-fetches one
	 * row to decide `nextCursor` without a second query; `nextCursor` is `null` on the
	 * last page. The page size is clamped to `maxRows`.
	 */
	async neighborsPage(id: string, opts: NeighborPageOpts = {}): Promise<NeighborPage<S>> {
		if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
			throw new Error(`neighborsPage: limit must be a positive integer, got ${opts.limit}`);
		}
		const { sql: neighborSql, args } = this.neighborSubquery(id, opts);
		const maxRows = resolveLimits(opts.limits).maxRows;
		const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const join = past
			? `JOIN node_versions n ON n.id = nb.nid AND ${asOfPredicate('n')}`
			: 'JOIN nodes n ON n.id = nb.nid';
		const pageArgs: (string | number)[] = [...args];
		if (past) pageArgs.push(opts.asOf as number, opts.asOf as number);
		let cursorClause = '';
		if (opts.cursor) {
			const [lastId] = decodeCursor(opts.cursor);
			cursorClause = ' WHERE n.id > ?';
			pageArgs.push(lastId as string);
		}
		// Dedup by n.id so the keyset key is unique even when multiple edges reach the
		// same neighbor (a duplicate nid would otherwise break no-overlap/no-skip).
		const { select, group } = distinctSelect(
			dialectOf(this.raw),
			'n.id',
			'n.id AS id, n.type AS type, n.data AS data',
		);
		const sql = `${select}
			FROM (${neighborSql}) nb
			${join}${cursorClause}
			${group}
			ORDER BY n.id
			LIMIT ?`;
		pageArgs.push(pageSize + 1); // over-fetch one to detect a next page
		const r = await this.raw.execute({ sql, args: pageArgs });
		const rows = r.rows.map((row) => this.rowToNode(row));
		if (rows.length > pageSize) {
			const page = rows.slice(0, pageSize);
			return { rows: page, nextCursor: encodeCursor([(page[page.length - 1] as AnyNode<S>).id]) };
		}
		return { rows, nextCursor: null };
	}

	/**
	 * Build the node-filter WHERE for {@link listNodes}/{@link graphSlice} over `node_versions`
	 * aliased `nv`: a temporal predicate (live via the FOREVER sentinel, or as-of half-open),
	 * an optional `type`, and an optional FTS `q` (joined by `ver` into `nodes_fts`). Returns
	 * `null` when `q` is present but yields no tokens (⇒ caller returns an empty result).
	 */
	private nodeFilter(opts: {
		type?: string;
		q?: string;
		asOf?: number;
	}): { where: string; args: (string | number)[] } | null {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (opts.asOf !== undefined) {
			where.push('nv.valid_from <= ? AND ? < nv.valid_to');
			args.push(opts.asOf, opts.asOf);
		} else {
			where.push('nv.valid_to = ?');
			args.push(FOREVER);
		}
		if (opts.type) {
			where.push('nv.type = ?');
			args.push(opts.type);
		}
		if (opts.q !== undefined) {
			const d = dialectOf(this.raw);
			const arg = ftsArg(d, opts.q);
			if (arg === null) return null;
			where.push(ftsWhere(d, 'nv'));
			args.push(arg);
		}
		return { where: where.join(' AND '), args };
	}

	/**
	 * List nodes with optional `type`/full-text/as-of filters, keyset-paginated by id (§19.7)
	 * and bounded by the §19.2 row cap. Each id has exactly one matching version (live, or the
	 * single as-of version), so the id keyset is a strict total order — no skip, no overlap.
	 * Props are upcast + parsed via the same path as `getNode`/`neighbors` (P12).
	 */
	async listNodes(opts: NodeListOpts = {}): Promise<NodeListPage<S>> {
		if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
			throw new Error(`listNodes: limit must be a positive integer, got ${opts.limit}`);
		}
		if (opts.q !== undefined) await this.fts?.ensureFtsFresh();
		const filter = this.nodeFilter(opts);
		if (filter === null) return { nodes: [], nextCursor: null };
		const maxRows = resolveLimits(opts.limits).maxRows;
		const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
		const args = [...filter.args];
		let cursorClause = '';
		if (opts.cursor) {
			const [lastId] = decodeCursor(opts.cursor);
			cursorClause = ' AND nv.id > ?';
			args.push(lastId as string);
		}
		const sql = `SELECT nv.id AS id, nv.type AS type, nv.data AS data
			FROM node_versions nv
			WHERE ${filter.where}${cursorClause}
			ORDER BY nv.id
			LIMIT ?`;
		args.push(pageSize + 1); // over-fetch one to detect a next page
		const r = await this.raw.execute({ sql, args });
		const rows = r.rows.map((row) => this.rowToNode(row));
		if (rows.length > pageSize) {
			const page = rows.slice(0, pageSize);
			return { nodes: page, nextCursor: encodeCursor([(page[page.length - 1] as AnyNode<S>).id]) };
		}
		return { nodes: rows, nextCursor: null };
	}

	/**
	 * A governed graph slice for the canvas (D-UI-3): the filtered node set (capped at the §19.2
	 * row cap) plus every edge whose BOTH endpoints are in that set. The node set is the same
	 * filter as {@link listNodes} (live or as-of), evaluated as an SQL subquery so the edge
	 * endpoint membership tests never materialize a giant `IN (...)` parameter list. `truncated`
	 * signals the node set hit the cap so the UI can prompt to narrow filters.
	 */
	async graphSlice(opts: GraphSliceOpts = {}): Promise<GraphSlice> {
		if (opts.q !== undefined) await this.fts?.ensureFtsFresh();
		const filter = this.nodeFilter(opts);
		if (filter === null) return { nodes: [], links: [], truncated: false };
		const maxRows = resolveLimits(opts.limits).maxRows;

		// 1) The capped node set (id + type + data, the last only to derive a label + image).
		// Reused as a subquery for the edge endpoint filter, which selects `id` back out of it.
		const nodeSub = `SELECT nv.id AS id, nv.type AS type, nv.data AS data
			FROM node_versions nv
			WHERE ${filter.where}
			ORDER BY nv.id
			LIMIT ${Math.floor(maxRows)}`;
		const nodesRes = await this.raw.execute({ sql: nodeSub, args: filter.args });
		const nodes: GraphSliceNode[] = nodesRes.rows.map((r) => {
			const type = String(r.type);
			const data = this.upcaster.apply(type, parseData(r.data)) as Record<string, unknown>;
			const node: GraphSliceNode = { id: String(r.id), type };
			const label = sliceLabel(data);
			if (label !== undefined) node.label = label;
			const image = sliceImage(data);
			if (image !== undefined) node.image = image;
			return node;
		});
		const truncated = nodes.length >= maxRows;

		if (nodes.length === 0) return { nodes, links: [], truncated };

		// 2) Edges among the node set. Live edges via the `edges` view; as-of via edge_versions.
		const idSub = `SELECT id FROM (${nodeSub})`;
		let edgeSql: string;
		const edgeArgs: (string | number)[] = [];
		if (opts.asOf !== undefined) {
			edgeSql = `SELECT ev.id AS id, ev.src AS source, ev.dst AS target, ev.rel AS rel, ev.weight AS weight
				FROM edge_versions ev
				WHERE (ev.valid_from <= ? AND ? < ev.valid_to)
					AND ev.src IN (${idSub}) AND ev.dst IN (${idSub})`;
			edgeArgs.push(opts.asOf, opts.asOf, ...filter.args, ...filter.args);
		} else {
			edgeSql = `SELECT e.id AS id, e.src AS source, e.dst AS target, e.rel AS rel, e.weight AS weight
				FROM edges e
				WHERE e.src IN (${idSub}) AND e.dst IN (${idSub})`;
			edgeArgs.push(...filter.args, ...filter.args);
		}
		const edgesRes = await this.raw.execute({ sql: edgeSql, args: edgeArgs });
		const links: GraphSliceLink[] = edgesRes.rows.map((r) => ({
			id: String(r.id),
			source: String(r.source),
			target: String(r.target),
			rel: String(r.rel),
			weight: Number(r.weight),
		}));
		return { nodes, links, truncated };
	}

	/**
	 * Run an atomic write `batch` under the §19.1 contention-retry envelope. `batch`
	 * commits in one round trip, so a `SQLITE_BUSY`/`LOCKED` (an interactive
	 * transaction() elsewhere on the shared client drops busy_timeout to 0 → BEGIN
	 * IMMEDIATE fails fast) is rolled back implicitly and retried with backoff rather
	 * than surfacing as a lost write. Other errors (constraint, etc.) propagate.
	 */
	private async runWriteBatch(label: string, run: () => Promise<unknown>): Promise<void> {
		await this.serialize(async () => {
			for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
				try {
					await run();
					return;
				} catch (e) {
					if (!isRetryableContention(e)) throw e;
				}
				await backoff(attempt);
			}
			throw new Error(`${label}: too much contention`);
		});
	}

	/**
	 * The §19.1 conditional-close + retry envelope, shared by {@link updateNode} and
	 * {@link deleteEdge}. Each attempt opens a `write` transaction (BEGIN IMMEDIATE) and
	 * runs `body`, which returns `'committed'` on success or `'superseded'` when the
	 * conditional close found `rowsAffected !== 1` (a concurrent writer already closed
	 * the live row). Superseded → roll back and retry. A thrown `SQLITE_BUSY`/`LOCKED`
	 * (genuine lock contention — the interactive tx connection never gets `busy_timeout`,
	 * so BEGIN IMMEDIATE fails fast instead of waiting) is also rolled back and retried
	 * with a jittered backoff, so N racing writers all make progress and the version
	 * chain stays contiguous and non-overlapping. Any other error propagates.
	 */
	private async runConditionalClose(
		label: string,
		body: (tx: DbTransaction, now: number) => Promise<'committed' | 'superseded'>,
	): Promise<void> {
		await this.serialize(async () => {
			for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
				let tx: DbTransaction | undefined;
				try {
					tx = await this.raw.transaction('write'); // BEGIN IMMEDIATE (may throw SQLITE_BUSY)
					const result = await body(tx, this.now());
					if (result === 'committed') return;
					if (!tx.closed) await tx.rollback(); // superseded → retry
				} catch (e) {
					// Guard: don't roll back a committed/closed tx (would throw).
					if (tx && !tx.closed) await tx.rollback();
					if (!isRetryableContention(e)) throw e; // permanent error → propagate
				}
				await backoff(attempt);
			}
			throw new Error(`${label}: too much contention`);
		});
	}

	/**
	 * Update a node via close-and-insert with the §19.1 conditional-close + retry
	 * protocol ({@link runConditionalClose}). The whole read-merge-write runs in one
	 * `write` transaction; the close is conditional (`WHERE valid_to = FOREVER`) so a
	 * concurrent writer that already superseded this row leaves `rowsAffected = 0` and we
	 * retry instead of creating overlapping intervals.
	 *
	 * Carry-forward (B4/B5): every column the patch omits is copied from the
	 * current live version — `body/uri/content_hash/content_type/type` via
	 * `patch.X ?? cur.X`, data by shallow-merge, and the `emb` BLOB by rebinding
	 * the raw `cur.emb` bytes (NEVER `vector('[]')`, which throws on a dim
	 * mismatch). A supplied `emb` binds `vector(?)`; a NULL stays NULL.
	 */
	async updateNode(
		id: string,
		patch: {
			type?: string;
			data?: Record<string, unknown>;
			emb?: number[];
			body?: string;
			uri?: string;
			content_hash?: string;
			embed_hash?: string;
			content_type?: string;
		},
	): Promise<void> {
		let event: GraphEvent | undefined;
		await this.runConditionalClose('updateNode', async (tx, rawNow) => {
			const cur = (
				await tx.execute({
					sql: `SELECT type, body, uri, content_hash, embed_hash, content_type, data, emb, valid_from
						FROM node_versions WHERE id = ? AND valid_to = ?`,
					args: [id, FOREVER],
				})
			).rows[0];
			if (!cur) throw new Error(`updateNode: no live version for '${id}'`);

			// M6 data-derived bump: the successor opens (and the predecessor closes) strictly
			// AFTER the predecessor's valid_from, so [valid_from, now) is never zero-width —
			// even when a cross-instance writer's clock ran ahead of this instance's now()
			// (the per-instance high-water mark alone can't see other instances' writes).
			const now = Math.max(rawNow, Number(cur.valid_from) + 1);
			const closed = await tx.execute({
				sql: 'UPDATE node_versions SET valid_to = ? WHERE id = ? AND valid_to = ?',
				args: [now, id, FOREVER],
			});
			// Superseded between SELECT and UPDATE -> nothing closed -> retry.
			if (closed.rowsAffected !== 1) return 'superseded';

			// P12: produce a successor that is genuinely current-shaped and honestly `_v`-stamped
			// (never "v2-tagged but v1-shaped"). The OLD version row is untouched (closed above) —
			// only this new successor moves forward (no backfill). Unregistered type ⇒ both
			// `apply` and `stamp` are identity → exactly the pre-P12 behavior.
			const successorType = patch.type ?? String(cur.type);
			const curRaw = JSON.parse(String(cur.data)) as Record<string, unknown>;
			let data: Record<string, unknown>;
			if (
				successorType !== String(cur.type) &&
				this.upcaster.stampVersion(successorType) !== undefined
			) {
				// NodeType change INTO a registered type: the live data were shaped by the OLD type's
				// chain, meaningless under the successor. Re-parse the merged result against the
				// SUCCESSOR's Zod schema (drops foreign fields, applies its defaults, throws if a
				// required successor field is missing) before stamping, so the stamp matches the shape.
				const def = (this.schema.nodes as Record<string, RawNodeDef | undefined>)[successorType];
				const reshaped = (
					def ? def.parse({ ...curRaw, ...patch.data }) : { ...curRaw, ...patch.data }
				) as Record<string, unknown>;
				data = this.upcaster.stamp(successorType, reshaped);
			} else {
				// Same-type (or unregistered successor): migrate the live data to the latest shape,
				// merge the patch, stamp.
				const merged = { ...this.upcaster.apply(String(cur.type), curRaw), ...patch.data };
				data = this.upcaster.stamp(successorType, merged);
			}
			// DuckDB has no store-level backing for declared-unique props (see
			// duck-constraints.ts); libSQL/Postgres enforce it via their partial index instead.
			// `id` is excluded so a node updated to its own current value is never rejected.
			// `tx`, not `this.raw`: this callback already holds a pooled connection, and
			// reaching for a second one here deadlocks the pool once enough writers are
			// concurrently mid-transaction (reproduced at the default poolMax of 4).
			if (dialectOf(this.raw) === 'duckdb') {
				await assertUniqueProps(tx, successorType, data, id);
			}
			// B4: carry every metadata column forward unless explicitly patched.
			// `?? null` keeps `undefined` out of the bound args (InValue rejects it).
			// Carried forward: type, body, uri, content_hash, embed_hash, content_type, data, emb.
			const common: SqlValue[] = [
				id,
				patch.type ?? (cur.type as SqlValue),
				patch.body ?? (cur.body as SqlValue) ?? null,
				patch.uri ?? (cur.uri as SqlValue) ?? null,
				patch.content_hash ?? (cur.content_hash as SqlValue) ?? null,
				patch.embed_hash ?? (cur.embed_hash as SqlValue) ?? null,
				patch.content_type ?? (cur.content_type as SqlValue) ?? null,
				JSON.stringify(data),
			];
			// B5: patch.emb -> vector(?); else rebind the raw cur.emb blob forward
			// (carries a real F32 vector, or NULL when there was none). DuckDB reads its
			// FLOAT[] column back as a genuine JS array, not the JSON-array STRING
			// embRebindExpr's from_json(?, …) expects (libSQL/Postgres rebind the driver's
			// own raw/text form directly) — embParam() re-encodes it, mirroring the
			// JSON.stringify a fresh patch.emb gets below.
			const rebindEmb: SqlValue =
				cur.emb == null
					? null
					: dialectOf(this.raw) === 'duckdb'
						? embParam(cur.emb as number[])
						: (cur.emb as SqlValue);
			const successor: SqlStatement = patch.emb
				? {
						sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, embed_hash, content_type, data, emb, valid_from)
							VALUES (?,?,?,?,?,?,?,?, ${embFreshExpr(dialectOf(this.raw))}, ?)`,
						args: [...common, JSON.stringify(patch.emb), now],
					}
				: {
						sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, embed_hash, content_type, data, emb, valid_from)
							VALUES (?,?,?,?,?,?,?,?, ${embRebindExpr(dialectOf(this.raw))}, ?)`,
						args: [...common, rebindEmb, now],
					};
			await tx.execute(successor);
			const ev: GraphEvent = {
				op: 'node.update',
				entity: 'node',
				id,
				label: successorType,
				shape: 'insert',
				ts: now,
			};
			const stmt = this.outboxStmt(ev);
			if (stmt) await tx.execute(stmt); // co-write in the same tx (Layer 2)
			await tx.commit();
			event = ev;
			return 'committed';
		});
		await this.touched('node_versions', 'graph_outbox');
		if (event) this.emit(event); // post-commit
	}

	/**
	 * Retract a node via the §19.1 conditional-close protocol ({@link runConditionalClose}):
	 * close the live version (`valid_to = now`) with NO successor — the bitemporal mirror of
	 * {@link deleteEdge}. The `nodes` view drops it (`getNode` returns null) while
	 * `history`/as-of reads still return the closed version. Conditional on
	 * `valid_to = FOREVER` so a concurrent close leaves `rowsAffected = 0` and we retry
	 * rather than racing.
	 *
	 * Scope: closes only the node version. The node's still-live incident edges are NOT
	 * cascade-closed — node-identity rows are never deleted, so the edge FKs stay valid, but
	 * the `edges` view and {@link neighbors} can still surface edges into a node `getNode` now
	 * returns null for. Callers needing referential cleanup retract those edges first (ingest
	 * reconciles outbound edges via {@link deleteEdge}).
	 */
	async deleteNode(id: string): Promise<void> {
		let event: GraphEvent | undefined;
		await this.runConditionalClose('deleteNode', async (tx, rawNow) => {
			// Widened to also read `type` so the delete event carries the node's label.
			const cur = (
				await tx.execute({
					sql: 'SELECT type, valid_from FROM node_versions WHERE id = ? AND valid_to = ?',
					args: [id, FOREVER],
				})
			).rows[0];
			if (!cur) throw new Error(`deleteNode: no live version for '${id}'`);

			// M6 data-derived bump: close strictly after the node's valid_from (no zero-width).
			const now = Math.max(rawNow, Number(cur.valid_from) + 1);
			const closed = await tx.execute({
				sql: 'UPDATE node_versions SET valid_to = ? WHERE id = ? AND valid_to = ?',
				args: [now, id, FOREVER],
			});
			if (closed.rowsAffected !== 1) return 'superseded';
			// Pure close (no successor) — the delete the valid_from CDC feed can't see.
			const ev: GraphEvent = {
				op: 'node.delete',
				entity: 'node',
				id,
				label: String(cur.type),
				shape: 'close',
				ts: now,
			};
			const stmt = this.outboxStmt(ev);
			if (stmt) await tx.execute(stmt); // co-write in the same tx (Layer 2)
			await tx.commit();
			event = ev;
			return 'committed';
		});
		await this.touched('node_versions', 'graph_outbox');
		// A retracted id no longer resolves to a live type; drop any cached entry so a later
		// endpoint-type check (or re-add of the same id) re-queries instead of trusting a stale type.
		this.typeCache.delete(id);
		if (event) this.emit(event); // post-commit
	}

	/**
	 * Delete an edge via the §19.1 conditional-close protocol ({@link runConditionalClose}):
	 * close the live version (`valid_to = now`) with NO successor. Conditional on
	 * `valid_to = FOREVER` so a concurrent close leaves `rowsAffected = 0` and we retry
	 * rather than racing.
	 */
	async deleteEdge(id: string): Promise<void> {
		let event: GraphEvent | undefined;
		await this.runConditionalClose('deleteEdge', async (tx, rawNow) => {
			// Widened to read the endpoints/rel so the delete event carries src/dst/label — a
			// consumer invalidates the neighbor caches exactly as the React useDeleteEdge does.
			const cur = (
				await tx.execute({
					sql: 'SELECT src, dst, rel, valid_from FROM edge_versions WHERE id = ? AND valid_to = ?',
					args: [id, FOREVER],
				})
			).rows[0];
			if (!cur) throw new Error(`deleteEdge: no live version for '${id}'`);

			// M6 data-derived bump: close strictly after the edge's valid_from (no zero-width).
			const now = Math.max(rawNow, Number(cur.valid_from) + 1);
			const closed = await tx.execute({
				sql: 'UPDATE edge_versions SET valid_to = ? WHERE id = ? AND valid_to = ?',
				args: [now, id, FOREVER],
			});
			if (closed.rowsAffected !== 1) return 'superseded';
			// Pure close (no successor) — the delete the valid_from CDC feed can't see.
			const ev: GraphEvent = {
				op: 'edge.delete',
				entity: 'edge',
				id,
				label: String(cur.rel),
				shape: 'close',
				ts: now,
				src: String(cur.src),
				dst: String(cur.dst),
			};
			const stmt = this.outboxStmt(ev);
			if (stmt) await tx.execute(stmt); // co-write in the same tx (Layer 2)
			await tx.commit();
			event = ev;
			return 'committed';
		});
		await this.touched('edge_versions', 'graph_outbox');
		if (event) this.emit(event); // post-commit
	}

	/** Resolve a node's live type, caching it (used by endpoint-type checks). */
	private async typeOf(id: string): Promise<string | null> {
		const cached = this.typeCache.get(id);
		if (cached !== undefined) return cached;
		const r = await this.raw.execute({ sql: 'SELECT type FROM nodes WHERE id = ?', args: [id] });
		const row = r.rows[0];
		if (!row) return null;
		const type = String(row.type);
		this.typeCache.set(id, type);
		return type;
	}

	/**
	 * Reshape a `{ id, type, data }` row from a view into the typed node shape, applying
	 * the P12 read-time upcaster (§15): stored data are migrated from their `_v` to the
	 * latest shape and Zod-parsed. Empty registry ⇒ identity (raw JSON, pre-P12).
	 */
	private rowToNode(row: SqlRow): AnyNode<S> {
		const type = String(row.type);
		this.typeCache.set(String(row.id), type);
		return {
			id: String(row.id),
			type,
			data: this.upcaster.apply(type, JSON.parse(String(row.data)) as Record<string, unknown>),
		} as AnyNode<S>;
	}
}

/** Convenience: pair a raw client with a schema. (P11 wires the per-project factory.) */
export function graphFor<S extends GraphSchema>(
	raw: DbClient,
	schema: S,
	upcasters?: UpcasterRegistry,
	events?: GraphEventOptions,
): Graph<S> {
	return new Graph(raw, schema, upcasters, events);
}

export { FOREVER };
