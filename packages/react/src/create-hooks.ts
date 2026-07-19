import {
	type InfiniteData,
	useInfiniteQuery,
	type UseInfiniteQueryResult,
	useMutation,
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from '@tanstack/react-query';
import type {
	AddEdgeInput,
	AddNodeInput,
	AnyNode,
	BulkResult,
	BulkRow,
	ChangeFeedPage,
	EdgeRef,
	GraphEvent,
	GraphSchema,
	GraphSlice,
	JourneyRow,
	NodeType,
	NeighborPage,
	NodeListPage,
	NodeOf,
	Rel,
	RetrievedNode,
	ShortestPathResult,
	TemporalDiff,
	TopNode,
} from '@graphx/core';
import { useEffect, useRef } from 'react';
import { GraphError } from './errors.ts';
import { graphKeys } from './keys.ts';
import { useGraphTransport } from './provider.tsx';
import { request } from './transport.ts';

type Direction = 'forward' | 'reverse' | 'both';
type HopDirection = 'out' | 'in' | 'both';

/** Options for {@link createGraphHooks}. */
export interface CreateHooksOptions {
	/**
	 * Validate the node reads (`useNode`, `useListNodes`, `useNeighbors`, `useMatch`) against the
	 * schema at runtime — defense against server/contract drift. Requires passing the schema VALUE:
	 * `createGraphHooks(schema, { validate: true })`, not the type-only form. A mismatch throws
	 * `GraphError` with `code: 'validation'`. Off by default (retrieve/hybrid/journey return
	 * projection shapes, not full nodes, so they're not validated).
	 */
	validate?: boolean;
}

// --- rel-aware neighbor-type inference (uses the schema's edge `from`/`to`) ---
type EdgesOf<S> = S extends { edges: infer E } ? E : never;
type Endpoints<T> = T extends readonly (infer U)[] ? U : T;
/** The `to`-side node type(s) of rel `R` (a forward hop lands here); all types when unconstrained. */
type RelToType<S extends GraphSchema, R extends Rel<S>> = EdgesOf<S>[R] extends { to: infer T }
	? Endpoints<T> & NodeType<S>
	: NodeType<S>;
/** The `from`-side node type(s) of rel `R` (a reverse hop lands here); all types when unconstrained. */
type RelFromType<S extends GraphSchema, R extends Rel<S>> = EdgesOf<S>[R] extends { from: infer F }
	? Endpoints<F> & NodeType<S>
	: NodeType<S>;
/** The neighbor type reached over rel `R` in direction `D` (forward → `to`, reverse → `from`, both → either). */
type NeighborType<
	S extends GraphSchema,
	R extends Rel<S>,
	D extends Direction,
> = D extends 'forward'
	? RelToType<S, R>
	: D extends 'reverse'
		? RelFromType<S, R>
		: RelToType<S, R> | RelFromType<S, R>;

/** Client-facing read params — `limits`/`metrics` are deliberately absent (server-set, §19.2). */
export interface RetrieveParams {
	query: string;
	k?: number;
	maxDepth?: number;
	direction?: Direction;
	asOf?: number;
}
export interface HybridParams {
	query: string;
	k?: number;
	maxDepth?: number;
	direction?: Direction;
	rels?: string[];
	asOf?: number;
	rrfK?: number;
	mmr?: { k: number; lambda?: number };
}
export interface JourneyParams {
	start: string;
	from: number;
	rels?: string[];
	direction?: Direction;
	maxDepth?: number;
}
export interface NodeFilter {
	type?: string;
	q?: string;
	asOf?: number;
}
export interface NeighborFilter {
	direction?: Direction;
	rel?: string;
}
export interface ShortestPathParams {
	src: string;
	dst: string;
	weighted?: boolean;
	mode?: 'sql' | 'memory';
	rels?: string[];
	maxDepth?: number;
}
export interface TopNodesParams {
	by: 'pagerank' | 'community' | 'degree';
	type?: string;
	limit?: number;
}

/** PATCH /nodes/:id patch — every field optional (mirrors `Graph.updateNode`). */
export interface UpdateNodePatch {
	type?: string;
	data?: Record<string, unknown>;
	emb?: number[];
	body?: string;
	uri?: string;
	content_hash?: string;
	embed_hash?: string;
	content_type?: string;
}
/** `useDeleteEdge` input: the edge id, plus its endpoints so neighbor caches can be invalidated (the feed omits closes, §7). */
export interface DeleteEdgeInput {
	id: string;
	src?: string;
	dst?: string;
}
export interface PageRankParams {
	damping?: number;
	tol?: number;
	maxIter?: number;
}
export interface CommunityParams {
	maxIter?: number;
}
export interface CentralityParams {
	type?: 'degree' | 'in' | 'out';
}
/** id -> score map from pagerank/community/centrality (the route serializes the Map as an object). */
export interface ScoresResult {
	scores: Record<string, number>;
}

/** A JSON-serialized PatternBuilder program (mirrors the POST /match wire schema). */
export type MatchStep =
	| { node: { alias: string; type: string } }
	| { edge: { rel: string; direction?: HopDirection } }
	| { var: { rel: string; min?: number; max?: number; direction?: HopDirection } };
export interface MatchSpec {
	steps: MatchStep[];
	where?: Array<{ alias: string; key: string; value: unknown }>;
	asOf?: number;
	select: string[];
	page?: { limit?: number; cursor?: string };
}
export type MatchNode = { id: string; type: string; data: Record<string, unknown> };
export interface MatchResult {
	rows: Array<Record<string, MatchNode>>;
	nextCursor: string | null;
}

/**
 * NodeType/rel-checked, const-friendly input for the typed {@link createGraphHooks} `useMatch`. Pass the
 * spec as an inline literal so TypeScript keeps the alias/type/select literals and can infer the
 * per-alias row type (a `const` type parameter does the capturing). `node.type` and `edge`/`var.rel`
 * are validated against the schema.
 */
export type MatchStepInput<S extends GraphSchema> =
	| { node: { alias: string; type: NodeType<S> } }
	| { edge: { rel: Rel<S>; direction?: HopDirection } }
	| { var: { rel: Rel<S>; min?: number; max?: number; direction?: HopDirection } };
export interface MatchSpecInput<S extends GraphSchema> {
	steps: readonly MatchStepInput<S>[];
	where?: ReadonlyArray<{ alias: string; key: string; value: unknown }>;
	asOf?: number;
	select: readonly string[];
	page?: { limit?: number; cursor?: string };
}
/** alias → type map read out of a spec's `steps` tuple (node steps only). */
type AliasMap<Steps extends readonly unknown[]> = {
	[N in Steps[number] as N extends { node: { alias: infer A extends string } }
		? A
		: never]: N extends {
		node: { type: infer K };
	}
		? K
		: never;
};
/** One typed `useMatch` row: each SELECTED alias → its node, type-narrowed from the spec. */
export type MatchRowOf<S extends GraphSchema, Spec extends MatchSpecInput<S>> = {
	[A in Spec['select'][number] & keyof AliasMap<Spec['steps']>]: NodeOf<
		S,
		AliasMap<Spec['steps']>[A] & NodeType<S>
	>;
};
export interface MatchResultOf<S extends GraphSchema, Spec extends MatchSpecInput<S>> {
	rows: Array<MatchRowOf<S, Spec>>;
	nextCursor: string | null;
}

/** The spec a {@link MatchBuilder.select} emits — a {@link MatchSpecInput} with the `steps`/`select`
 * tuples captured literally, so {@link useMatch} can infer the per-alias row type from it. */
export interface BuiltMatchSpec<
	S extends GraphSchema,
	Steps extends readonly MatchStepInput<S>[],
	Sel extends readonly string[],
> {
	steps: Steps;
	select: Sel;
	where?: ReadonlyArray<{ alias: string; key: string; value: unknown }>;
	asOf?: number;
	page?: { limit?: number; cursor?: string };
}

/**
 * A fluent, type/rel-checked builder for a {@link useMatch} spec — reads left-to-right like the SDK's
 * `PatternBuilder` and keeps the full type chain (each `.node(alias, type)` extends an alias→type
 * accumulator, so `.select(...)` only accepts declared aliases and yields per-alias-typed rows):
 *
 * ```ts
 * const q = useMatch((m) => m.node('d', 'device').in('raised').node('a', 'alert').select('d', 'a'));
 * // q.data.rows[0].d is NodeOf<S,'device'>, .a is NodeOf<S,'alert'>
 * ```
 *
 * The `Steps`/`Acc` type params are internal (they accumulate through the chain); construct one via
 * the `useMatch(build)` overload, not directly.
 */
export class MatchBuilder<
	S extends GraphSchema,
	Steps extends readonly MatchStepInput<S>[] = readonly [],
	Acc extends Record<string, NodeType<S>> = Record<never, never>,
> {
	private readonly _steps: MatchStepInput<S>[] = [];
	private readonly _where: Array<{ alias: string; key: string; value: unknown }> = [];
	private _asOf?: number;
	private _page?: { limit?: number; cursor?: string };

	/** Add an aliased node bound to `type`; extends the alias→type accumulator. */
	node<A extends string, K extends NodeType<S>>(
		alias: A,
		type: K,
	): MatchBuilder<S, readonly [...Steps, { node: { alias: A; type: K } }], Acc & Record<A, K>> {
		this._steps.push({ node: { alias, type } });
		return this as unknown as MatchBuilder<
			S,
			readonly [...Steps, { node: { alias: A; type: K } }],
			Acc & Record<A, K>
		>;
	}

	/** Forward hop over `rel` (prev.id = edge.src). */
	out<R extends Rel<S>>(
		rel: R,
	): MatchBuilder<S, readonly [...Steps, { edge: { rel: R; direction: 'out' } }], Acc> {
		this._steps.push({ edge: { rel, direction: 'out' } });
		return this as unknown as MatchBuilder<
			S,
			readonly [...Steps, { edge: { rel: R; direction: 'out' } }],
			Acc
		>;
	}

	/** Reverse hop over `rel` (prev.id = edge.dst). */
	in<R extends Rel<S>>(
		rel: R,
	): MatchBuilder<S, readonly [...Steps, { edge: { rel: R; direction: 'in' } }], Acc> {
		this._steps.push({ edge: { rel, direction: 'in' } });
		return this as unknown as MatchBuilder<
			S,
			readonly [...Steps, { edge: { rel: R; direction: 'in' } }],
			Acc
		>;
	}

	/** Undirected hop over `rel` (prev.id on either side). */
	both<R extends Rel<S>>(
		rel: R,
	): MatchBuilder<S, readonly [...Steps, { edge: { rel: R; direction: 'both' } }], Acc> {
		this._steps.push({ edge: { rel, direction: 'both' } });
		return this as unknown as MatchBuilder<
			S,
			readonly [...Steps, { edge: { rel: R; direction: 'both' } }],
			Acc
		>;
	}

	/** The one variable-length segment (`min`..`max` hops over `rel`). */
	rel<R extends Rel<S>>(
		rel: R,
		o: { min?: number; max?: number; direction?: HopDirection } = {},
	): MatchBuilder<S, readonly [...Steps, { var: { rel: R } }], Acc> {
		this._steps.push({ var: { rel, ...o } });
		return this as unknown as MatchBuilder<S, readonly [...Steps, { var: { rel: R } }], Acc>;
	}

	/** Prop filter `alias.data.key === value`; `alias` must already be declared. */
	where(alias: keyof Acc & string, key: string, value: unknown): this {
		this._where.push({ alias, key, value });
		return this;
	}

	/** Time-travel the whole pattern to epoch-ms `t`. */
	asOf(t: number): this {
		this._asOf = t;
		return this;
	}

	/** Keyset-paginate the result (thread the prior page's `nextCursor` back as `cursor`). */
	page(opts: { limit?: number; cursor?: string }): this {
		this._page = opts;
		return this;
	}

	/** Project the named (declared) aliases and finalize the spec. */
	select<Sel extends readonly (keyof Acc & string)[]>(...sel: Sel): BuiltMatchSpec<S, Steps, Sel> {
		return {
			steps: this._steps as unknown as Steps,
			select: sel,
			...(this._where.length ? { where: this._where } : {}),
			...(this._asOf !== undefined ? { asOf: this._asOf } : {}),
			...(this._page ? { page: this._page } : {}),
		};
	}
}

/**
 * Encode a keyset cursor as base64(JSON array) — byte-identical to `@graphx/core`'s `encodeCursor`
 * for the ASCII numeric-string parts a feed cursor holds, but via `btoa` so this package pulls in
 * NO `@graphx/core` runtime (only erased types) and stays browser-safe.
 */
function encodeCursor(parts: string[]): string {
	return btoa(JSON.stringify(parts));
}

/**
 * Next per-stream change-feed cursor. The feed returns `null` whenever a page isn't full, so a
 * partial page (rows present, `next === null`) advances to the LAST ROW's `(valid_from, ver)` —
 * keeping the tail incremental; an empty page keeps the prior position.
 */
function advanceCursor(
	prev: string | undefined,
	rows: Array<Record<string, unknown>>,
	next: string | null,
): string | undefined {
	if (next) return next;
	if (rows.length === 0) return prev;
	const last = rows[rows.length - 1] as { valid_from: unknown; ver: unknown };
	return encodeCursor([String(last.valid_from), String(last.ver)]);
}

/**
 * Build the typed hook set for a user's schema `S` (mirrors `createApp<S>`). Call ONCE at module
 * scope and export the result. Every hook reads its transport from {@link GraphProvider} context,
 * so the hooks carry no config themselves — only `S`-derived types. `schema` is accepted purely to
 * bind `S` for inference (the wire contracts are deliberately loose, so per-type typing needs it).
 * The value is used ONLY for inference — you can either `createGraphHooks(schema)` (infer `S` from
 * the arg) or, in a browser bundle that shouldn't ship the SDK/schema runtime, pass the type
 * explicitly and omit the value: `createGraphHooks<typeof schema>()`. This package pulls in NO
 * `@graphx/core` runtime, so the client stays SDK-free — it's typed by `S` alone (the "no codegen").
 */
export function createGraphHooks<S extends GraphSchema>(_schema?: S, opts?: CreateHooksOptions) {
	/**
	 * When `{ validate: true }` AND the schema VALUE was passed, assert a returned node's `data`
	 * against its type's Zod schema — catching a server that drifts from the contract. Throws a
	 * `GraphError(422, …, issues)` (`code: 'validation'`) on mismatch, so it surfaces as the hook
	 * `error` like any other. No-op without the runtime schema (the type-only `createGraphHooks<S>()`
	 * form) or when disabled — zero overhead.
	 */
	function validateNode<N extends { type: string; data: unknown } | null | undefined>(n: N): N {
		if (!opts?.validate || !_schema || n == null) return n;
		const zt = (_schema.nodes as Record<string, { parse?: (v: unknown) => unknown }>)[n.type];
		if (!zt?.parse) return n;
		try {
			zt.parse(n.data);
		} catch (e) {
			const issues = (e as { issues?: unknown }).issues;
			throw new GraphError(422, `response validation failed for type '${n.type}'`, issues);
		}
		return n;
	}

	/** The project-scoped key factory for the current provider (manual invalidation/prefetch). */
	function useKeys() {
		return graphKeys(useGraphTransport().project);
	}

	/**
	 * A single node by id. Resolves to `null` (not an error) when the node doesn't exist.
	 *
	 * Pass the expected `type` to narrow the result to `NodeOf<S, K>` — the server can't infer type
	 * from an id alone, so without it you get the `AnyNode<S>` union and must discriminate. The type
	 * is also checked at runtime: a node whose stored type differs resolves to `null` (so the
	 * narrowed type is honest, not an unchecked cast). Both forms share one cached fetch — the type
	 * filter runs per-observer via `select`.
	 */
	function useNode<K extends NodeType<S>>(id: string, type: K): UseQueryResult<NodeOf<S, K> | null>;
	function useNode(id: string): UseQueryResult<AnyNode<S> | null>;
	function useNode(id: string, type?: NodeType<S>) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).node(id),
			enabled: id.length > 0,
			queryFn: async (): Promise<AnyNode<S> | null> => {
				try {
					return validateNode(
						await request<AnyNode<S>>(t, {
							method: 'GET',
							path: `/nodes/${encodeURIComponent(id)}`,
						}),
					);
				} catch (e) {
					if (e instanceof GraphError && e.status === 404) return null;
					throw e;
				}
			},
			select: type ? (n) => (n && n.type === type ? n : null) : undefined,
		});
	}

	/** The immutable version trail for a node (raw stored rows, oldest first). */
	function useHistory(id: string) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).history(id),
			enabled: id.length > 0,
			queryFn: async () =>
				(
					await request<{ versions: Array<Record<string, unknown>> }>(t, {
						method: 'GET',
						path: `/nodes/${encodeURIComponent(id)}/history`,
					})
				).versions,
		});
	}

	/**
	 * Keyset-paginated neighbors as an infinite query (`nextCursor` threads the pages).
	 *
	 * Pass a `rel` to narrow the neighbor rows to that relation's endpoint type — the schema's
	 * `from`/`to` pin it (forward hop → `to`, reverse → `from`), so e.g. `{ rel: 'owns' }` yields
	 * `NodeOf<S,'device'>[]` instead of the `AnyNode<S>` union. The server enforces the rel filter,
	 * so the narrowed type is server-backed, not an unchecked cast. An unconstrained rel (no
	 * `from`/`to`) stays the union.
	 */
	function useNeighbors<R extends Rel<S>, D extends Direction = 'forward'>(
		id: string,
		opts: { rel: R; direction?: D; limit?: number },
	): UseInfiniteQueryResult<
		InfiniteData<{ rows: NodeOf<S, NeighborType<S, R, D>>[]; nextCursor: string | null }>
	>;
	function useNeighbors(
		id: string,
		opts?: NeighborFilter & { limit?: number },
	): UseInfiniteQueryResult<InfiniteData<NeighborPage<S>>>;
	function useNeighbors(id: string, opts: NeighborFilter & { limit?: number } = {}) {
		const t = useGraphTransport();
		return useInfiniteQuery({
			queryKey: graphKeys(t.project).neighbors(id, opts),
			enabled: id.length > 0,
			initialPageParam: undefined as string | undefined,
			queryFn: async ({ pageParam }) => {
				const page = await request<NeighborPage<S>>(t, {
					method: 'GET',
					path: `/nodes/${encodeURIComponent(id)}/neighborsPage`,
					query: { direction: opts.direction, rel: opts.rel, limit: opts.limit, cursor: pageParam },
				});
				for (const n of page.rows) validateNode(n as { type: string; data: unknown });
				return page;
			},
			getNextPageParam: (last) => last.nextCursor ?? undefined,
		});
	}

	/**
	 * Keyset-paginated node list as an infinite query. Pass `type` to narrow rows to
	 * `NodeOf<S, K>[]` (the server filters by type, so the narrowing is server-backed).
	 */
	function useListNodes<K extends NodeType<S>>(
		opts: NodeFilter & { type: K; limit?: number },
	): UseInfiniteQueryResult<InfiniteData<{ nodes: NodeOf<S, K>[]; nextCursor: string | null }>>;
	function useListNodes(
		opts?: NodeFilter & { limit?: number },
	): UseInfiniteQueryResult<InfiniteData<NodeListPage<S>>>;
	function useListNodes(opts: NodeFilter & { limit?: number } = {}) {
		const t = useGraphTransport();
		return useInfiniteQuery({
			queryKey: graphKeys(t.project).listNodes(opts),
			initialPageParam: undefined as string | undefined,
			queryFn: async ({ pageParam }) => {
				const page = await request<NodeListPage<S>>(t, {
					method: 'GET',
					path: '/nodes',
					query: {
						type: opts.type,
						q: opts.q,
						asOf: opts.asOf,
						limit: opts.limit,
						cursor: pageParam,
					},
				});
				for (const n of page.nodes) validateNode(n as { type: string; data: unknown });
				return page;
			},
			getNextPageParam: (last) => last.nextCursor ?? undefined,
		});
	}

	/** The canvas slice (nodes + links) for the current filters. */
	function useGraphSlice(opts: NodeFilter = {}) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).graphSlice(opts),
			queryFn: () =>
				request<GraphSlice>(t, {
					method: 'GET',
					path: '/graph',
					query: { type: opts.type, q: opts.q, asOf: opts.asOf },
				}),
		});
	}

	/** GraphRAG vector retrieve. */
	function useRetrieve(params: RetrieveParams) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).retrieve(params),
			enabled: params.query.length > 0,
			queryFn: () =>
				request<RetrievedNode[]>(t, { method: 'GET', path: '/retrieve', query: { ...params } }),
		});
	}

	/** Hybrid GraphRAG retrieve (ANN + FTS → RRF → walk → MMR). */
	function useHybrid(body: HybridParams) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).hybrid(body),
			enabled: body.query.length > 0,
			queryFn: () => request<RetrievedNode[]>(t, { method: 'POST', path: '/hybrid', body }),
		});
	}

	/** Time-respecting traversal. POST body but read-only, so cached as a query keyed on the body. */
	function useJourney(body: JourneyParams) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).journey(body),
			enabled: body.start.length > 0,
			queryFn: () => request<JourneyRow[]>(t, { method: 'POST', path: '/journey', body }),
		});
	}

	/**
	 * Multi-hop pattern query. Pass a spec object, or build one fluently with the const-typed
	 * {@link MatchBuilder} — both yield per-alias-typed rows:
	 *
	 * ```ts
	 * useMatch({ steps: [{ node: { alias: 'd', type: 'device' } }, …], select: ['d'] });
	 * useMatch((m) => m.node('d', 'device').in('raised').node('a', 'alert').select('d', 'a'));
	 * ```
	 */
	function useMatch<const Spec extends MatchSpecInput<S>>(
		spec: Spec,
	): UseQueryResult<MatchResultOf<S, Spec>>;
	function useMatch<const Spec extends MatchSpecInput<S>>(
		build: (m: MatchBuilder<S>) => Spec,
	): UseQueryResult<MatchResultOf<S, Spec>>;
	function useMatch<const Spec extends MatchSpecInput<S>>(
		arg: Spec | ((m: MatchBuilder<S>) => Spec),
	) {
		const t = useGraphTransport();
		const spec = typeof arg === 'function' ? arg(new MatchBuilder<S>()) : arg;
		return useQuery({
			queryKey: graphKeys(t.project).match(spec),
			enabled: spec.select.length > 0,
			// Server-backed cast: the /match reshape returns `{ [alias]: { id, type, data } }` with
			// the type's (upcast) data, so the per-alias `NodeOf<S, type>` typing is honest.
			queryFn: async () => {
				const res = await request<MatchResultOf<S, Spec>>(t, {
					method: 'POST',
					path: '/match',
					body: spec,
				});
				for (const row of res.rows) {
					for (const node of Object.values(row))
						validateNode(node as { type: string; data: unknown });
				}
				return res;
			},
		});
	}

	/** Snapshot delta over the half-open window `(t1, t2]`. */
	function useDiff(t1: number, t2: number) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).diff(t1, t2),
			queryFn: () => request<TemporalDiff>(t, { method: 'GET', path: '/diff', query: { t1, t2 } }),
		});
	}

	/** Shortest path between two nodes (`null` when no route exists). */
	function useShortestPath(body: ShortestPathParams) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).shortestPath(body),
			enabled: body.src.length > 0 && body.dst.length > 0,
			queryFn: () =>
				request<ShortestPathResult | null>(t, {
					method: 'POST',
					path: '/algorithms/shortest-path',
					body,
				}),
		});
	}

	/** Top nodes by a persisted analytics metric. */
	function useTopNodes(params: TopNodesParams) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).topNodes(params),
			queryFn: () =>
				request<TopNode[]>(t, { method: 'GET', path: '/algorithms/top', query: { ...params } }),
		});
	}

	// --- mutations: invalidate-on-settle (§8). The server mints ids / applies zod defaults / stamps
	// `_v`, so optimistic caches won't byte-match — invalidation, not optimistic update, is the default.

	/** Add a node. Invalidates the node-list + canvas-slice queries so they pick it up. */
	function useAddNode() {
		const t = useGraphTransport();
		const qc = useQueryClient();
		return useMutation({
			mutationFn: (input: AddNodeInput<S, NodeType<S>>) =>
				request<NodeOf<S, NodeType<S>>>(t, { method: 'POST', path: '/nodes', body: input }),
			onSettled: () => {
				const k = graphKeys(t.project);
				qc.invalidateQueries({ queryKey: [...k.all, 'listNodes'] });
				qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
			},
		});
	}

	/** Add an edge. Invalidates both endpoints' neighbor caches + dst node + the canvas slice. */
	function useAddEdge() {
		const t = useGraphTransport();
		const qc = useQueryClient();
		return useMutation({
			mutationFn: (input: AddEdgeInput<S, Rel<S>>) =>
				request<EdgeRef>(t, { method: 'POST', path: '/edges', body: input }),
			onSettled: (_d, _e, vars) => {
				const k = graphKeys(t.project);
				qc.invalidateQueries({ queryKey: k.neighbors(vars.src) });
				qc.invalidateQueries({ queryKey: k.neighbors(vars.dst) });
				qc.invalidateQueries({ queryKey: k.node(vars.dst) });
				qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
			},
		});
	}

	/** Edit a node in place; returns the refreshed version. Invalidates node(id) + history(id). */
	function useUpdateNode() {
		const t = useGraphTransport();
		const qc = useQueryClient();
		return useMutation({
			mutationFn: ({ id, patch }: { id: string; patch: UpdateNodePatch }) =>
				request<AnyNode<S> | null>(t, {
					method: 'PATCH',
					path: `/nodes/${encodeURIComponent(id)}`,
					body: patch,
				}),
			onSettled: (_d, _e, vars) => {
				const k = graphKeys(t.project);
				qc.invalidateQueries({ queryKey: k.node(vars.id) });
				qc.invalidateQueries({ queryKey: k.history(vars.id) });
				// changed data/type also show in list + canvas-slice views
				qc.invalidateQueries({ queryKey: [...k.all, 'listNodes'] });
				qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
			},
		});
	}

	/**
	 * Remove an edge. The CDC feed omits closes (decision A.3), so neighbor caches are reconciled
	 * here from the endpoints the caller passes (`src`/`dst`).
	 */
	function useDeleteEdge() {
		const t = useGraphTransport();
		const qc = useQueryClient();
		return useMutation({
			mutationFn: ({ id }: DeleteEdgeInput) =>
				request<void>(t, { method: 'DELETE', path: `/edges/${encodeURIComponent(id)}` }),
			onSettled: (_d, _e, vars) => {
				const k = graphKeys(t.project);
				if (vars.src) qc.invalidateQueries({ queryKey: k.neighbors(vars.src) });
				if (vars.dst) qc.invalidateQueries({ queryKey: k.neighbors(vars.dst) });
				qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
			},
		});
	}

	/** Retract a node. Invalidates node(id) + history(id) + the node-list/canvas-slice queries. */
	function useDeleteNode() {
		const t = useGraphTransport();
		const qc = useQueryClient();
		return useMutation({
			mutationFn: ({ id }: { id: string }) =>
				request<void>(t, { method: 'DELETE', path: `/nodes/${encodeURIComponent(id)}` }),
			onSettled: (_d, _e, vars) => {
				const k = graphKeys(t.project);
				qc.invalidateQueries({ queryKey: k.node(vars.id) });
				qc.invalidateQueries({ queryKey: k.history(vars.id) });
				qc.invalidateQueries({ queryKey: [...k.all, 'listNodes'] });
				qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
				// a retracted node drops from the live `nodes` view, so it disappears from EVERY
				// neighbor result — but we don't know which nodes were adjacent, so invalidate broadly.
				qc.invalidateQueries({ queryKey: [...k.all, 'neighbors'] });
			},
		});
	}

	/** Batch node ingestion. Invalidates the node-list + canvas-slice queries. */
	function useBulkLoad() {
		const t = useGraphTransport();
		const qc = useQueryClient();
		return useMutation({
			mutationFn: (input: { rows: BulkRow<S>[]; chunkSize?: number; loadTs?: number }) =>
				request<BulkResult>(t, { method: 'POST', path: '/bulk', body: input }),
			onSettled: () => {
				const k = graphKeys(t.project);
				qc.invalidateQueries({ queryKey: [...k.all, 'listNodes'] });
				qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
			},
		});
	}

	/** A persisted-analytics mutation factory — pagerank/community/centrality all persist and then
	 * invalidate the topNodes queries that read those columns. */
	function makeAnalytics<I>(path: string) {
		return () => {
			const t = useGraphTransport();
			const qc = useQueryClient();
			return useMutation({
				mutationFn: (input: I) => request<ScoresResult>(t, { method: 'POST', path, body: input }),
				onSettled: () =>
					qc.invalidateQueries({ queryKey: [...graphKeys(t.project).all, 'algorithms', 'top'] }),
			});
		};
	}
	const usePagerank = makeAnalytics<PageRankParams>('/algorithms/pagerank');
	const useCommunity = makeAnalytics<CommunityParams>('/algorithms/community');
	const useCentrality = makeAnalytics<CentralityParams>('/algorithms/centrality');

	/**
	 * CDC live-sync (§19.10, the differentiator). Polls `/changes` and invalidates EXACTLY the
	 * affected keys — `node(id)` per changed node, `neighbors(src/dst)` per changed edge — instead
	 * of a blind interval refetch. The `(valid_from, ver)` keyset advances per stream so polling
	 * never skips or double-counts.
	 *
	 * Cursor advance: the feed reports `nextCursor: null` whenever a page isn't full (the common
	 * steady state), so we advance to the LAST ROW SEEN ourselves — re-deriving the `(valid_from,
	 * ver)` cursor — to keep polling incremental rather than re-scanning from the last full page.
	 *
	 * Close caveat (decision A.3): the feed is `valid_from`-only — it carries INSERTs and
	 * UPDATE-successors, NOT pure closes (`deleteEdge`, single-valued supersession). Edge REMOVALS
	 * are therefore reconciled by the mutation hooks' `onSettled`, not here.
	 */
	function useChangeFeedSync(
		opts: { intervalMs?: number; enabled?: boolean; fromNow?: boolean } = {},
	) {
		const t = useGraphTransport();
		const qc = useQueryClient();
		const cursor = useRef<{ nodes?: string; edges?: string }>({});
		// `draining` stays true while a `fromNow` mount is fast-forwarding past the backlog (possibly
		// several pages); it clears only once BOTH streams report they're caught up.
		const draining = useRef(opts.fromNow === true);
		// the project this cursor belongs to — reset the tail if the provider swaps project/tenant
		// in place (the query key changes, but a plain ref would otherwise carry the old position).
		const boundTo = useRef(`${t.tenant}/${t.project}`);
		return useQuery({
			queryKey: graphKeys(t.project).changes(),
			refetchInterval: opts.intervalMs ?? 2000,
			// keep tailing even when the tab is blurred/hidden — a live-sync feed shouldn't pause
			// (RQ otherwise suspends interval refetch in the background).
			refetchIntervalInBackground: true,
			enabled: opts.enabled ?? true,
			// always hit the network; the feed itself is the source of truth, not the RQ cache
			staleTime: 0,
			gcTime: 0,
			queryFn: async (): Promise<ChangeFeedPage> => {
				const bind = `${t.tenant}/${t.project}`;
				if (boundTo.current !== bind) {
					cursor.current = {};
					draining.current = opts.fromNow === true;
					boundTo.current = bind;
				}
				const page = await request<ChangeFeedPage>(t, {
					method: 'GET',
					path: '/changes',
					query: { nodes: cursor.current.nodes, edges: cursor.current.edges },
				});
				// `fromNow`: while draining, polls only POSITION the cursor past the existing backlog —
				// neither invalidating nor surfacing those rows (avoids a mount-time invalidation storm
				// over a large graph). Drain ends when BOTH streams report caught-up (nextCursor null).
				const skip = draining.current;
				if (skip && page.nextCursor.nodes === null && page.nextCursor.edges === null) {
					draining.current = false;
				}
				const k = graphKeys(t.project);
				if (!skip) {
					for (const n of page.nodes) {
						qc.invalidateQueries({ queryKey: k.node(String((n as { id: unknown }).id)) });
					}
					for (const e of page.edges) {
						const edge = e as { src: unknown; dst: unknown };
						qc.invalidateQueries({ queryKey: k.neighbors(String(edge.src)) });
						qc.invalidateQueries({ queryKey: k.neighbors(String(edge.dst)) });
					}
					// out-of-band inserts/updates also affect the list + canvas-slice views
					if (page.nodes.length > 0 || page.edges.length > 0) {
						qc.invalidateQueries({ queryKey: [...k.all, 'listNodes'] });
						qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
					}
				}
				cursor.current = {
					nodes: advanceCursor(cursor.current.nodes, page.nodes, page.nextCursor.nodes),
					edges: advanceCursor(cursor.current.edges, page.edges, page.nextCursor.edges),
				};
				return skip ? { nodes: [], edges: [], nextCursor: page.nextCursor } : page;
			},
		});
	}

	/**
	 * Live event stream (eventing Layer 3, the push counterpart of {@link useChangeFeedSync}).
	 * Opens the SSE `/events` endpoint and invalidates EXACTLY the affected keys per event —
	 * `node(id)` for node events, `neighbors(src/dst)` for edge events, plus the list/slice views.
	 *
	 * Unlike the poll-based `useChangeFeedSync`, this feed is DELETE-INCLUSIVE: `edge.delete` and
	 * `edge.supersede` arrive as first-class events carrying `src`/`dst`, so edge REMOVALS invalidate
	 * the right neighbor caches here — no reliance on the mutation hooks' `onSettled` and no 2s poll.
	 *
	 * Uses the transport's `fetch` (so it drives an in-process app in tests/SSR and sends the same
	 * auth headers as every other call) rather than a native `EventSource`. Reconnects from the last
	 * seq after a drop. Requires the server to run with `events.outbox` (else the route is 501).
	 */
	function useGraphEvents(opts: { since?: 'now' | 'beginning'; enabled?: boolean } = {}): void {
		const t = useGraphTransport();
		const qc = useQueryClient();
		const enabled = opts.enabled ?? true;
		const since = opts.since ?? 'now';
		useEffect(() => {
			if (!enabled) return;
			const controller = new AbortController();
			let stopped = false;
			let cursor: number | undefined;
			const k = graphKeys(t.project);

			const apply = (ev: GraphEvent): void => {
				if (ev.entity === 'node') {
					qc.invalidateQueries({ queryKey: k.node(ev.id) });
				} else {
					if (ev.src) qc.invalidateQueries({ queryKey: k.neighbors(ev.src) });
					if (ev.dst) qc.invalidateQueries({ queryKey: k.neighbors(ev.dst) });
				}
				qc.invalidateQueries({ queryKey: [...k.all, 'listNodes'] });
				qc.invalidateQueries({ queryKey: [...k.all, 'graphSlice'] });
			};

			const run = async (): Promise<void> => {
				const doFetch = t.fetch ?? globalThis.fetch;
				while (!stopped) {
					try {
						const headers: Record<string, string> = {
							accept: 'text/event-stream',
							...(t.headers ? await t.headers() : {}),
						};
						const params = new URLSearchParams();
						// Resume from the last seq after a reconnect; otherwise honor `since`.
						if (cursor !== undefined) params.set('cursor', String(cursor));
						else params.set('since', since);
						const url = `${t.baseUrl}/t/${t.tenant}/p/${t.project}/events?${params.toString()}`;
						const res = await doFetch(url, { method: 'GET', headers, signal: controller.signal });
						if (!res.ok || !res.body) throw new GraphError(res.status, 'event stream unavailable');
						const reader = res.body.getReader();
						const dec = new TextDecoder();
						let buf = '';
						for (;;) {
							const { value, done } = await reader.read();
							if (done) break;
							buf += dec.decode(value, { stream: true });
							let idx: number;
							while ((idx = buf.indexOf('\n\n')) !== -1) {
								const frame = buf.slice(0, idx);
								buf = buf.slice(idx + 2);
								let event = '';
								let data = '';
								for (const line of frame.split('\n')) {
									if (line.startsWith('event:')) event = line.slice(6).trim();
									else if (line.startsWith('data:')) data += line.slice(5).trim();
								}
								if (event === 'ping' || !data) continue; // keep-alive
								let ev: GraphEvent;
								try {
									ev = JSON.parse(data) as GraphEvent;
								} catch {
									continue;
								}
								apply(ev);
								if (typeof ev.seq === 'number') cursor = ev.seq;
							}
						}
					} catch {
						if (stopped) return;
					}
					// Stream ended or errored → reconnect from `cursor` after a short backoff.
					if (!stopped) await new Promise((r) => setTimeout(r, 1000));
				}
			};
			void run();
			return () => {
				stopped = true;
				controller.abort();
			};
			// t.headers/t.fetch are read fresh on each (re)connect; only identity of the namespace
			// (and enable/since) should tear down and re-open the stream.
		}, [t.baseUrl, t.tenant, t.project, enabled, since, qc]);
	}

	return {
		useKeys,
		useNode,
		useHistory,
		useNeighbors,
		useListNodes,
		useGraphSlice,
		useRetrieve,
		useHybrid,
		useJourney,
		useMatch,
		useDiff,
		useShortestPath,
		useTopNodes,
		useAddNode,
		useAddEdge,
		useUpdateNode,
		useDeleteEdge,
		useDeleteNode,
		useBulkLoad,
		usePagerank,
		useCommunity,
		useCentrality,
		useChangeFeedSync,
		useGraphEvents,
	};
}
