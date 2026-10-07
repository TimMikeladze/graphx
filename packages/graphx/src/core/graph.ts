import { sleep } from './runtime.ts';
import {
	type DbClient,
	type DbTransaction,
	dialectOf,
	type SqlRow,
	type SqlStatement,
	type SqlValue,
} from './dialect.ts';
import { distinctSelect, embValueExpr, ftsWhere } from './dialect-sql.ts';
import { ftsArg, hybridRetrieve, type HybridRetrieveOpts } from './hybrid.ts';
import {
	assertVector,
	chunkPolicyFor,
	chunksFor,
	embedHash,
	embedInputFor,
	type Embedder,
	EmbeddingError,
	type EmbeddingPolicy,
	type PreparedEmbedding,
} from './embedder.ts';
import { retrieve, type RetrievedNode, type RetrieveOpts } from './retrieve.ts';
import {
	type EmbeddingMeta,
	embeddingsIndexFor,
	ensureEmbeddings,
	readEmbeddingMeta,
} from './schema.ts';
import { newId } from './ids.ts';
import type { z } from 'zod';
import {
	FOREVER,
	type FtsIndexOwner,
	ftsIndexOwner,
	type ManagedWriter,
	managedWriter,
} from './runtime.ts';
import { assertUniqueProps } from './duck-constraints.ts';
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
import { createLocalBlobStore, type LocalBlobStore } from './local-blobs.ts';
import { createAtomicSession } from './atomic-session.ts';
import { fork, type ForkOpts } from './fork.ts';

/**
 * P3 — data layer (§6). The temporal store front: ULID identity, close-and-insert
 * versioning, current reads through the live-only `nodes`/`edges` views (D3).
 *
 * `S` is the `defineGraphSchema(...)` value (P2). The constructor takes the raw
 * libSQL `Client` (PUBLIC — P4/P6/P7 read `graph.raw` directly) and that schema.
 */

/** Loosened schema shape; the `defineGraphSchema` types ride on `S` at call sites. */
export type GraphSchema = {
	nodes: Record<string, unknown>;
	edges: Record<string, unknown>;
	/** Per-type embedding policies (`defineGraphSchema({ embedding })`). Absent ⇒ embed `body`. */
	embedding?: Record<string, EmbeddingPolicy<never> | undefined>;
};

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

/**
 * Input to {@link Graph.addNode}. `data` is the unparsed prop object for the type.
 *
 * Embedding is automatic when the graph has an embedder: the type's embedding input (its `body`
 * by default) is embedded and stored. Two escape hatches: `emb` binds a precomputed vector
 * (validated against the namespace width), and `embedding` binds rows prepared by
 * {@link Graph.prepareEmbeddings} — or `false` to skip embedding this node.
 */
export interface AddNodeInput<S extends GraphSchema, K extends NodeType<S>> {
	type: K;
	data: DataInput<S, K>;
	emb?: number[];
	embedding?: PreparedEmbedding | false;
	body?: string;
	uri?: string;
	content_hash?: string;
	content_type?: string;
}

/** Patch for {@link Graph.updateNode}. Omitted fields carry forward; null clears content. */
export interface UpdateNodePatch {
	type?: string;
	data?: Record<string, unknown>;
	/** Bind a precomputed vector for the successor (validated). */
	emb?: number[];
	/** Prepared rows for the successor, or `false` to leave the stored vectors untouched. */
	embedding?: PreparedEmbedding | false;
	body?: string | null;
	uri?: string | null;
	content_hash?: string | null;
	content_type?: string | null;
}

/** How a {@link Graph} embeds on write. */
export type EmbeddingMode = 'sync' | 'lazy' | 'off';

/** Construction options for {@link Graph}. */
export interface GraphOptions {
	/** P12 read-time upcasters (§15). */
	upcasters?: UpcasterRegistry;
	/** Typed mutation events (+ optional durable outbox). */
	events?: GraphEventOptions;
	/** The namespace's embedder. Without it, writes store no vectors and `retrieve` throws. */
	embedder?: Embedder;
	/**
	 * `'sync'` (default) embeds inside the write. `'lazy'` writes no vector and leaves it to an
	 * {@link import('./triggers.ts').embedTrigger} over the outbox. `'off'` never embeds
	 * automatically (explicit `emb` / `embedding` still work).
	 */
	embedding?: EmbeddingMode;
}

/** One live node's embedding input, for {@link Graph.prepareEmbeddings}. */
export interface EmbedItem {
	type: string;
	data: Record<string, unknown>;
	body?: string | null;
}

/** What {@link Graph.reembed} did. */
export interface ReembedResult {
	/** Live nodes visited. */
	nodes: number;
	/** Nodes that received vectors. */
	embedded: number;
	/** Nodes whose policy yields no text (left without vectors). */
	skipped: number;
}

/** Namespace embedding health, from {@link Graph.embeddingReport}. */
export interface EmbeddingReport {
	/** The model + width recorded in the namespace, or `null` when never initialised with one. */
	stored: EmbeddingMeta | null;
	/** The graph's configured embedder, or `null`. */
	configured: { model: string; dim: number | undefined } | null;
	liveNodes: number;
	/** Live nodes that have at least one vector. */
	embedded: number;
	/** Live nodes whose policy yields text but that have no vector. */
	unembedded: number;
	/** Live nodes whose stored vector was computed from different text or a different model. */
	stale: number;
	/** Vector rows (chunks) in the table. */
	vectors: number;
}

/** Per registered type: live nodes, and those still stored below the upcaster's `current`. */
export type UpcastReport = Record<string, { current: number; live: number; behind: number }>;

/** What {@link Graph.upcastAll} did. */
export interface UpcastAllResult {
	/** Live nodes of the selected types that were read. */
	scanned: number;
	/** Nodes rewritten (or, on a dry run, that would be) as a new version at `current`. */
	upcast: number;
}

/**
 * Thrown from inside the conditional-close body when the successor needs a vector the caller
 * has not computed yet. The transaction rolls back, {@link Graph.updateNode} embeds OUTSIDE the
 * write lock, then retries with the vector in hand.
 */
