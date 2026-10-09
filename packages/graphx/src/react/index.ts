// graphx/react — inference-only React Query hooks over the core HTTP surface (no codegen).

export { createGraphHooks, MatchBuilder } from './create-hooks.ts';
// Input/result types for the hooks, so consumers can type their own args/results.
export type {
	BuiltMatchSpec,
	AnalyticsScope,
	BetweennessParams,
	CentralityParams,
	CommunityParams,
	CorrectEdgeInput,
	CorrectNodeInput,
	CreateHooksOptions,
	DeleteEdgeInput,
	HybridParams,
	JourneyParams,
	MatchNode,
	MatchResult,
	MatchResultOf,
	MatchRowOf,
	MatchSpec,
	MatchSpecInput,
	MatchStep,
	MatchStepInput,
	NeighborFilter,
	NodeFilter,
	PageRankParams,
	PortionParams,
	RetrieveParams,
	ScoresResult,
	ShortestPathParams,
	TimeSliceParams,
	TopNodesParams,
	UpdateNodePatch,
} from './create-hooks.ts';
export { codeFromStatus, GraphError, type GraphErrorCode } from './errors.ts';
export { type GraphKeys, graphKeys } from './keys.ts';
export { GraphProvider, type GraphProviderProps, useGraphTransport } from './provider.tsx';
export { appFetch, type GraphTransport, type RequestLike, type RequestOpts } from './transport.ts';
