// @graphx/react — inference-only React Query hooks over the core HTTP surface (no codegen).

export { createGraphHooks } from './create-hooks.ts';
// Input/result types for the hooks, so consumers can type their own args/results.
export type {
	CentralityParams,
	CommunityParams,
	DeleteEdgeInput,
	HybridParams,
	JourneyParams,
	MatchNode,
	MatchResult,
	MatchSpec,
	MatchStep,
	NeighborFilter,
	NodeFilter,
	PageRankParams,
	RetrieveParams,
	ScoresResult,
	ShortestPathParams,
	TopNodesParams,
	UpdateNodePatch,
} from './create-hooks.ts';
export { GraphError } from './errors.ts';
export { type GraphKeys, graphKeys } from './keys.ts';
export { GraphProvider, type GraphProviderProps, useGraphTransport } from './provider.tsx';
export type { GraphTransport, RequestOpts } from './transport.ts';