class NeedEmbed extends Error {
	constructor(
		readonly type: string,
		readonly text: string,
		readonly hash: string,
	) {
		super('need embed');
	}
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

/** One consistent node snapshot. Revision identifies its immutable version row. */
export type NodeVersion<S extends GraphSchema> = AnyNode<S> & NodeContent & { revision: string };

export interface AtomicUpdateOptions {
	expectedRevision: string;
	/** Replace metadata completely; otherwise shallow-merge with the current version. */
	replaceData?: boolean;
}

/** The requested immutable predecessor is no longer the live version. */
export class RevisionConflict extends Error {
	constructor(
		readonly id: string,
		readonly expectedRevision: string,
		readonly actualRevision: string | null,
	) {
		super(`Node '${id}' no longer has revision '${expectedRevision}'`);
		this.name = 'RevisionConflict';
	}
}

/** A lexical-only, borrowed writer. Methods have no independent commit or retry. */
export interface AtomicGraph<S extends GraphSchema> {
	getNodeVersion(id: string): Promise<NodeVersion<S> | null>;
	listNodes(opts?: NodeListOpts): Promise<NodeListPage<S>>;
	listNodeVersions(opts?: NodeListOpts): Promise<NodeVersionPage<S>>;
	graphSlice(opts?: GraphSliceOpts): Promise<GraphSlice>;
	/** Read live edges, optionally restricted to an author's exact provenance. */
	listEdges(opts?: {
		src?: string;
		dst?: string;
		rel?: string;
		source?: string;
	}): Promise<Array<EdgeRef & { source: string | null }>>;
	addNode<K extends NodeType<S>>(
		input: Omit<AddNodeInput<S, K>, 'emb' | 'embedding'>,
	): Promise<NodeVersion<S>>;
	updateNode(
		id: string,
		patch: Omit<UpdateNodePatch, 'emb' | 'embedding'>,
		options: AtomicUpdateOptions,
	): Promise<NodeVersion<S>>;
	addEdge<R extends Rel<S>>(input: AddEdgeInput<S, R>): Promise<EdgeRef>;
	deleteEdge(id: string): Promise<void>;
	purgeNode(id: string, options: Pick<AtomicUpdateOptions, 'expectedRevision'>): Promise<void>;
	readonly blobs: Pick<LocalBlobStore, 'put' | 'get' | 'gc'>;
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

/** One page of {@link Graph.listNodeVersions}: complete versions + the cursor for the next page. */
export interface NodeVersionPage<S extends GraphSchema> {
	nodes: NodeVersion<S>[];
	/** `null` when this is the last page. */
	nextCursor: string | null;
}

/** Filters + keyset pagination for {@link Graph.listEdges}. */
export interface EdgeListOpts {
	rel?: string;
	src?: string;
	dst?: string;
	/** Only edges written with this provenance tag (e.g. `jev`, `ingest:<source>:`). */
	source?: string;
	/** As-of epoch ms. Omit ⇒ live edges. */
	asOf?: number;
	/** Page size; clamped to `maxRows`. */
	limit?: number;
	/** Opaque cursor from a prior page's `nextCursor`. */
	cursor?: string;
	limits?: Partial<QueryLimits>;
}

/** One edge as {@link Graph.listEdges} returns it — everything but its interval. */
export interface EdgeRecord {
	id: string;
	rel: string;
	src: string;
	dst: string;
	weight: number;
	data: Record<string, unknown>;
	/** Provenance tag, or `null` for an untagged write. */
	source: string | null;
}

/** One page of {@link Graph.listEdges}. */
export interface EdgeListPage {
	edges: EdgeRecord[];
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
	/** Set only on the private view created by atomic(); never exposed to callers. */
	private atomicTransaction?: DbTransaction;
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
	/** The namespace's embedder, when the graph was built with one. */
	readonly embedder: Embedder | undefined;
	/** How writes embed. See {@link GraphOptions.embedding}. */
	readonly embeddingMode: EmbeddingMode;
	/** Cached `graph_meta` model/width; `undefined` until first read. */
	private embMeta?: EmbeddingMeta | null;
	/** Retained so {@link withEventSource} can build a sibling with the same options. */
	private readonly options: GraphOptions;

