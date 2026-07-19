import { createClient } from '@libsql/client';
import type { DbClient } from './dialect.ts';
import { zValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { logger as honoLogger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import { z, ZodError } from 'zod';
import {
	centrality,
	type CentralityKind,
	community,
	pagerank,
	shortestPath,
	topNodes,
} from './algorithms.ts';
import { AuthzError, type Op, type Principal, resolveProjectDb } from './authz.ts';
import { type BulkRow, bulkLoad } from './bulk.ts';
import {
	addMembership,
	createProject,
	createTenant,
	createUser,
	initControl,
} from './control-plane.ts';
import { getDb } from './db.ts';
import type { NodeType, Rel } from './define-graph-schema.ts';
import type { MetricsSink, QueryLimits } from './governance.ts';
import { init } from './schema.ts';
import { type AddEdgeInput, type AddNodeInput, Graph, type GraphSchema } from './graph.ts';
import { type GraphEventOptions, scopeEvents } from './events.ts';
import { hybridRetrieve } from './hybrid.ts';
import { journey } from './journey.ts';
import { buildOpenApiDocument, type OpenApiOptions } from './openapi.ts';
import { match, type PatternBuilder } from './pattern.ts';
import { dimOf, type EmbedFn, retrieve } from './retrieve.ts';
import { changeFeed, diff, history, outboxHead, outboxTail } from './temporal.ts';
import { Upcaster, type UpcasterRegistry } from './upcast.ts';

/**
 * P11 — Serving (§14, D2). The SDK is a library; this exposes it over HTTP as a
 * **Hono** app (not tRPC) whose typed client is `hc<AppType>` (no codegen).
 *
 * One spine, many consumers (§14.1): every route mounts on the same app, shares the
 * tenant-routing middleware, and calls the same per-project `Graph`. The request
 * flow extends §3.2:
 *
 *   authn    → `cfg.authenticate(c)` verifies the caller → `principal` on ctx
 *   route    → `/t/:tenant/p/:project/...`
 *   authz    → control plane: role ≥ op, project ∈ tenant ({@link graphForProject})
 *   resolve  → project → db_namespace → cached project `Graph` on ctx; `init()` lazily
 *   handler  → runs against that ONE project DB
 *
 * Isolation is by construction (§2.9): each project is a separate libSQL DB, the only
 * sqld credential holder is this server, and there is no shared table to over-read.
 * `cfg.authenticate` is the single authn injection point — verify a JWT / session /
 * hashed API key and return `{ userId, tenantId }`; throwing is surfaced as 401.
 */

/** Per-request server config. `authenticate` is authn layer 1; `embed` powers `retrieve`. */
export interface ServeConfig<S extends GraphSchema> {
	/** The shared control-plane client (registry of tenants/projects/memberships). */
	control: DbClient;
	/** The graph schema every project DB in this deployment is served with. */
	schema: S;
	/** Authn: verify the request → principal. Throw to reject (mapped to 401). */
	authenticate: (c: Context) => Principal | Promise<Principal>;
	/** Embedder for the `retrieve` route; omit to leave `retrieve` unconfigured (501). */
	embed?: EmbedFn;
	/**
	 * §19.2 governance caps enforced server-side on every read route (row cap, fan-out
	 * guard, fail-safe timeout). Set by the operator — NOT client-overridable, so a
	 * tenant can't raise its own limits. Omit for {@link DEFAULT_LIMITS}.
	 */
	limits?: Partial<QueryLimits>;
	/**
	 * P12 (§15) read-time upcaster registry. When set, every per-project `Graph` (and the
	 * journey route) applies it, so the HTTP read surfaces return data in the latest schema
	 * shape over the wire. Omit ⇒ raw stored data (pre-P12 behavior).
	 */
	upcasters?: UpcasterRegistry;
	/**
	 * P15 (§19.6) metrics sink. When set, read routes increment a per-tenant query counter
	 * (`graphx_queries_total`) and journey/retrieve observe traversal + slow-query histograms.
	 * Omit ⇒ no metrics, zero overhead (additive — behavior byte-identical to pre-P15).
	 */
	metrics?: MetricsSink;
	/**
	 * Eventing. When set, every per-project `Graph` emits typed mutation events (create/update/
	 * delete/supersede — including the pure closes the CDC feed misses), scoped per request to
	 * `{tenant, project}`. `sink` is an in-proc consumer (a {@link import('./events.ts').GraphEventBus});
	 * `outbox: true` also co-writes each event into the durable `graph_outbox` table (tailed by
	 * {@link import('./temporal.ts').outboxTail}). Omit ⇒ no events, zero overhead (additive).
	 */
	events?: GraphEventOptions;
	/**
	 * P15 (§19.6) readiness latch gating `/ready` (the load-balancer health gate). Build one with
	 * {@link createReadiness}, serve immediately (`/ready` → 503), run `syncIfReplica(...)` for the
	 * served namespaces ("sync-before-serve"), then call `markReady()` (`/ready` → 200). Omit ⇒
	 * ready immediately (the non-replica case — there is no sync to wait on).
	 */
	readiness?: Readiness;
	/** Title/version/servers for the `GET /openapi.json` document. Omit ⇒ defaults. */
	openapi?: OpenApiOptions;
	/**
	 * Cross-origin access. `true` ⇒ permissive (`origin: '*'`, no `Allow-Credentials` — fine for the
	 * token/header auth graphx uses; for cookie auth pass an explicit `origin` + `credentials: true`),
	 * so a browser SPA on another origin can call the API without a dev proxy. Pass a {@link cors}
	 * options object to restrict origins / methods / credentials. Omit ⇒ no CORS headers (same-origin
	 * only). Applied before routing, so it also answers `OPTIONS` preflight.
	 */
	cors?: boolean | CorsConfig;
	/** Log every request (method, path, status, timing) to the console via Hono's logger. Omit ⇒ silent. */
	logger?: boolean;
	/**
	 * Interactive API reference (Scalar) at `GET /docs`, pointing at `/openapi.json` — unauthenticated
	 * and tenant-agnostic like the contract itself. ON by default; set `false` to disable (then `/docs`
	 * is 404). The viewer JS is loaded from a public CDN (jsdelivr), so `/docs` needs network and trusts
	 * that CDN — the page only renders the already-public spec (no secrets), but for a hardened or
	 * air-gapped deployment set `docs: false` and self-host the reference. `/openapi.json` works offline.
	 */
	docs?: boolean;
}

/** Options accepted by Hono's {@link cors} middleware (origin/methods/headers/credentials/…). */
type CorsConfig = NonNullable<Parameters<typeof cors>[0]>;

/** Self-contained HTML that embeds the Scalar API reference (from CDN) reading `/openapi.json`. */
function docsHtml(title: string): string {
	const safe = title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
	return `<!doctype html>
<html>
  <head>
    <title>${safe}</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}

/**
 * The `/ready` latch (§19.6). `/ready` reports 503 until {@link Readiness.markReady} is called,
 * so an embedded replica can finish its sync-before-serve before the load balancer routes traffic.
 */
export interface Readiness {
	isReady(): boolean;
	markReady(): void;
}

/** Create a {@link Readiness} latch (starts not-ready). The operator flips it after sync-before-serve. */
export function createReadiness(): Readiness {
	let ready = false;
	return {
		isReady: () => ready,
		markReady: () => {
			ready = true;
		},
	};
}

/** Hono env: the per-request principal + the resolved per-project SDK handle. */
export type ServeEnv<S extends GraphSchema> = {
	Variables: { principal: Principal; graph: Graph<S> };
};

/**
 * §3.2 resolve step as a factory: authz (role ≥ `op`, project ∈ tenant) → open the
 * authorized project DB (cached, lazily `init()`ed) → wrap it in a `Graph`. NEVER
 * returns a sqld token. Throws {@link AuthzError} (403/404) on a failed check.
 */
export async function graphForProject<S extends GraphSchema>(
	control: DbClient,
	principal: Principal,
	projectId: string,
	op: Op,
	schema: S,
	upcasters?: UpcasterRegistry,
	events?: GraphEventOptions,
): Promise<Graph<S>> {
	const { client } = await resolveProjectDb(control, principal, projectId, op);
	return new Graph(client, schema, upcasters, events);
}

// --- wire contracts (the Zod schema is the single source feeding every surface) ---

const directionSchema = z.enum(['forward', 'reverse', 'both']);

/** POST /nodes body. `data` is validated per-type by `Graph.addNode` (ZodError → 400). */
const nodeInputSchema = z.object({
	type: z.string(),
	data: z.record(z.string(), z.unknown()).default({}),
	emb: z.array(z.number()).optional(),
	body: z.string().optional(),
	uri: z.string().optional(),
	content_hash: z.string().optional(),
	content_type: z.string().optional(),
});

/** PATCH /nodes/:id body — every field optional; `Graph.updateNode` merges onto the live version. */
const patchNodeSchema = z.object({
	type: z.string().optional(),
	data: z.record(z.string(), z.unknown()).optional(),
	emb: z.array(z.number()).optional(),
	body: z.string().optional(),
	uri: z.string().optional(),
	content_hash: z.string().optional(),
	embed_hash: z.string().optional(),
	content_type: z.string().optional(),
});

/** POST /edges body. `src`/`dst` are ULID node ids; data validated per-rel by `addEdge`. */
const edgeInputSchema = z.object({
	rel: z.string(),
	src: z.string(),
	dst: z.string(),
	weight: z.number().nonnegative().optional(), // mirror the DB CHECK(weight >= 0) at the wire layer
	data: z.record(z.string(), z.unknown()).optional(),
});

/** GET /nodes/:id/neighbors query. */
const neighborQuerySchema = z.object({
	direction: directionSchema.optional(),
	rel: z.string().optional(),
});

/** GET /nodes/:id/neighborsPage query — neighbor filters + keyset pagination (§19.7). */
const neighborPageQuerySchema = neighborQuerySchema.extend({
	limit: z.coerce.number().int().positive().optional(),
	cursor: z.string().optional(),
});

/** GET /retrieve query (§14). `asOf`/`k`/`maxDepth` coerced from strings. */
const retrieveQuerySchema = z.object({
	query: z.string(),
	k: z.coerce.number().optional(),
	maxDepth: z.coerce.number().optional(),
	direction: directionSchema.optional(),
	asOf: z.coerce.number().optional(),
});

/** POST /journey body (§14). `start` = ULID, `from` = epoch ms. */
const journeyInputSchema = z.object({
	start: z.string(),
	from: z.number(),
	rels: z.array(z.string()).optional(),
	direction: directionSchema.optional(),
	maxDepth: z.number().optional(),
});

/** GET /nodes query — type/full-text/as-of filters + keyset pagination. */
const nodeListQuerySchema = z.object({
	type: z.string().optional(),
	q: z.string().optional(),
	asOf: z.coerce.number().optional(),
	limit: z.coerce.number().optional(),
	cursor: z.string().optional(),
});

/** GET /graph query — type/full-text/as-of filters for the canvas slice. */
const graphSliceQuerySchema = z.object({
	type: z.string().optional(),
	q: z.string().optional(),
	asOf: z.coerce.number().optional(),
});

/** POST /algorithms/shortest-path body (§8). `heuristic` is SDK-only (a function, not wire-serializable). */
const shortestPathSchema = z.object({
	src: z.string(),
	dst: z.string(),
	weighted: z.boolean().optional(),
	mode: z.enum(['sql', 'memory']).optional(),
	rels: z.array(z.string()).optional(),
	maxDepth: z.number().int().nonnegative().optional(),
});

/** POST /algorithms/pagerank body. */
const pageRankSchema = z.object({
	damping: z.number().optional(),
	tol: z.number().optional(),
	maxIter: z.number().int().positive().optional(),
});

/** POST /algorithms/community body. */
const communitySchema = z.object({ maxIter: z.number().int().positive().optional() });

/** POST /algorithms/centrality body. */
const centralitySchema = z.object({ type: z.enum(['degree', 'in', 'out']).optional() });

/** GET /algorithms/top query — `by` is whitelisted to the persisted metric columns. */
const topNodesQuerySchema = z.object({
	by: z.enum(['pagerank', 'community', 'degree']),
	type: z.string().optional(),
	limit: z.coerce.number().int().positive().optional(),
});

/** Pattern hop direction (`out`/`in`/`both`) — the PatternBuilder vocab (not the retrieve fwd/rev/both). */
const patternDirectionSchema = z.enum(['out', 'in', 'both']);

/**
 * POST /match body — a JSON-serialized PatternBuilder program (§8/§17). `steps` is an ordered
 * node/edge/var chain (must start with a `node`); `select` names the aliases to project; an
 * optional `page` keyset-paginates, else the whole result runs.
 */
const matchInputSchema = z.object({
	steps: z.array(
		z.union([
			z.object({ node: z.object({ alias: z.string(), type: z.string() }) }),
			z.object({
				edge: z.object({ rel: z.string(), direction: patternDirectionSchema.optional() }),
			}),
			z.object({
				var: z.object({
					rel: z.string(),
					min: z.number().int().nonnegative().optional(),
					max: z.number().int().nonnegative().optional(),
					direction: patternDirectionSchema.optional(),
				}),
			}),
		]),
	),
	where: z.array(z.object({ alias: z.string(), key: z.string(), value: z.unknown() })).optional(),
	asOf: z.number().optional(),
	select: z.array(z.string()).nonempty(),
	page: z
		.object({ limit: z.number().int().positive().optional(), cursor: z.string().optional() })
		.optional(),
});

/** One POST /bulk row. `type`/`data` validated per-type by `bulkLoad` (unknown type / bad data → 400). */
const bulkRowSchema = z.object({
	type: z.string(),
	data: z.record(z.string(), z.unknown()).default({}),
	emb: z.array(z.number()).optional(),
	body: z.string().optional(),
	uri: z.string().optional(),
	content_hash: z.string().optional(),
	content_type: z.string().optional(),
});

/** POST /bulk body (§19.8) — batch node ingestion. `loadTs` shares one `valid_from` across rows. */
const bulkInputSchema = z.object({
	rows: z.array(bulkRowSchema),
	chunkSize: z.number().int().positive().optional(),
	loadTs: z.number().optional(),
});

/**
 * POST /hybrid body (§19.3–19.4). Superset of `retrieve` plus fusion/diversification knobs.
 * `rerank` is omitted by design — it's a server-injected function, not wire-serializable.
 */
const hybridInputSchema = z.object({
	query: z.string(),
	k: z.number().int().positive().optional(),
	maxDepth: z.number().int().nonnegative().optional(),
	direction: directionSchema.optional(),
	rels: z.array(z.string()).optional(),
	asOf: z.number().optional(),
	rrfK: z.number().positive().optional(),
	mmr: z.object({ k: z.number().int().positive(), lambda: z.number().optional() }).optional(),
});

/** GET /changes query — opaque per-stream cursors + page size (CDC tail). */
const changesQuerySchema = z.object({
	nodes: z.string().optional(),
	edges: z.string().optional(),
	limit: z.coerce.number().int().positive().optional(),
});

/** GET /diff query — both window bounds (epoch ms) are required. */
const diffQuerySchema = z.object({
	t1: z.coerce.number(),
	t2: z.coerce.number(),
});

/**
 * GET /events (SSE) query. `since` picks the start when no cursor is given: `now` (default — only
 * events after connect) or `beginning` (full replay). `cursor` resumes after a known `seq` (a
 * `Last-Event-ID` header wins over both). `poll` overrides the caught-up poll interval (ms).
 */
const eventsQuerySchema = z.object({
	since: z.enum(['now', 'beginning']).optional(),
	cursor: z.coerce.number().int().nonnegative().optional(),
	poll: z.coerce.number().int().positive().optional(),
});

/**
 * The route wire schemas, keyed for the OpenAPI generator ({@link buildOpenApiDocument}). Exported as
 * a `Record<string, z.ZodType>` (not the individual consts) so the export stays isolated-declarable
 * while the routes keep using the precise local consts for `zValidator` typing. Single source of
 * truth: the same objects feed both runtime validation and the published contract.
 */
export const WIRE_SCHEMAS: Record<string, z.ZodType> = {
	nodeInput: nodeInputSchema,
	nodeListQuery: nodeListQuerySchema,
	patchNode: patchNodeSchema,
	edgeInput: edgeInputSchema,
	neighborQuery: neighborQuerySchema,
	neighborPageQuery: neighborPageQuerySchema,
	graphSliceQuery: graphSliceQuerySchema,
	retrieveQuery: retrieveQuerySchema,
	hybridInput: hybridInputSchema,
	journeyInput: journeyInputSchema,
	matchInput: matchInputSchema,
	bulkInput: bulkInputSchema,
	changesQuery: changesQuerySchema,
	eventsQuery: eventsQuerySchema,
	diffQuery: diffQuerySchema,
	shortestPath: shortestPathSchema,
	pageRank: pageRankSchema,
	community: communitySchema,
	centrality: centralitySchema,
	topNodesQuery: topNodesQuerySchema,
};

/** Authn middleware: run `cfg.authenticate`, put the principal on ctx, 401 on throw. */
function authn<S extends GraphSchema>(cfg: ServeConfig<S>): MiddlewareHandler<ServeEnv<S>> {
	return createMiddleware<ServeEnv<S>>(async (c, next) => {
		let principal: Principal;
		try {
			principal = await cfg.authenticate(c);
		} catch {
			throw new HTTPException(401, { message: 'unauthenticated' });
		}
		c.set('principal', principal);
		await next();
	});
}

/**
 * Per-route authz+resolve middleware. The URL `:tenant` must match the authenticated
 * principal's tenant (a confused-deputy guard, surfaced as 404 so existence isn't
 * leaked across tenants); then resolve the project `Graph` for `op` onto ctx.
 */
function requireGraph<S extends GraphSchema>(
	cfg: ServeConfig<S>,
	op: Op,
): MiddlewareHandler<ServeEnv<S>> {
	return createMiddleware<ServeEnv<S>>(async (c, next) => {
		const principal = c.get('principal');
		const project = c.req.param('project');
		if (c.req.param('tenant') !== principal.tenantId || !project) {
			throw new AuthzError(404, 'project not found');
		}
		// Scope the app-level sink to this request's namespace so a shared sink attributes each
		// event to its {tenant, project}. `outbox` rides along unchanged.
		const events: GraphEventOptions | undefined = cfg.events
			? {
					sink: cfg.events.sink
						? scopeEvents(cfg.events.sink, { tenant: principal.tenantId, project })
						: undefined,
					outbox: cfg.events.outbox,
				}
			: undefined;
		const graph = await graphForProject(
			cfg.control,
			principal,
			project,
			op,
			cfg.schema,
			cfg.upcasters,
			events,
		);
		// §19.6 per-tenant query counts: only authorized requests are counted (this runs
		// after the confused-deputy guard + authz resolve), labelled by tenant and op.
		cfg.metrics?.inc('graphx_queries_total', { tenant: principal.tenantId, op });
		c.set('graph', graph);
		await next();
	});
}

/** Map domain errors to HTTP: HTTPException passthrough, AuthzError→403/404, validation→400. */
function onError(err: Error, c: Context) {
	// Normalize HTTPException to the same JSON `{ error }` shape every other branch uses.
	// Hono's default getResponse() emits a text/plain body, which clients parsing JSON (e.g.
	// @graphx/react) can't read — so 401/404/501 messages would be lost. Status is preserved.
	if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
	if (err instanceof AuthzError) return c.json({ error: err.message }, err.status);
	if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
	// Graph.updateNode/deleteEdge/deleteNode on a missing id -> the target doesn't exist (404, not 400).
	if (/^(updateNode|deleteEdge|deleteNode): no live version/.test(err.message)) {
		return c.json({ error: err.message }, 404);
	}
	// Graph.addNode/addEdge (unknown type/rel, endpoint-type mismatch), bulkLoad (unknown
	// type), and a malformed PatternBuilder program throw a prefixed `Error` on bad input —
	// those are client errors.
	if (/^(add(Node|Edge)|bulkLoad|PatternBuilder):/.test(err.message)) {
		return c.json({ error: err.message }, 400);
	}
	// Constraint violations that slip past wire validation are bad input, not a server
	// fault: a FK to a non-existent node (unconstrained rel skips the type check),
	// CHECK(weight >= 0), or a UNIQUE clash. Map them to 400, not 500. libSQL reports
	// `SQLITE_CONSTRAINT*`; Postgres uses SQLSTATE class 23 (integrity_constraint_violation).
	const dbCode = String((err as { code?: unknown }).code ?? '');
	if (dbCode.startsWith('SQLITE_CONSTRAINT') || /^23\d{3}$/.test(dbCode)) {
		return c.json({ error: 'constraint violation' }, 400);
	}
	// decodeCursor / decodeFeedCursor reject a tampered/stale keyset cursor with this message.
	if (err.message === 'invalid cursor') return c.json({ error: 'invalid cursor' }, 400);
	return c.json({ error: 'internal' }, 500);
}

/** Build the chained Hono app for `cfg` (internal; the chain's type becomes AppType). */
function buildApp<S extends GraphSchema>(cfg: ServeConfig<S>) {
	// journey takes its own opt-in upcaster (getNode/neighbors upcast via the project Graph).
	const journeyUpcaster = cfg.upcasters ? new Upcaster(cfg.schema, cfg.upcasters) : undefined;
	const base = new Hono<ServeEnv<S>>();
	// Cross-cutting middleware must register BEFORE the route handlers (Hono dispatches in
	// registration order), so a `.use('*')` added after the chain wouldn't wrap earlier routes.
	if (cfg.logger) base.use('*', honoLogger());
	if (cfg.cors) base.use('*', cors(cfg.cors === true ? { origin: '*' } : cfg.cors));
	const app = base
		// §19.6 ops endpoints — UNAUTHENTICATED + tenant-agnostic by construction: mounted
		// OUTSIDE the `/t/:tenant/p/:project/*` authn group, so they never touch the
		// confused-deputy guard. /health = process up (always 200); /ready gates the load
		// balancer on the sync-before-serve latch (default ready when no latch is configured).
		.get('/health', (c) => c.json({ status: 'ok' }))
		.get('/ready', (c) => {
			const ready = cfg.readiness ? cfg.readiness.isReady() : true;
			return c.json({ status: ready ? 'ready' : 'not-ready' }, ready ? 200 : 503);
		})
		// Machine-readable HTTP contract (§14). Unauthenticated + tenant-agnostic, like /health.
		// Request/query schemas are generated from the same Zod wire schemas the routes validate.
		.get('/openapi.json', (c) => c.json(buildOpenApiDocument(cfg.openapi)))
		// Interactive API reference (Scalar, loaded from CDN) at /docs — points at /openapi.json.
		// On by default (unauthenticated, tenant-agnostic like /openapi.json); `docs: false` disables it.
		.get('/docs', (c) =>
			cfg.docs === false ? c.notFound() : c.html(docsHtml(cfg.openapi?.title ?? 'graphx API')),
		)
		.use('/t/:tenant/p/:project/*', authn(cfg))
		.post(
			'/t/:tenant/p/:project/nodes',
			requireGraph(cfg, 'write'),
			zValidator('json', nodeInputSchema),
			async (c) => {
				const node = await c
					.get('graph')
					.addNode(c.req.valid('json') as AddNodeInput<S, NodeType<S>>);
				return c.json(node, 201);
			},
		)
		.post(
			'/t/:tenant/p/:project/edges',
			requireGraph(cfg, 'write'),
			zValidator('json', edgeInputSchema),
			async (c) => {
				const edge = await c.get('graph').addEdge(c.req.valid('json') as AddEdgeInput<S, Rel<S>>);
				return c.json(edge, 201);
			},
		)
		.get('/t/:tenant/p/:project/nodes/:id', requireGraph(cfg, 'read'), async (c) => {
			const node = await c.get('graph').getNode(c.req.param('id'));
			if (!node) throw new HTTPException(404, { message: 'node not found' });
			return c.json(node);
		})
		// Edit a node's data/metadata in place (conditional-close successor, §19.1). Returns
		// the refreshed (upcast) live version; an unknown id throws `no live version` -> 404.
		.patch(
			'/t/:tenant/p/:project/nodes/:id',
			requireGraph(cfg, 'write'),
			zValidator('json', patchNodeSchema),
			async (c) => {
				const graph = c.get('graph');
				await graph.updateNode(c.req.param('id'), c.req.valid('json'));
				return c.json(await graph.getNode(c.req.param('id')));
			},
		)
		// Remove an edge (close the live version, no successor). 204 on success; an unknown
		// id throws `no live version` -> 404.
		.delete('/t/:tenant/p/:project/edges/:id', requireGraph(cfg, 'write'), async (c) => {
			await c.get('graph').deleteEdge(c.req.param('id'));
			return c.body(null, 204);
		})
		// Retract a node (bitemporal close, no successor). 204 on success; an unknown id
		// throws `no live version` -> 404. Mirrors deleteEdge.
		.delete('/t/:tenant/p/:project/nodes/:id', requireGraph(cfg, 'write'), async (c) => {
			await c.get('graph').deleteNode(c.req.param('id'));
			return c.body(null, 204);
		})
		.get(
			'/t/:tenant/p/:project/nodes/:id/neighbors',
			requireGraph(cfg, 'read'),
			zValidator('query', neighborQuerySchema),
			async (c) => {
				const { direction, rel } = c.req.valid('query');
				const list = await c.get('graph').neighbors(c.req.param('id'), {
					direction,
					rels: rel ? [rel] : undefined,
					limits: cfg.limits,
				});
				return c.json(list);
			},
		)
		// Keyset-paginated neighbors (§19.7) — backs the infinite-scroll `useNeighbors`.
		// A tampered cursor throws `invalid cursor` -> 400.
		.get(
			'/t/:tenant/p/:project/nodes/:id/neighborsPage',
			requireGraph(cfg, 'read'),
			zValidator('query', neighborPageQuerySchema),
			async (c) => {
				const { direction, rel, limit, cursor } = c.req.valid('query');
				const page = await c.get('graph').neighborsPage(c.req.param('id'), {
					direction,
					rels: rel ? [rel] : undefined,
					limit,
					cursor,
					limits: cfg.limits,
				});
				return c.json(page);
			},
		)
		.get(
			'/t/:tenant/p/:project/nodes',
			requireGraph(cfg, 'read'),
			zValidator('query', nodeListQuerySchema),
			async (c) => {
				const { type, q, asOf, limit, cursor } = c.req.valid('query');
				const page = await c
					.get('graph')
					.listNodes({ type, q, asOf, limit, cursor, limits: cfg.limits });
				return c.json(page);
			},
		)
		.get(
			'/t/:tenant/p/:project/graph',
			requireGraph(cfg, 'read'),
			zValidator('query', graphSliceQuerySchema),
			async (c) => {
				const { type, q, asOf } = c.req.valid('query');
				const slice = await c.get('graph').graphSlice({ type, q, asOf, limits: cfg.limits });
				return c.json(slice);
			},
		)
		.get('/t/:tenant/p/:project/nodes/:id/history', requireGraph(cfg, 'read'), async (c) => {
			const versions = await history(c.get('graph').raw, c.req.param('id'));
			return c.json({ versions });
		})
		.get(
			'/t/:tenant/p/:project/retrieve',
			requireGraph(cfg, 'read'),
			zValidator('query', retrieveQuerySchema),
			async (c) => {
				if (!cfg.embed) throw new HTTPException(501, { message: 'retrieve not configured' });
				const rows = await retrieve(c.get('graph').raw, cfg.embed, {
					...c.req.valid('query'),
					limits: cfg.limits,
					metrics: cfg.metrics
						? { sink: cfg.metrics, op: 'retrieve', tenant: c.get('principal').tenantId }
						: undefined,
				});
				return c.json(rows);
			},
		)
		.post(
			'/t/:tenant/p/:project/journey',
			requireGraph(cfg, 'read'),
			zValidator('json', journeyInputSchema),
			async (c) => {
				const rows = await journey(c.get('graph').raw, {
					...c.req.valid('json'),
					limits: cfg.limits,
					upcaster: journeyUpcaster,
					metrics: cfg.metrics
						? { sink: cfg.metrics, op: 'journey', tenant: c.get('principal').tenantId }
						: undefined,
				});
				return c.json(rows);
			},
		)
		// §19.10 CDC tail — the headline live-sync route. RAW changelog (no upcaster):
		// reports the bytes written, paged by opaque per-stream `(valid_from, ver)` cursors.
		.get(
			'/t/:tenant/p/:project/changes',
			requireGraph(cfg, 'read'),
			zValidator('query', changesQuerySchema),
			async (c) => {
				const { nodes, edges, limit } = c.req.valid('query');
				const page = await changeFeed(
					c.get('graph').raw,
					{ nodes, edges },
					{ limit, limits: cfg.limits },
				);
				return c.json(page);
			},
		)
		// Live event stream (SSE, eventing Layer 3) — pushes the durable outbox tail, which IS
		// delete-inclusive (unlike /changes): create/update/delete/supersede all arrive as frames
		// `event: <op>`, `data: <GraphEvent json>`, `id: <seq>`. Server-side tails outboxTail and
		// polls when caught up; a browser resumes after a drop via the auto-sent Last-Event-ID.
		// Requires the outbox (501 otherwise). NOTE: EventSource can't send auth headers — deployments
		// serving browsers must let `authenticate` read the token from a query param or cookie.
		.get(
			'/t/:tenant/p/:project/events',
			requireGraph(cfg, 'read'),
			zValidator('query', eventsQuerySchema),
			async (c) => {
				if (!cfg.events?.outbox) {
					throw new HTTPException(501, {
						message: 'event stream not configured (set events.outbox)',
					});
				}
				const raw = c.get('graph').raw;
				const q = c.req.valid('query');
				const pollMs = q.poll ?? 1000;
				const limit = cfg.limits?.maxRows;
				// Resume precedence: Last-Event-ID (browser reconnect) > ?cursor > ?since.
				const lastEventId = c.req.header('Last-Event-ID');
				let cursor: number | undefined;
				if (lastEventId !== undefined && /^\d+$/.test(lastEventId)) {
					cursor = Number(lastEventId);
				} else if (q.cursor !== undefined) {
					cursor = q.cursor;
				} else if ((q.since ?? 'now') === 'now') {
					// Start past the current tail so a live subscriber sees only NEW events (no backlog).
					// MUST use the xmin-gated head (not a bare MAX(seq)): on Postgres a bare MAX would
					// jump the cursor past a still-in-flight lower-seq row and skip it forever.
					cursor = await outboxHead(raw);
				}
				// since=beginning ⇒ cursor stays undefined (replay from the start).
				return streamSSE(c, async (stream) => {
					// Emit the resolved start cursor immediately as an SSE `id`, so a client that drops
					// BEFORE the first data event still resumes by cursor on reconnect (rather than a fresh
					// `since=now` that would skip everything written during the disconnect window).
					await stream.writeSSE({ data: '', event: 'ping', id: String(cursor ?? 0) });
					let idle = 0;
					while (!stream.aborted) {
						const page = await outboxTail(raw, cursor === undefined ? {} : { seq: cursor }, {
							limit,
						});
						if (page.events.length > 0) {
							idle = 0;
							for (const ev of page.events) {
								await stream.writeSSE({
									data: JSON.stringify(ev),
									event: ev.op,
									id: String(ev.seq),
								});
								cursor = ev.seq;
							}
							continue; // drain a full backlog fast before sleeping
						}
						// Caught up: a keep-alive ping every ~15 idle cycles keeps proxies from dropping the
						// idle connection; then wait `pollMs` before checking for new events again.
						if (++idle % 15 === 0) await stream.writeSSE({ data: '', event: 'ping' });
						await stream.sleep(pollMs);
					}
				});
			},
		)
		// Snapshot delta over (t1, t2] — the close-aware companion to /changes (reconciles
		// supersession/delete closes that the valid_from-only feed omits, per decision A.3).
		.get(
			'/t/:tenant/p/:project/diff',
			requireGraph(cfg, 'read'),
			zValidator('query', diffQuerySchema),
			async (c) => {
				const { t1, t2 } = c.req.valid('query');
				return c.json(await diff(c.get('graph').raw, t1, t2));
			},
		)
		// Hybrid GraphRAG search (ANN + FTS5 → RRF → walk → MMR). Needs an embedder (501
		// otherwise, like /retrieve); `rerank` is SDK-only (not wire-serializable).
		.post(
			'/t/:tenant/p/:project/hybrid',
			requireGraph(cfg, 'read'),
			zValidator('json', hybridInputSchema),
			async (c) => {
				if (!cfg.embed) throw new HTTPException(501, { message: 'hybrid retrieve not configured' });
				const rows = await hybridRetrieve(c.get('graph').raw, cfg.embed, {
					...c.req.valid('json'),
					limits: cfg.limits,
				});
				return c.json(rows);
			},
		)
		// Batch node ingestion (§19.8). Validates every row up front (unknown type / bad data →
		// 400 before any index is dropped), loads in chunks, returns the minted ids + count.
		.post(
			'/t/:tenant/p/:project/bulk',
			requireGraph(cfg, 'write'),
			zValidator('json', bulkInputSchema),
			async (c) => {
				const { rows, chunkSize, loadTs } = c.req.valid('json');
				const result = await bulkLoad(c.get('graph').raw, cfg.schema, rows as BulkRow<S>[], {
					chunkSize,
					loadTs,
					upcasters: cfg.upcasters,
				});
				return c.json(result, 201);
			},
		)
		// Multi-hop pattern query (§8/§17). The JSON `steps` chain is replayed onto a
		// PatternBuilder; `page` keyset-paginates, else `run()` returns the whole result.
		// A malformed program (e.g. no node step) throws `PatternBuilder: ...` -> 400.
		.post(
			'/t/:tenant/p/:project/match',
			requireGraph(cfg, 'read'),
			zValidator('json', matchInputSchema),
			async (c) => {
				const { steps, where, asOf, select, page } = c.req.valid('json');
				// Guard select against undeclared aliases up front — otherwise the compiled SQL
				// references a non-existent `sub.<alias>__id` column and fails as a 500.
				const nodeAliases = new Set(steps.flatMap((s) => ('node' in s ? [s.node.alias] : [])));
				for (const a of select) {
					if (!nodeAliases.has(a)) {
						throw new HTTPException(400, {
							message: `match: select references undeclared alias '${a}'`,
						});
					}
				}
				const builder = match(cfg.schema, c.get('graph').raw, cfg.upcasters) as PatternBuilder<
					S,
					Record<string, NodeType<S>>
				>;
				for (const step of steps) {
					if ('node' in step) builder.node(step.node.alias, step.node.type as NodeType<S>);
					else if ('edge' in step) {
						const dir = step.edge.direction ?? 'out';
						if (dir === 'in') builder.in(step.edge.rel);
						else if (dir === 'both') builder.both(step.edge.rel);
						else builder.out(step.edge.rel);
					} else {
						builder.rel(step.var.rel, {
							min: step.var.min,
							max: step.var.max,
							direction: step.var.direction,
						});
					}
				}
				for (const cond of where ?? []) builder.where(cond.alias, cond.key, cond.value);
				if (asOf !== undefined) builder.asOf(asOf);
				const query = await builder.select(...select);
				if (page) return c.json(await query.page({ ...page, limits: cfg.limits }));
				return c.json({ rows: await query.run(), nextCursor: null });
			},
		)
		// --- P8 analytics (§8). shortestPath/topNodes are reads; pagerank/community/centrality
		// PERSIST to node_analytics, so they require `write`. Map results (id -> score) serialize
		// as a plain `scores` object. ---
		.post(
			'/t/:tenant/p/:project/algorithms/shortest-path',
			requireGraph(cfg, 'read'),
			zValidator('json', shortestPathSchema),
			async (c) => {
				const { src, dst, ...opts } = c.req.valid('json');
				return c.json(await shortestPath(c.get('graph').raw, src, dst, opts));
			},
		)
		.post(
			'/t/:tenant/p/:project/algorithms/pagerank',
			requireGraph(cfg, 'write'),
			zValidator('json', pageRankSchema),
			async (c) => {
				const scores = await pagerank(c.get('graph').raw, c.req.valid('json'));
				return c.json({ scores: Object.fromEntries(scores) });
			},
		)
		.post(
			'/t/:tenant/p/:project/algorithms/community',
			requireGraph(cfg, 'write'),
			zValidator('json', communitySchema),
			async (c) => {
				const scores = await community(c.get('graph').raw, c.req.valid('json'));
				return c.json({ scores: Object.fromEntries(scores) });
			},
		)
		.post(
			'/t/:tenant/p/:project/algorithms/centrality',
			requireGraph(cfg, 'write'),
			zValidator('json', centralitySchema),
			async (c) => {
				const scores = await centrality(
					c.get('graph').raw,
					c.req.valid('json').type as CentralityKind | undefined,
				);
				return c.json({ scores: Object.fromEntries(scores) });
			},
		)
		.get(
			'/t/:tenant/p/:project/algorithms/top',
			requireGraph(cfg, 'read'),
			zValidator('query', topNodesQuerySchema),
			async (c) => {
				return c.json(await topNodes(c.get('graph').raw, c.req.valid('query')));
			},
		);
	app.onError(onError);
	return app;
}

/**
 * The app type the typed client consumes: `hc<AppType>(url)`.
 *
 * IMPORTANT — known limitation. This package compiles with `isolatedDeclarations`, which
 * cannot emit Hono's *inferred* per-route RPC schema into `.d.ts` (that schema is produced
 * by whole-program inference over the `.post(...).get(...)` chain; probed as TS9007/TS9010).
 * So the published `AppType` is the app at the ENV level only. From the built `.d.ts`,
 * `hc<AppType>(url)` is RUNTIME-correct (paths/bodies match the wire Zod contracts) but
 * NOT statically typed: `client.t[...]` request bodies and `res.json()` rows resolve to
 * `unknown`. The §14 "typed client, no codegen" benefit therefore requires consuming the
 * SOURCE rather than the package types: `const app = createApp(cfg); export type AppType =
 * typeof app;` in a module WITHOUT `isolatedDeclarations` recovers full per-route types.
 */
export type AppType = Hono<ServeEnv<GraphSchema>>;

/**
 * Batteries-included dev config — pass a `schema` (no `control`/`authenticate`) and `createApp`
 * bootstraps an in-memory control plane, one tenant/project/user, seeds via `seed`, and mounts a
 * permissive header-auth + `GET /demo`. NOT for production (in-memory control, no real auth).
 */
export interface DevServeConfig<S extends GraphSchema> {
	schema: S;
	embed?: EmbedFn;
	limits?: Partial<QueryLimits>;
	upcasters?: UpcasterRegistry;
	metrics?: MetricsSink;
	/** See {@link ServeConfig.events}. Emit typed mutation events (+ optional durable outbox). */
	events?: GraphEventOptions;
	readiness?: Readiness;
	openapi?: OpenApiOptions;
	/** See {@link ServeConfig.cors}. `true` ⇒ permissive — the common dev case (browser SPA, no proxy). */
	cors?: boolean | CorsConfig;
	/** See {@link ServeConfig.logger}. Log every request. */
	logger?: boolean;
	/** See {@link ServeConfig.docs}. Interactive API reference at `/docs` — on by default. */
	docs?: boolean;
	/** Project DB namespace (libSQL file / PG schema). Default `'graphx_dev'`. */
	db?: string;
	/**
	 * Embedding dimension for the vector column. Omit and it's derived from `embed` ({@link dimOf}) so
	 * `/retrieve` + `/hybrid` line up with the model automatically; falls back to 768 when there's no
	 * embedder. Baked at first init and immutable — if it disagrees with an already-materialized
	 * namespace, `createApp` throws (fail-fast) instead of silently keeping the old width.
	 */
	dim?: number;
	/** Seed the graph before serving; runs with an operator principal. */
	seed?: (g: Graph<S>) => void | Promise<void>;
}

/** What the dev `createApp` returns: the app plus the bootstrapped ids + a seed-graph handle. */
export interface CreateAppResult<S extends GraphSchema> {
	app: Hono<ServeEnv<S>>;
	control: DbClient;
	tenant: string;
	project: string;
	user: string;
	graph: Graph<S>;
}

/** Dev bootstrap: fresh in-memory control plane + one tenant/project/user, seeded, header auth. */
async function bootstrapDevApp<S extends GraphSchema>(
	cfg: DevServeConfig<S>,
): Promise<CreateAppResult<S>> {
	const control = createClient({ url: ':memory:' });
	await initControl(control);
	const tenant = await createTenant(control, { name: 'dev' });
	const namespace = cfg.db ?? 'graphx_dev';
	const project = await createProject(control, {
		tenantId: tenant,
		name: 'dev',
		dbNamespace: namespace,
	});
	// Auto-dim: create the project DB's vector column at the embedder's width (or an explicit `dim`)
	// BEFORE the lazy `initOnce` in graphForProject bakes the 768 default. `init` is idempotent
	// (CREATE ... IF NOT EXISTS), so the later re-init is a no-op and the column keeps this width —
	// no manual dim/embedder sync, and `/retrieve` + `/hybrid` just work.
	const dim = cfg.dim ?? (cfg.embed ? await dimOf(cfg.embed) : undefined);
	if (dim !== undefined) await init(getDb(namespace), dim);
	const user = await createUser(control, { email: 'dev@local' });
	await addMembership(control, { userId: user, tenantId: tenant, role: 'editor' });
	const graph = await graphForProject(
		control,
		{ userId: 'seed', tenantId: tenant, operator: true },
		project,
		'write',
		cfg.schema,
		cfg.upcasters,
	);
	if (cfg.seed) await cfg.seed(graph);
	const app = buildApp<S>({
		...cfg,
		control,
		// dev auth: honor the client's x-user/x-tenant headers, else default to the seeded principal.
		authenticate: (c) => ({
			userId: c.req.header('x-user') ?? user,
			tenantId: c.req.header('x-tenant') ?? tenant,
		}),
	});
	app.get('/demo', (c) => c.json({ tenant, project, user }));
	return { app, control, tenant, project, user, graph };
}

/**
 * Build the serving app.
 *
 * - **Production / multi-tenant** — pass `control` + `authenticate` (+ `schema`); returns the fully
 *   chained `Hono` app synchronously. Consume with `hc<AppType>(url)`; a same-module `typeof`
 *   recovers precise route types.
 * - **Dev / single-tenant** — omit `control`/`authenticate`; `createApp` auto-bootstraps an
 *   in-memory control plane, seeds via `seed`, and resolves to `{ app, tenant, project, user, graph }`.
 */
export function createApp<S extends GraphSchema>(
	cfg: DevServeConfig<S>,
): Promise<CreateAppResult<S>>;
export function createApp<S extends GraphSchema>(cfg: ServeConfig<S>): Hono<ServeEnv<S>>;
export function createApp<S extends GraphSchema>(
	cfg: ServeConfig<S> | DevServeConfig<S>,
): Hono<ServeEnv<S>> | Promise<CreateAppResult<S>> {
	if ('control' in cfg && cfg.control) return buildApp(cfg as ServeConfig<S>);
	return bootstrapDevApp(cfg as DevServeConfig<S>);
}
