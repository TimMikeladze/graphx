import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
	AddEdgeInput,
	AddNodeInput,
	AnyNode,
	BulkResult,
	BulkRow,
	ChangeFeedPage,
	EdgeRef,
	GraphSchema,
	GraphSlice,
	JourneyRow,
	Kind,
	NeighborPage,
	NodeListPage,
	NodeOf,
	Rel,
	RetrievedNode,
	ShortestPathResult,
	TemporalDiff,
	TopNode,
} from 'core';
import { encodeCursor } from 'core';
import { useRef } from 'react';
import { GraphError } from './errors.ts';
import { graphKeys } from './keys.ts';
import { useGraphTransport } from './provider.tsx';
import { request } from './transport.ts';

type Direction = 'forward' | 'reverse' | 'both';
type HopDirection = 'out' | 'in' | 'both';

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
	kind?: string;
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
	kind?: string;
	limit?: number;
}

/** PATCH /nodes/:id patch — every field optional (mirrors `Graph.updateNode`). */
export interface UpdateNodePatch {
	kind?: string;
	props?: Record<string, unknown>;
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
	kind?: 'degree' | 'in' | 'out';
}
/** id -> score map from pagerank/community/centrality (the route serializes the Map as an object). */
export interface ScoresResult {
	scores: Record<string, number>;
}

/** A JSON-serialized PatternBuilder program (mirrors the POST /match wire schema). */
export type MatchStep =
	| { node: { alias: string; kind: string } }
	| { edge: { rel: string; direction?: HopDirection } }
	| { var: { rel: string; min?: number; max?: number; direction?: HopDirection } };
export interface MatchSpec {
	steps: MatchStep[];
	where?: Array<{ alias: string; key: string; value: unknown }>;
	asOf?: number;
	select: string[];
	page?: { limit?: number; cursor?: string };
}
export type MatchNode = { id: string; kind: string; props: Record<string, unknown> };
export interface MatchResult {
	rows: Array<Record<string, MatchNode>>;
	nextCursor: string | null;
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
 * bind `S` for inference (the wire contracts are deliberately loose, so per-kind typing needs it).
 */
export function createGraphHooks<S extends GraphSchema>(_schema: S) {
	/** The project-scoped key factory for the current provider (manual invalidation/prefetch). */
	function useKeys() {
		return graphKeys(useGraphTransport().project);
	}

	/** A single node by id. Resolves to `null` (not an error) when the node doesn't exist. */
	function useNode(id: string) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).node(id),
			enabled: id.length > 0,
			queryFn: async (): Promise<AnyNode<S> | null> => {
				try {
					return await request<AnyNode<S>>(t, {
						method: 'GET',
						path: `/nodes/${encodeURIComponent(id)}`,
					});
				} catch (e) {
					if (e instanceof GraphError && e.status === 404) return null;
					throw e;
				}
			},
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

	/** Keyset-paginated neighbors as an infinite query (`nextCursor` threads the pages). */
	function useNeighbors(id: string, opts: NeighborFilter & { limit?: number } = {}) {
		const t = useGraphTransport();
		return useInfiniteQuery({
			queryKey: graphKeys(t.project).neighbors(id, opts),
			enabled: id.length > 0,
			initialPageParam: undefined as string | undefined,
			queryFn: ({ pageParam }) =>
				request<NeighborPage<S>>(t, {
					method: 'GET',
					path: `/nodes/${encodeURIComponent(id)}/neighborsPage`,
					query: { direction: opts.direction, rel: opts.rel, limit: opts.limit, cursor: pageParam },
				}),
			getNextPageParam: (last) => last.nextCursor ?? undefined,
		});
	}

	/** Keyset-paginated node list as an infinite query. */
	function useListNodes(opts: NodeFilter & { limit?: number } = {}) {
		const t = useGraphTransport();
		return useInfiniteQuery({
			queryKey: graphKeys(t.project).listNodes(opts),
			initialPageParam: undefined as string | undefined,
			queryFn: ({ pageParam }) =>
				request<NodeListPage<S>>(t, {
					method: 'GET',
					path: '/nodes',
					query: { kind: opts.kind, q: opts.q, asOf: opts.asOf, limit: opts.limit, cursor: pageParam },
				}),
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
					query: { kind: opts.kind, q: opts.q, asOf: opts.asOf },
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

	/** Multi-hop pattern query (JSON PatternBuilder program). */
	function useMatch(spec: MatchSpec) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).match(spec),
			enabled: spec.select.length > 0,
			queryFn: () => request<MatchResult>(t, { method: 'POST', path: '/match', body: spec }),
		});
	}

	/** Snapshot delta over the half-open window `(t1, t2]`. */
	function useDiff(t1: number, t2: number) {
		const t = useGraphTransport();
		return useQuery({
			queryKey: graphKeys(t.project).diff(t1, t2),
			queryFn: () =>
				request<TemporalDiff>(t, { method: 'GET', path: '/diff', query: { t1, t2 } }),
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
			mutationFn: (input: AddNodeInput<S, Kind<S>>) =>
				request<NodeOf<S, Kind<S>>>(t, { method: 'POST', path: '/nodes', body: input }),
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
		const primed = useRef(false);
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
				const page = await request<ChangeFeedPage>(t, {
					method: 'GET',
					path: '/changes',
					query: { nodes: cursor.current.nodes, edges: cursor.current.edges },
				});
				// `fromNow`: the first poll only POSITIONS the cursor past the existing backlog — it
				// neither invalidates nor surfaces those rows (avoids a mount-time invalidation storm
				// over a large graph). A backlog spanning >1 page advances one page per poll.
				const skip = opts.fromNow === true && !primed.current;
				primed.current = true;
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
	};
}