	constructor(
		public raw: DbClient,
		public schema: S,
		opts: GraphOptions = {},
	) {
		this.options = opts;
		this.upcasters = opts.upcasters ?? {};
		this.upcaster = new Upcaster(schema, this.upcasters);
		this.events = opts.events?.sink ?? NOOP_EVENTS;
		this.outbox = opts.events?.outbox ?? false;
		this.eventSource = opts.events?.source;
		this.eventOpts = opts.events;
		this.writer = managedWriter(raw);
		this.fts = ftsIndexOwner(raw);
		this.embedder = opts.embedder;
		this.embeddingMode = opts.embedding ?? 'sync';
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
	 * Commit one SQLite/libSQL callback atomically, without replaying it. Use only
	 * the passed scope for database work inside fn: root-client operations wait for
	 * this lease. Any failed scoped operation aborts the transaction even if caught;
	 * escaped scopes reject after the callback ends. Events publish after commit.
	 *
	 * This initial scope is lexical-only: configured/stored embeddings are rejected
	 * before acquisition and the namespace is checked again under the writer lease.
	 * Blob schema initialization also happens before acquisition.
	 */
	async atomic<T>(fn: (scope: AtomicGraph<S>) => Promise<T>): Promise<T> {
		const dialect = dialectOf(this.raw);
		if (dialect !== 'sqlite' && dialect !== 'libsql')
			throw new Error(`Graph.atomic does not support ${dialect}`);
		if (this.embedder || (await readEmbeddingMeta(this.raw)))
			throw new Error('Graph.atomic requires a namespace without embeddings');
		let blobs: LocalBlobStore | undefined;
		let acquired: DbTransaction | undefined;
		// Only acquisition/idempotent initialization may retry. fn is never replayed.
		for (let attempt = 0; attempt < WRITE_MAX_RETRIES; attempt++) {
			try {
				blobs = await createLocalBlobStore(this.raw);
				acquired = await this.raw.transaction('write');
				break;
			} catch (error) {
				if (!isRetryableContention(error)) throw error;
				await backoff(attempt);
			}
		}
		if (!acquired || !blobs) throw new Error('Graph.atomic: too much contention');
		const tx = acquired;
		const session = createAtomicSession(tx, dialect);
		const events: GraphEvent[] = [];
		let result: T;
		try {
			const inner = new Graph(session.client, this.schema, {
				...this.options,
				embedder: undefined,
				embedding: 'off',
				events: { ...this.eventOpts, sink: { emit: (event) => events.push(event) } },
			});
			inner.atomicTransaction = tx;
			inner.lastTs = this.lastTs;
			inner.embMeta = null;
			const boundBlobs = blobs.inTransaction(tx);
			const scope: AtomicGraph<S> = {
				getNodeVersion: (id) => session.run(() => inner.getNodeVersion(id)),
				listNodes: (opts) => session.run(() => inner.listNodes(opts)),
				listNodeVersions: (opts) => session.run(() => inner.listNodeVersions(opts)),
				graphSlice: (opts) => session.run(() => inner.graphSlice(opts)),
				listEdges: (opts = {}) =>
					session.run(async () => {
						const where = ['valid_to = ?'];
						const args: SqlValue[] = [FOREVER];
						for (const key of ['src', 'dst', 'rel', 'source'] as const) {
							if (opts[key] !== undefined) {
								where.push(`${key} = ?`);
								args.push(opts[key]);
							}
						}
						const result = await session.client.execute({
							sql: `SELECT id, rel, src, dst, source FROM edge_versions WHERE ${where.join(' AND ')} ORDER BY id`,
							args,
						});
						return result.rows.map((row) => ({
							id: String(row.id),
							rel: String(row.rel),
							src: String(row.src),
							dst: String(row.dst),
							source: row.source == null ? null : String(row.source),
						}));
					}),
				addNode: (input) =>
					session.run(async () => {
						const node = await inner.addNode(input);
						return (await inner.getNodeVersion(node.id))!;
					}),
				updateNode: (id, patch, options) =>
					session.run(async () => {
						const current = await inner.getNodeVersion(id);
						if (!current || current.revision !== options.expectedRevision)
							throw new RevisionConflict(id, options.expectedRevision, current?.revision ?? null);
						const type = patch.type ?? current.type;
						const def = (this.schema.nodes as Record<string, RawNodeDef | undefined>)[type];
						if (!def) throw new Error(`updateNode: unknown type '${type}'`);
						const data = def.parse(
							options.replaceData
								? (patch.data ?? {})
								: { ...(current.data as Record<string, unknown>), ...patch.data },
						) as Record<string, unknown>;
						await inner.updateNodeOnce(id, { ...patch, data }, undefined, {
							...options,
							replaceData: true,
						});
						inner.typeCache.delete(id);
						return (await inner.getNodeVersion(id))!;
					}),
				addEdge: (input) => session.run(() => inner.addEdge(input)),
				deleteEdge: (id) => session.run(() => inner.deleteEdge(id)),
				purgeNode: (id, options) =>
					session.run(() => inner.purgeNodeInTransaction(id, options.expectedRevision)),
				blobs: {
					put: (input) => {
						let copy: Uint8Array;
						try {
							copy = new Uint8Array(input);
						} catch (error) {
							return session.run(() => Promise.reject(error));
						}
						return session.run(() => boundBlobs.put(copy));
					},
					get: (uri) => session.run(() => boundBlobs.get(uri)),
					gc: () => session.run(() => boundBlobs.gc()),
				},
			};
			// Schema/model initialization could have raced the pre-acquisition check.
			if (await readEmbeddingMeta(session.client))
				throw new Error('Graph.atomic requires a namespace without embeddings');
			result = await fn(scope);
			await session.finish();
			await tx.commit();
			this.lastTs = Math.max(this.lastTs, inner.lastTs);
		} catch (error) {
			await session.finish().catch(() => {});
			if (!tx.closed) {
				try {
					await tx.rollback();
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						'Atomic graph operation and rollback failed',
					);
				}
			}
			throw error;
		}
		this.typeCache.clear();
		for (const event of events) this.emit(event);
		return result;
	}

	/** Hard deletion is confined to the atomic scope so references and GC can join it. */
	private async purgeNodeInTransaction(id: string, expectedRevision: string): Promise<void> {
		if (!this.atomicTransaction) throw new Error('Purge requires an atomic graph scope');
		const current = await this.getNodeVersion(id);
		if (!current || current.revision !== expectedRevision)
			throw new RevisionConflict(id, expectedRevision, current?.revision ?? null);
		const incident = await this.raw.execute({
			sql: 'SELECT DISTINCT id FROM edge_versions WHERE src = ? OR dst = ?',
			args: [id, id],
		});
		for (const edge of incident.rows) {
			const edgeId = String(edge.id);
			const live = await this.raw.execute({
				sql: 'SELECT id FROM edges WHERE id = ?',
				args: [edgeId],
			});
			if (live.rows.length) await this.deleteEdge(edgeId);
			await this.raw.execute({ sql: 'DELETE FROM edge_versions WHERE id = ?', args: [edgeId] });
			await this.raw.execute({ sql: 'DELETE FROM edge_identity WHERE id = ?', args: [edgeId] });
		}
		await this.deleteNode(id);
		// External-content FTS must receive the old text before its content row goes.
		await this.raw.execute({
			sql: "INSERT INTO nodes_fts (nodes_fts, rowid, body) SELECT 'delete', ver, body FROM node_versions WHERE id = ?",
			args: [id],
		});
		const vectors = await this.raw.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_embeddings'",
		);
		if (vectors.rows.length)
			await this.raw.execute({ sql: 'DELETE FROM node_embeddings WHERE id = ?', args: [id] });
		await this.raw.execute({ sql: 'DELETE FROM node_analytics WHERE id = ?', args: [id] });
		await this.raw.execute({ sql: 'DELETE FROM node_scores WHERE id = ?', args: [id] });
		await this.raw.execute({ sql: 'DELETE FROM node_versions WHERE id = ?', args: [id] });
		await this.raw.execute({ sql: 'DELETE FROM node_identity WHERE id = ?', args: [id] });
	}

	private async commitMutation(tx: DbTransaction): Promise<void> {
		if (!this.atomicTransaction) await tx.commit();
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
		return new Graph(this.raw, this.schema, {
			...this.options,
			events: { ...this.eventOpts, source },
		});
	}

	/**
	 * Branch this graph into `target` — an empty namespace, on this backend or another — and
	 * return a `Graph` over it with the same schema and options. From here the two diverge:
	 * nothing written to one is visible in the other. With `asOf`, the branch is the graph as
	 * it stood at that instant. Nodes the cut leaves without a valid vector are re-embedded
	 * when this graph has an embedder. See {@link fork} for exactly what is copied.
	 */
	async fork(target: DbClient, opts: ForkOpts = {}): Promise<Graph<S>> {
		const result = await fork(this.raw, target, opts);
		const branch = new Graph(target, this.schema, this.options);
		if (this.embedder && this.embeddingMode !== 'off') {
			for (const id of result.needsEmbedding) await branch.embedNode(id);
		}
		return branch;
	}

	// ------------------------------------------------------------------------------------------
	// Embeddings
	// ------------------------------------------------------------------------------------------

