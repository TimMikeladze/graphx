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

// Backend dialect seam — driver-neutral DB types every SDK entry point speaks.
export {
	type DbClient,
	type DbTransaction,
	type Dialect,
	dialectOf,
	type SqlResult,
	type SqlRow,
	type SqlStatement,
	type SqlValue,
	type TransactionMode,
} from './dialect.ts';

// P1 — schema init
export {
	ensureColumn,
	init,
	NODES_FTS_TRIGGER_DDL,
	NV_EMB_IDX_DDL,
	readEmbDim,
	schema,
} from './schema.ts';

// P14 — constraints (§19.5)
export {
	declareSingleValuedRel,
	declareUniqueNodeProp,
	materializeConstraints,
} from './constraints.ts';

// P14 — query governance (§19.2) + pagination cursor codec (§19.7)
// P15 — observability metrics sink (§19.6)
export {
	applyLimit,
	decodeCursor,
	DEFAULT_LIMITS,
	encodeCursor,
	InMemoryMetrics,
	type MetricsContext,
	metricLabels,
	type MetricsSink,
	NOOP_METRICS,
	type QueryLimits,
	QueryTimeoutError,
	resolveLimits,
	withTimeout,
} from './governance.ts';

// P0.5 — control plane + authz
export {
	addMembership,
	CONTROL_SCHEMA,
	createApiKey,
	createProject,
	createTenant,
	createUser,
	hashApiKey,
	initControl,
	listProjects,
	listTenants,
	listUsers,
} from './control-plane.ts';
// Admin — operator-gated control-plane CRUD sub-app (mount with app.route('/admin', ...))
export { type AdminConfig, createAdminApp } from './admin.ts';
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
	type NodeType,
	type NodeOf,
	type DataOf,
	type Rel,
	type ZObj,
} from './define-graph-schema.ts';

// P12 — schema evolution / read-time upcasting (§15)
export {
	defineUpcasters,
	type TypeUpcaster,
	Upcaster,
	type UpcasterRegistry,
	type UpcastStep,
} from './upcast.ts';

// P3 / P6 — data layer + temporal mutations
export {
	type AddEdgeInput,
	type AddNodeInput,
	type EdgeDataInput,
	type EdgeRef,
	Graph,
	graphFor,
	type GraphSchema,
	type GraphSlice,
	type GraphSliceLink,
	type GraphSliceNode,
	type GraphSliceOpts,
	type NeighborOpts,
	type NeighborPage,
	type NeighborPageOpts,
	type NodeListOpts,
	type NodeListPage,
	type DataInput,
} from './graph.ts';

// Eventing — in-proc sink + bus (Layer 1); durable outbox tail lives in temporal.ts (Layer 2)
export {
	type GraphEvent,
	GraphEventBus,
	type GraphEventListener,
	type GraphEventOp,
	type GraphEventOptions,
	type GraphEventSink,
	InMemoryEvents,
	NOOP_EVENTS,
	scopeEvents,
} from './events.ts';

// P4 — vectors + GraphRAG retrieve
export {
	dimOf,
	type EmbedFn,
	hashEmbed,
	retrieve,
	type RetrievedNode,
	type RetrieveOpts,
} from './retrieve.ts';

// Record/replay embedder — real model vectors, committed once, replayed offline
export {
	fixtureEmbed,
	type FixtureEmbedder,
	type FixtureEmbedOpts,
} from './embed-fixture.ts';

// P13 — hybrid retrieval (FTS5 + RRF) + rerank/MMR
export {
	type HybridRetrieveOpts,
	hybridRetrieve,
	type MmrOpts,
	type RerankFn,
	type RerankScore,
	sanitizeMatch,
} from './hybrid.ts';

// P13 — bulk ingestion
export { type BulkOpts, bulkLoad, type BulkResult, type BulkRow } from './bulk.ts';

// P5 — PatternBuilder
export {
	type CompiledPattern,
	match,
	type PagePatternOpts,
	PatternBuilder,
	type PatternPage,
	type PatternQuery,
	type PatternRow,
	type RelOpts,
} from './pattern.ts';

// P6 — temporal reads + P15 change feed / CDC (§19.10) + eventing outbox tail (Layer 2)
export {
	asOfPredicate,
	changeFeed,
	type ChangeFeedCursor,
	type ChangeFeedOpts,
	type ChangeFeedPage,
	diff,
	history,
	type OutboxCursor,
	type OutboxPage,
	outboxTail,
	type OutboxTailOpts,
	pruneOutbox,
	type TemporalDiff,
} from './temporal.ts';

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

// P11 — serving (Hono app + typed client) + P15 readiness latch (§19.6)
export {
	type AppType,
	createApp,
	type CreateAppResult,
	createReadiness,
	type DevServeConfig,
	graphForProject,
	type Readiness,
	type ServeConfig,
	type ServeEnv,
} from './serve.ts';

// HTTP contract — OpenAPI 3.1 document generator (served at GET /openapi.json)
export { buildOpenApiDocument, type OpenApiOptions } from './openapi.ts';
