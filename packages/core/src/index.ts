// Public API for @graphx/core — Temporal GraphRAG on libSQL (P0–P7).

// P0 — connection / pragmas
export {
	applyConnPragmas,
	closeAll,
	type DbConfig,
	evict,
	FOREVER,
	getDb,
	syncIfReplica,
} from './db.ts';

// P1 — schema init
export { ensureColumn, init, schema } from './schema.ts';

// P0.5 — control plane + authz
export {
	addMembership,
	CONTROL_SCHEMA,
	createProject,
	createTenant,
	createUser,
	initControl,
} from './control-plane.ts';
export {
	AuthzError,
	authorize,
	type Op,
	type Principal,
	resolveProjectDb,
	type Role,
} from './authz.ts';

// P2 — Zod schema layer
export {
	type AnyNode,
	defineGraphSchema,
	type EdgeDef,
	type Kind,
	type NodeOf,
	type PropsOf,
	type Rel,
	type ZObj,
} from './define-graph-schema.ts';

// P3 / P6 — data layer + temporal mutations
export {
	type AddEdgeInput,
	type AddNodeInput,
	type EdgePropsInput,
	type EdgeRef,
	Graph,
	graphFor,
	type GraphSchema,
	type NeighborOpts,
	type PropsInput,
} from './graph.ts';

// P4 — vectors + GraphRAG retrieve
export { type EmbedFn, retrieve, type RetrievedNode, type RetrieveOpts } from './retrieve.ts';

// P5 — PatternBuilder
export {
	type CompiledPattern,
	match,
	PatternBuilder,
	type PatternRow,
	type RelOpts,
} from './pattern.ts';

// P6 — temporal reads
export { asOfPredicate, diff, history, type TemporalDiff } from './temporal.ts';

// P7 — time-respecting traversal
export { journey, type JourneyOpts, type JourneyRow } from './journey.ts';

// P8 — graph algorithms (CSR mirror, shortestPath, analytics)
export {
	buildCSR,
	centrality,
	type CentralityKind,
	community,
	type CommunityOpts,
	type CSR,
	type CsrNeighbor,
	type Metric,
	neighbors,
	pagerank,
	type PageRankOpts,
	shortestPath,
	type ShortestPathOpts,
	type ShortestPathResult,
	snapshotCSR,
	type TopNode,
	topNodes,
	type TopNodesOpts,
} from './algorithms.ts';

// P11 — serving (Hono app + typed client)
export {
	type AppType,
	createApp,
	graphForProject,
	type ServeConfig,
	type ServeEnv,
} from './serve.ts';