	/** The model + width this namespace is embedded at (cached), or `null`. */
	private async embeddingMeta(): Promise<EmbeddingMeta | null> {
		if (this.embMeta === undefined) this.embMeta = await readEmbeddingMeta(this.raw);
		return this.embMeta;
	}

	/** The width every stored vector must have. Throws `missing` when the namespace has none. */
	private async requireDim(context: string): Promise<number> {
		const meta = await this.embeddingMeta();
		if (!meta) {
			throw new EmbeddingError(
				'missing',
				`${context}: this namespace has no embedding table — call init(db, embedder) first`,
			);
		}
		if (this.embedder && this.embedder.id !== meta.model) {
			throw new EmbeddingError(
				'model',
				`${context}: this namespace is embedded with '${meta.model}' but the graph's embedder is '${this.embedder.id}' — run reembed to switch models`,
			);
		}
		return meta.dim;
	}

	/** The embedder, or a `missing` error naming what needed it. */
	private requireEmbedder(context: string): Embedder {
		if (!this.embedder) {
			throw new EmbeddingError(
				'missing',
				`${context}: no embedder configured — construct the Graph with { embedder }`,
			);
		}
		return this.embedder;
	}

	/** The text a node of `type` is embedded from, per the schema's policy. */
	embedInput(
		type: string,
		data: Record<string, unknown>,
		body: string | null | undefined,
	): string | null {
		return embedInputFor(this.schema, type, data, body);
	}

	/** The staleness hash a node's vectors would carry under the configured embedder. */
	embedHashFor(
		type: string,
		data: Record<string, unknown>,
		body: string | null | undefined,
	): string | null {
		const text = this.embedInput(type, data, body);
		return text === null ? null : embedHash(this.requireEmbedder('embedHashFor').id, text);
	}

	/**
	 * Batch-embed several nodes' inputs in one pass through the embedder — the path for ingest
	 * and other bulk writers. Returns one {@link PreparedEmbedding} per item (`null` when the
	 * item's policy yields no text), to be passed as `embedding` to `addNode` / `updateNode`.
	 */
	async prepareEmbeddings(items: EmbedItem[]): Promise<(PreparedEmbedding | null)[]> {
		const embedder = this.requireEmbedder('prepareEmbeddings');
		const dim = await this.requireDim('prepareEmbeddings');
		// Every chunk of every item, flattened, with a back-pointer so the vectors re-assemble.
		const inputs: string[] = [];
		const plan: Array<{ item: number; chunk: number; text: string | null; hash: string } | null> =
			[];
		const perItem: Array<{ hash: string; texts: string[] } | null> = items.map((it, i) => {
			const text = this.embedInput(it.type, it.data, it.body);
			if (text === null) return null;
			const texts = chunksFor(text, chunkPolicyFor(this.schema, it.type));
			const hash = embedHash(embedder.id, text);
			texts.forEach((t, c) => {
				inputs.push(t);
				plan.push({ item: i, chunk: c, text: texts.length === 1 ? null : t, hash });
			});
			return { hash, texts };
		});
		const vectors = await embedder.embed(inputs);
		const out: (PreparedEmbedding | null)[] = perItem.map((p) =>
			p ? { hash: p.hash, chunks: [] } : null,
		);
		plan.forEach((entry, i) => {
			if (!entry) return;
			const vec = vectors[i] as number[];
			assertVector(vec, dim, 'prepareEmbeddings');
			(out[entry.item] as PreparedEmbedding).chunks.push({
				chunk: entry.chunk,
				text: entry.text,
				emb: vec,
			});
		});
		return out;
	}

	/** Embed one node's input text under the configured embedder (used by the update retry). */
	private async prepareFromText(type: string, text: string): Promise<PreparedEmbedding> {
		const embedder = this.requireEmbedder('embed');
		const dim = await this.requireDim('embed');
		const texts = chunksFor(text, chunkPolicyFor(this.schema, type));
		const vectors = await embedder.embed(texts);
		return {
			hash: embedHash(embedder.id, text),
			chunks: texts.map((t, c) => {
				const emb = vectors[c] as number[];
				assertVector(emb, dim, 'embed');
				return { chunk: c, text: texts.length === 1 ? null : t, emb };
			}),
		};
	}

	/** Wrap a caller-supplied raw vector as one prepared row, validated against the namespace. */
	private async fromRawVector(
		type: string,
		data: Record<string, unknown>,
		body: string | null | undefined,
		emb: number[],
	): Promise<PreparedEmbedding> {
		const dim = await this.requireDim('emb');
		assertVector(emb, dim, 'emb');
		const text = this.embedInput(type, data, body) ?? '';
		const model = this.embedder?.id ?? (await this.embeddingMeta())?.model ?? 'unknown';
		return { hash: embedHash(model, text), chunks: [{ chunk: 0, text: null, emb }] };
	}

	/**
	 * Decide a NEW node's vectors from its input: an explicit `embedding` / `emb` wins; otherwise
	 * embed synchronously when the graph has an embedder in `'sync'` mode; otherwise nothing.
	 */
	private async resolveNewEmbedding(
		type: string,
		data: Record<string, unknown>,
		body: string | null | undefined,
		input: { emb?: number[]; embedding?: PreparedEmbedding | false },
	): Promise<PreparedEmbedding | null> {
		if (input.embedding === false) return null;
		if (input.embedding) {
			const dim = await this.requireDim('embedding');
			for (const c of input.embedding.chunks) assertVector(c.emb, dim, 'embedding');
			return input.embedding;
		}
		if (input.emb) return this.fromRawVector(type, data, body, input.emb);
		if (!this.embedder || this.embeddingMode !== 'sync') return null;
		const text = this.embedInput(type, data, body);
		return text === null ? null : this.prepareFromText(type, text);
	}

	/** The statements that replace a node's vector rows with `prepared` (or remove them). */
	private embeddingStmts(id: string, prepared: PreparedEmbedding | null): SqlStatement[] {
		const stmts: SqlStatement[] = [{ sql: 'DELETE FROM node_embeddings WHERE id = ?', args: [id] }];
		if (!prepared) return stmts;
		const expr = embValueExpr(dialectOf(this.raw));
		for (const c of prepared.chunks) {
			stmts.push({
				sql: `INSERT INTO node_embeddings (id, chunk, text, emb, embed_hash) VALUES (?,?,?,${expr},?)`,
				args: [id, c.chunk, c.text, JSON.stringify(c.emb), prepared.hash],
			});
		}
		return stmts;
	}

