import type { Slice } from './api';
import type { ExplorerFilters } from './types';

/** Query-key factories — one stable shape per server resource (TanStack Query cache + invalidation). */
export const qk = {
	tenants: () => ['tenants'] as const,
	projects: (tenantId: string) => ['projects', tenantId] as const,
	users: () => ['users'] as const,
	nodes: (tenant: string, project: string, filters: ExplorerFilters) =>
		['nodes', tenant, project, filters] as const,
	graph: (tenant: string, project: string, filters: ExplorerFilters) =>
		['graph', tenant, project, filters] as const,
	/** Filter-agnostic prefixes — what a write invalidates, since it can affect any filtered view. */
	allNodes: (tenant: string, project: string) => ['nodes', tenant, project] as const,
	allGraph: (tenant: string, project: string) => ['graph', tenant, project] as const,
	schema: (tenant: string, project: string) => ['schema', tenant, project] as const,
	/**
	 * The single-node reads are as-of-sensitive, so `asOf` is part of their identity, appended
	 * last. A write must evict the live entry AND every as-of entry it may have cached, so the
	 * mutations below invalidate the `all*` prefix rather than one of these leaves.
	 */
	node: (tenant: string, project: string, id: string, at: Slice = {}) =>
		['node', tenant, project, id, at.asOf ?? null, at.recordedAsOf ?? null] as const,
	nodeContent: (tenant: string, project: string, id: string, at: Slice = {}) =>
		['node-content', tenant, project, id, at.asOf ?? null, at.recordedAsOf ?? null] as const,
	neighbors: (tenant: string, project: string, id: string, at: Slice = {}) =>
		['neighbors', tenant, project, id, at.asOf ?? null, at.recordedAsOf ?? null] as const,
	/** As-of-agnostic prefixes — what a write invalidates. Mirrors `allNodes`/`allGraph` above. */
	allNode: (tenant: string, project: string, id: string) => ['node', tenant, project, id] as const,
	allNodeContent: (tenant: string, project: string, id: string) =>
		['node-content', tenant, project, id] as const,
	allNeighbors: (tenant: string, project: string, id: string) =>
		['neighbors', tenant, project, id] as const,
	// `history` is deliberately left alone: the version trail is the whole trail whatever instant
	// is being viewed, so keying it by `asOf` would refetch identical rows on every scrub.
	history: (tenant: string, project: string, id: string) =>
		['history', tenant, project, id] as const,
	retrieval: (tenant: string, project: string, mode: string, filters: ExplorerFilters) =>
		['retrieval', tenant, project, mode, filters] as const,
	/** A review queue: the live edges of one rel. */
	edges: (tenant: string, project: string, rel: string) => ['edges', tenant, project, rel] as const,
	allEdges: (tenant: string, project: string) => ['edges', tenant, project] as const,
	timeline: (
		tenant: string,
		project: string,
		window: { from?: number; to?: number } = {},
		axis: 'valid' | 'recorded' = 'valid',
	) => ['timeline', tenant, project, window.from ?? null, window.to ?? null, axis] as const,
};