	/** The staleness hashes stored for `ids` (chunk 0), keyed by id. Ids without vectors are absent. */
	async embeddingHashes(ids: string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		if ((await this.embeddingMeta()) === null) return out;
		for (let i = 0; i < ids.length; i += 400) {
			const part = ids.slice(i, i + 400);
			const r = await this.raw.execute({
				sql: `SELECT id, embed_hash FROM node_embeddings WHERE chunk = 0 AND id IN (${part.map(() => '?').join(',')})`,
				args: part,
			});
			for (const row of r.rows) out.set(String(row.id), String(row.embed_hash));
		}
		return out;
	}

	/**
	 * (Re)embed one live node from its current input. The path a lazy-mode trigger and
	 * {@link reembed} take. Returns `false` when the node is not live or its policy yields no
	 * text (any stored vectors are removed in that case).
	 */
	async embedNode(id: string): Promise<boolean> {
		const cur = (
			await this.raw.execute({ sql: 'SELECT type, data, body FROM nodes WHERE id = ?', args: [id] })
		).rows[0];
		if (!cur) return false;
		const type = String(cur.type);
		const data = this.upcaster.apply(type, JSON.parse(String(cur.data)) as Record<string, unknown>);
		const text = this.embedInput(type, data, cur.body as string | null);
		const prepared = text === null ? null : await this.prepareFromText(type, text);
		await this.runWriteBatch('embedNode', () =>
			this.raw.batch(this.embeddingStmts(id, prepared), 'write'),
		);
		await this.touched('node_embeddings');
		return prepared !== null;
	}

	/**
	 * Re-embed every live node under the configured embedder. When the namespace was embedded
	 * with a different model (or width), the stored vectors are dropped and the table is
	 * recreated for the new one first — this is how a model switch happens. Runs in pages so a
	 * large graph never loads into memory at once; `onProgress` fires after each page.
	 */
	async reembed(
		opts: { pageSize?: number; onProgress?: (done: number) => void } = {},
	): Promise<ReembedResult> {
		const embedder = this.requireEmbedder('reembed');
		const pageSize = Math.max(1, opts.pageSize ?? 200);
		this.embMeta = await ensureEmbeddings(this.raw, embedder, { replace: true });
		const d = dialectOf(this.raw);
		const result: ReembedResult = { nodes: 0, embedded: 0, skipped: 0 };
		// libSQL: defer the DiskANN index across the whole pass — its build is superlinear and
		// per-row inserts would pay it repeatedly.
		if (d === 'libsql') await this.raw.execute('DROP INDEX IF EXISTS ne_emb_idx');
		try {
			let after = '';
			for (;;) {
				const page = await this.raw.execute({
					sql: 'SELECT id, type, data, body FROM nodes WHERE id > ? ORDER BY id LIMIT ?',
					args: [after, pageSize],
				});
				if (page.rows.length === 0) break;
				const items: EmbedItem[] = page.rows.map((r) => ({
					type: String(r.type),
					data: this.upcaster.apply(
						String(r.type),
						JSON.parse(String(r.data)) as Record<string, unknown>,
					),
					body: (r.body as string | null) ?? null,
				}));
				const prepared = await this.prepareEmbeddings(items);
				const stmts: SqlStatement[] = [];
				page.rows.forEach((r, i) => {
					const p = prepared[i] ?? null;
					stmts.push(...this.embeddingStmts(String(r.id), p));
					result.nodes++;
					if (p) result.embedded++;
					else result.skipped++;
				});
				await this.runWriteBatch('reembed', () => this.raw.batch(stmts, 'write'));
				after = String(page.rows[page.rows.length - 1]?.id);
				opts.onProgress?.(result.nodes);
				if (page.rows.length < pageSize) break;
			}
		} finally {
			if (d === 'libsql') await this.raw.execute(embeddingsIndexFor(this.raw));
		}
		await this.touched('node_embeddings', 'graph_meta');
		return result;
	}

	/** Namespace embedding health: model, counts, and how many live nodes are stale. */
	async embeddingReport(): Promise<EmbeddingReport> {
		const stored = await readEmbeddingMeta(this.raw);
		this.embMeta = stored;
		const one = async (sql: string): Promise<number> =>
			Number((await this.raw.execute(sql)).rows[0]?.n ?? 0);
		const liveNodes = await one('SELECT count(*) AS n FROM nodes');
		const report: EmbeddingReport = {
			stored,
			configured: this.embedder ? { model: this.embedder.id, dim: this.embedder.dim } : null,
			liveNodes,
			embedded: 0,
			unembedded: 0,
			stale: 0,
			vectors: 0,
		};
		if (!stored) {
			report.unembedded = liveNodes;
			return report;
		}
		report.vectors = await one('SELECT count(*) AS n FROM node_embeddings');
		report.embedded = await one('SELECT count(DISTINCT id) AS n FROM node_embeddings');
		// Staleness needs the policy text per node, so page through the live set once.
		const model = this.embedder?.id ?? stored.model;
		let after = '';
		for (;;) {
			const page = await this.raw.execute({
				sql: 'SELECT id, type, data, body FROM nodes WHERE id > ? ORDER BY id LIMIT 500',
				args: [after],
			});
			if (page.rows.length === 0) break;
			const hashes = await this.embeddingHashes(page.rows.map((r) => String(r.id)));
			for (const r of page.rows) {
				const type = String(r.type);
				const text = this.embedInput(
					type,
					this.upcaster.apply(type, JSON.parse(String(r.data)) as Record<string, unknown>),
					(r.body as string | null) ?? null,
				);
				const stored = hashes.get(String(r.id));
				if (text === null) continue;
				if (stored === undefined) report.unembedded++;
				else if (stored !== embedHash(model, text)) report.stale++;
			}
			after = String(page.rows[page.rows.length - 1]?.id);
			if (page.rows.length < 500) break;
		}
		return report;
	}

	/**
	 * Page the live nodes of `types` (registered with an upcaster) in id order, yielding each
	 * page's rows with their stored data — not upcast.
	 */
	private async *liveNodePages(
		types: string[],
		pageSize: number,
	): AsyncGenerator<Array<{ id: string; type: string; data: Record<string, unknown> }>> {
		if (types.length === 0) return;
		const marks = types.map(() => '?').join(', ');
		let after = '';
		for (;;) {
			const page = await this.raw.execute({
				sql: `SELECT id, type, data FROM nodes WHERE type IN (${marks}) AND id > ? ORDER BY id LIMIT ?`,
				args: [...types, after, pageSize],
			});
			if (page.rows.length === 0) return;
			yield page.rows.map((r) => ({
				id: String(r.id),
				type: String(r.type),
				data: parseData(r.data),
			}));
			after = String(page.rows[page.rows.length - 1]?.id);
			if (page.rows.length < pageSize) return;
		}
	}

	/**
	 * How far stored data lag the upcasters: per registered type, live nodes and those still
	 * stored below `current`. Reads see the latest shape either way, but SQL filters
	 * (`where`, unique props) match the stored JSON, so a lagging node can be missed by them.
	 */
	async upcastReport(): Promise<UpcastReport> {
		const report: UpcastReport = {};
		for (const type of this.upcaster.types()) {
			report[type] = { current: this.upcaster.stampVersion(type) as number, live: 0, behind: 0 };
		}
		for await (const page of this.liveNodePages(this.upcaster.types(), 500)) {
			for (const n of page) {
				const r = report[n.type] as UpcastReport[string];
				r.live++;
				if (this.upcaster.isBehind(n.type, n.data)) r.behind++;
			}
		}
		return report;
	}

	/**
	 * Rewrite every live node stored below its upcaster's `current` as a new version in the
	 * latest shape, so SQL filters see the same data reads do. Each rewrite is an ordinary
	 * {@link updateNode}: history keeps the old version, an outbox event is written, and the
	 * node is re-embedded only if its embedding input changed. Idempotent; resumable.
	 */
	async upcastAll(
		opts: {
			type?: string;
			pageSize?: number;
			dryRun?: boolean;
			onProgress?: (done: UpcastAllResult) => void;
		} = {},
	): Promise<UpcastAllResult> {
		if (opts.type !== undefined && this.upcaster.stampVersion(opts.type) === undefined) {
			throw new Error(`upcastAll: type '${opts.type}' has no upcaster`);
		}
		const types = opts.type === undefined ? this.upcaster.types() : [opts.type];
		const result: UpcastAllResult = { scanned: 0, upcast: 0 };
		for await (const page of this.liveNodePages(types, Math.max(1, opts.pageSize ?? 200))) {
			for (const n of page) {
				result.scanned++;
				if (!this.upcaster.isBehind(n.type, n.data)) continue;
				// An empty patch: updateNode upcasts the live data and stamps `current`.
				if (!opts.dryRun) await this.updateNode(n.id, { data: {} });
				result.upcast++;
			}
			opts.onProgress?.({ ...result });
		}
		return result;
	}

	/** GraphRAG retrieve through this graph's embedder and upcasters. See {@link retrieve}. */
	retrieve(opts: RetrieveOpts): Promise<RetrievedNode<S>[]> {
		return retrieve(this.raw, this.requireEmbedder('retrieve'), {
			...opts,
			upcast: (type, data) => this.upcaster.apply(type, data),
		});
	}

	/** Hybrid retrieve (ANN + FTS → RRF → walk → MMR) through this graph. See {@link hybridRetrieve}. */
	hybridRetrieve(opts: HybridRetrieveOpts): Promise<RetrievedNode<S>[]> {
		return hybridRetrieve(this.raw, this.requireEmbedder('hybridRetrieve'), {
			...opts,
			upcast: (type, data) => this.upcaster.apply(type, data),
		});
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
	 * Insert a node: validate data (parsed output stored), mint a ULID, embed its input (see
	 * {@link AddNodeInput}), and write the identity row + the first open version + the vector
	 * rows atomically.
	 */
	async addNode<K extends NodeType<S>>(n: AddNodeInput<S, K>): Promise<NodeOf<S, K>> {
		const def = (this.schema.nodes as Record<string, RawNodeDef | undefined>)[n.type];
		if (!def) throw new Error(`addNode: unknown type '${n.type}'`);
		const parsed = def.parse(n.data) as NodeOf<S, K>['data'];
		// Embed BEFORE the write so the network call never sits inside the batch/lock.
		const prepared = await this.resolveNewEmbedding(
			n.type,
			parsed as Record<string, unknown>,
			n.body,
			n,
		);
		const id = newId();
		const ts = this.now();

		// P12: stamp the type's current `_v` into the STORED data (so future readers
		// know which upcasters to run). The in-memory return stays the clean parsed
		// shape (no `_v`). An unregistered type stamps nothing — byte-identical to pre-P12;
		// a type that itself declares the reserved `_v` throws (no silent clobber).
		const storedData = this.upcaster.stamp(n.type, parsed as Record<string, unknown>);

		const versionStmt: SqlStatement = {
			sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, content_type, data, valid_from)
				VALUES (?,?,?,?,?,?,?,?)`,
			args: [
				id,
				n.type,
				n.body ?? null,
				n.uri ?? null,
				n.content_hash ?? null,
				n.content_type ?? null,
				JSON.stringify(storedData),
				ts,
			],
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
		// A fresh id has no vector rows to replace, so only the inserts are needed.
		if (prepared) stmts.push(...this.embeddingStmts(id, prepared).slice(1));
		const ob = this.outboxStmt(event);
		if (ob) stmts.push(ob); // co-write the event row in the same atomic batch (Layer 2)
		// DuckDB has no store-level backing for declared-unique props (see
		// duck-constraints.ts); libSQL/Postgres enforce it via their partial index instead.
		if (dialectOf(this.raw) === 'duckdb') {
			await assertUniqueProps(this.raw, n.type, parsed as Record<string, unknown>);
		}
		await this.runWriteBatch('addNode', () => this.raw.batch(stmts, 'write'));
		await this.touched(
			'node_identity',
			'node_versions',
			'graph_outbox',
			...(prepared ? ['node_embeddings'] : []),
		);

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

		const id = newId();
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
				await this.commitMutation(tx);
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
		return this.rowToNode(row, !past);
	}

	/** Read metadata, content, and revision from the same temporal row. */
	async getNodeVersion(id: string, opts: { asOf?: number } = {}): Promise<NodeVersion<S> | null> {
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const result = await this.raw.execute({
			sql: `SELECT ver, id, type, data, body, uri, content_hash, content_type FROM node_versions nv
WHERE nv.id = ? AND ${past ? asOfPredicate('nv') : 'nv.valid_to = ?'}`,
			args: past ? [id, opts.asOf!, opts.asOf!] : [id, FOREVER],
		});
		const row = result.rows[0];
		return row ? this.rowToVersion(row, !past) : null;
	}

	/** A `node_versions` row with its content columns → a complete {@link NodeVersion}. */
	private rowToVersion(row: Record<string, unknown>, live: boolean): NodeVersion<S> {
		return {
			...this.rowToNode(row, live),
			revision: String(row.ver),
			body: (row.body as string | null) ?? null,
			uri: (row.uri as string | null) ?? null,
			contentHash: (row.content_hash as string | null) ?? null,
			contentType: (row.content_type as string | null) ?? null,
		};
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
		return r.rows.map((row) => this.rowToNode(row, !past));
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
		const rows = r.rows.map((row) => this.rowToNode(row, !past));
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
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const rows = r.rows.map((row) => this.rowToNode(row, !past));
		if (rows.length > pageSize) {
			const page = rows.slice(0, pageSize);
			return { nodes: page, nextCursor: encodeCursor([(page[page.length - 1] as AnyNode<S>).id]) };
		}
		return { nodes: rows, nextCursor: null };
	}

	/**
	 * Live (or as-of) edges filtered by rel, endpoint and provenance, with their weight and data,
	 * keyset-paginated by id — e.g. every `maybeSameAs` link `graphx/jev` wrote, for a curator.
	 */
	async listEdges(opts: EdgeListOpts = {}): Promise<EdgeListPage> {
		if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
			throw new Error(`listEdges: limit must be a positive integer, got ${opts.limit}`);
		}
		const where: string[] = [];
		const args: SqlValue[] = [];
		if (opts.asOf !== undefined) {
			where.push('ev.valid_from <= ? AND ? < ev.valid_to');
			args.push(opts.asOf, opts.asOf);
		} else {
			where.push('ev.valid_to = ?');
			args.push(FOREVER);
		}
		for (const key of ['rel', 'src', 'dst', 'source'] as const) {
			if (opts[key] !== undefined) {
				where.push(`ev.${key} = ?`);
				args.push(opts[key]);
			}
		}
		if (opts.cursor) {
			where.push('ev.id > ?');
			args.push(decodeCursor(opts.cursor)[0] as string);
		}
		const maxRows = resolveLimits(opts.limits).maxRows;
		const pageSize = Math.min(opts.limit ?? maxRows, maxRows);
		args.push(pageSize + 1);
		const r = await this.raw.execute({
			sql: `SELECT ev.id AS id, ev.rel AS rel, ev.src AS src, ev.dst AS dst, ev.weight AS weight,
					ev.data AS data, ev.source AS source
				FROM edge_versions ev WHERE ${where.join(' AND ')} ORDER BY ev.id LIMIT ?`,
			args,
		});
		const rows: EdgeRecord[] = r.rows.map((row) => ({
			id: String(row.id),
			rel: String(row.rel),
			src: String(row.src),
			dst: String(row.dst),
			weight: Number(row.weight),
			data: parseData(row.data),
			source: row.source === null || row.source === undefined ? null : String(row.source),
		}));
		if (rows.length > pageSize) {
			const page = rows.slice(0, pageSize);
			return { edges: page, nextCursor: encodeCursor([(page[page.length - 1] as EdgeRecord).id]) };
		}
		return { edges: rows, nextCursor: null };
	}

	/**
	 * {@link listNodes}, but each row is the complete version — data, body, content metadata and
	 * revision — read from the same temporal row in one query, so content always matches the data
	 * beside it (live, or as of `asOf`).
	 */
	async listNodeVersions(opts: NodeListOpts = {}): Promise<NodeVersionPage<S>> {
		if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
			throw new Error(`listNodeVersions: limit must be a positive integer, got ${opts.limit}`);
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
		args.push(pageSize + 1); // over-fetch one to detect a next page
		const r = await this.raw.execute({
			sql: `SELECT nv.ver AS ver, nv.id AS id, nv.type AS type, nv.data AS data, nv.body AS body,
					nv.uri AS uri, nv.content_hash AS content_hash, nv.content_type AS content_type
				FROM node_versions nv
				WHERE ${filter.where}${cursorClause}
				ORDER BY nv.id
				LIMIT ?`,
			args,
		});
		const past = opts.asOf !== undefined && opts.asOf < FOREVER;
		const rows = r.rows.map((row) => this.rowToVersion(row, !past));
		if (rows.length > pageSize) {
			const page = rows.slice(0, pageSize);
			return {
				nodes: page,
				nextCursor: encodeCursor([(page[page.length - 1] as NodeVersion<S>).id]),
			};
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
		if (this.atomicTransaction) {
			await run();
			return;
		}
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
		if (this.atomicTransaction) {
			const result = await body(this.atomicTransaction, this.now());
			if (result !== 'committed') throw new Error(`${label}: atomic predecessor was superseded`);
			return;
		}
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
	 * Carry-forward (B4): every column the patch omits is copied from the current live
	 * version — undefined content fields carry forward while null explicitly clears
	 * them; type carries forward when omitted, and data is shallow-merged.
	 *
	 * Vectors: the successor's embedding input is hashed and compared with the stored
	 * `embed_hash`. Unchanged ⇒ the stored vectors stand. Changed ⇒ the node is re-embedded —
	 * OUTSIDE the transaction (the body throws {@link NeedEmbed}, the tx rolls back, the
	 * embedder runs, and the write retries with the vector in hand), so a network call never
	 * holds the write lock. `emb` / `embedding` on the patch override this; `embedding: false`
	 * leaves the stored vectors untouched.
	 */
	async updateNode(id: string, patch: UpdateNodePatch): Promise<void> {
		let pre: PreparedEmbedding | undefined;
		for (;;) {
			try {
				await this.updateNodeOnce(id, patch, pre);
				return;
			} catch (e) {
				if (!(e instanceof NeedEmbed)) throw e;
				pre = await this.prepareFromText(e.type, e.text);
			}
		}
	}

	private async updateNodeOnce(
		id: string,
		patch: UpdateNodePatch,
		pre: PreparedEmbedding | undefined,
		options?: AtomicUpdateOptions,
	): Promise<void> {
		let event: GraphEvent | undefined;
		let embeddingTouched = false;
		// Warm the meta cache and validate any caller-supplied vector BEFORE the lock is taken, so
		// nothing inside the transaction reaches for a second connection or fails on bad input.
		const meta = await this.embeddingMeta();
		if (patch.embedding) {
			const dim = await this.requireDim('embedding');
			for (const c of patch.embedding.chunks) assertVector(c.emb, dim, 'embedding');
		}
		if (patch.emb) assertVector(patch.emb, await this.requireDim('emb'), 'emb');
		await this.runConditionalClose('updateNode', async (tx, rawNow) => {
			const cur = (
				await tx.execute({
					sql: `SELECT ver, type, body, uri, content_hash, content_type, data, valid_from
						FROM node_versions WHERE id = ? AND valid_to = ?`,
					args: [id, FOREVER],
				})
			).rows[0];
			if (options && (!cur || String(cur.ver) !== options.expectedRevision))
				throw new RevisionConflict(id, options.expectedRevision, cur ? String(cur.ver) : null);
			if (!cur) throw new Error(`updateNode: no live version for '${id}'`);

			// M6 data-derived bump: the successor opens (and the predecessor closes) strictly
			// AFTER the predecessor's valid_from, so [valid_from, now) is never zero-width —
			// even when a cross-instance writer's clock ran ahead of this instance's now()
			// (the per-instance high-water mark alone can't see other instances' writes).
			const now = Math.max(rawNow, Number(cur.valid_from) + 1);
			const closed = await tx.execute({
				sql: 'UPDATE node_versions SET valid_to = ? WHERE id = ? AND valid_to = ? AND ver = ?',
				args: [now, id, FOREVER, cur.ver as SqlValue],
			});
			// Superseded between SELECT and UPDATE -> nothing closed -> retry.
			if (closed.rowsAffected !== 1) {
				if (options) throw new RevisionConflict(id, options.expectedRevision, null);
				return 'superseded';
			}

			// P12: produce a successor that is genuinely current-shaped and honestly `_v`-stamped
			// (never "v2-tagged but v1-shaped"). The OLD version row is untouched (closed above) —
			// only this new successor moves forward (no backfill). Unregistered type ⇒ both
			// `apply` and `stamp` are identity → exactly the pre-P12 behavior.
			const successorType = patch.type ?? String(cur.type);
			const curRaw = JSON.parse(String(cur.data)) as Record<string, unknown>;
			let plain: Record<string, unknown>;
			if (options?.replaceData) {
				plain = patch.data ?? {};
			} else if (
				successorType !== String(cur.type) &&
				this.upcaster.stampVersion(successorType) !== undefined
			) {
				// NodeType change INTO a registered type: the live data were shaped by the OLD type's
				// chain, meaningless under the successor. Re-parse the merged result against the
				// SUCCESSOR's Zod schema (drops foreign fields, applies its defaults, throws if a
				// required successor field is missing) before stamping, so the stamp matches the shape.
				const def = (this.schema.nodes as Record<string, RawNodeDef | undefined>)[successorType];
				plain = (
					def ? def.parse({ ...curRaw, ...patch.data }) : { ...curRaw, ...patch.data }
				) as Record<string, unknown>;
			} else {
				// Same-type (or unregistered successor): migrate the live data to the latest shape,
				// merge the patch.
				plain = { ...this.upcaster.apply(String(cur.type), curRaw), ...patch.data };
			}
			const data = this.upcaster.stamp(successorType, plain);
			// DuckDB has no store-level backing for declared-unique props (see
			// duck-constraints.ts); libSQL/Postgres enforce it via their partial index instead.
			// `id` is excluded so a node updated to its own current value is never rejected.
			// `tx`, not `this.raw`: this callback already holds a pooled connection, and
			// reaching for a second one here deadlocks the pool once enough writers are
			// concurrently mid-transaction (reproduced at the default poolMax of 4).
			if (dialectOf(this.raw) === 'duckdb') {
				await assertUniqueProps(tx, successorType, data, id);
			}
			const body = patch.body === undefined ? ((cur.body as string | null) ?? null) : patch.body;
			// B4: carry every metadata column forward unless explicitly patched.
			// `?? null` keeps `undefined` out of the bound args (InValue rejects it).
			const successor: SqlStatement = {
				sql: `INSERT INTO node_versions (id, type, body, uri, content_hash, content_type, data, valid_from)
					VALUES (?,?,?,?,?,?,?,?)`,
				args: [
					id,
					successorType,
					body,
					patch.uri === undefined ? ((cur.uri as SqlValue) ?? null) : patch.uri,
					patch.content_hash === undefined
						? ((cur.content_hash as SqlValue) ?? null)
						: patch.content_hash,
					patch.content_type === undefined
						? ((cur.content_type as SqlValue) ?? null)
						: patch.content_type,
					JSON.stringify(data),
					now,
				],
			};
			await tx.execute(successor);

			// Vectors for the successor. `undefined` = leave the stored rows as they are.
			let rows: PreparedEmbedding | null | undefined;
			if (patch.embedding === false) rows = undefined;
			else if (patch.embedding) rows = patch.embedding;
			else if (patch.emb) {
				const model = this.embedder?.id ?? meta?.model ?? 'unknown';
				rows = {
					hash: embedHash(model, this.embedInput(successorType, plain, body) ?? ''),
					chunks: [{ chunk: 0, text: null, emb: patch.emb }],
				};
			} else if (this.embedder) {
				const text = this.embedInput(successorType, plain, body);
				if (text === null) {
					rows = null; // the policy yields nothing now: drop any stored vectors
				} else if (this.embeddingMode === 'sync') {
					const hash = embedHash(this.embedder.id, text);
					const stored = (
						await tx.execute({
							sql: 'SELECT embed_hash FROM node_embeddings WHERE id = ? AND chunk = 0',
							args: [id],
						})
					).rows[0]?.embed_hash;
					if (stored === hash) rows = undefined;
					else if (pre?.hash === hash) rows = pre;
					else throw new NeedEmbed(successorType, text, hash);
				}
			}
			if (rows !== undefined) {
				for (const stmt of this.embeddingStmts(id, rows)) await tx.execute(stmt);
				embeddingTouched = true;
			}
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
			await this.commitMutation(tx);
			event = ev;
			return 'committed';
		});
		await this.touched(
			'node_versions',
			'graph_outbox',
			...(embeddingTouched ? ['node_embeddings'] : []),
		);
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
		const hasVectors = (await this.embeddingMeta()) !== null;
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
			// Vectors are derived from the live version; there is none now. History keeps the
			// version rows, so nothing about the node's past is lost.
			if (hasVectors) {
				await tx.execute({ sql: 'DELETE FROM node_embeddings WHERE id = ?', args: [id] });
			}
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
			await this.commitMutation(tx);
			event = ev;
			return 'committed';
		});
		await this.touched('node_versions', 'graph_outbox', 'node_embeddings');
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
			await this.commitMutation(tx);
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
	private rowToNode(row: SqlRow, cacheLiveType: boolean): AnyNode<S> {
		const type = String(row.type);
		if (cacheLiveType) this.typeCache.set(String(row.id), type);
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
	opts?: GraphOptions,
): Graph<S> {
	return new Graph(raw, schema, opts);
}

export { FOREVER };
