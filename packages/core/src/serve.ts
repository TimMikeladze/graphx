import { createClient } from '@libsql/client';
import type { DbClient } from './dialect.ts';
// `z` comes from the OpenAPI wrapper (the same zod instance, extended with `.openapi()` for the
// few places the generated schema needs an override) — NOT a second copy of zod.
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { logger as honoLogger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
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

/**
 * `info`/`servers` for the generated `GET /openapi.json` document (§14). The paths, parameters,
 * request bodies and response schemas are NOT configurable — they are generated from the route
 * definitions below, so the published contract cannot drift from what the app actually serves.
 */
export interface OpenApiOptions {
	title?: string;
	version?: string;
	/** OpenAPI `servers` list, e.g. `[{ url: 'https://api.example.com' }]`. */
	servers?: Array<{ url: string; description?: string }>;
}

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

/**
 * Query params arrive as strings, so the numeric ones coerce. A bare `z.coerce.number()` publishes
 * its INPUT type — which includes `null`, since `Number(null)` is 0 — and a query string can't
 * carry a null. The `.openapi()` override keeps the published parameter at what the route really
 * takes: a number, with the same bound the validator enforces.
 */
const numQuery = z.coerce.number().openapi({ type: 'number' });
const posIntQuery = z.coerce
	.number()
	.int()
	.positive()
	.openapi({ type: 'integer', exclusiveMinimum: 0 });
const nonNegIntQuery = z.coerce
	.number()
	.int()
	.nonnegative()
	.openapi({ type: 'integer', minimum: 0 });

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
	limit: posIntQuery.optional(),
	cursor: z.string().optional(),
});

/** GET /retrieve query (§14). `asOf`/`k`/`maxDepth` coerced from strings. */
const retrieveQuerySchema = z.object({
	query: z.string(),
	k: numQuery.optional(),
	maxDepth: numQuery.optional(),
	direction: directionSchema.optional(),
	asOf: numQuery.optional(),
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
	asOf: numQuery.optional(),
	limit: numQuery.optional(),
	cursor: z.string().optional(),
});

/** GET /graph query — type/full-text/as-of filters for the canvas slice. */
const graphSliceQuerySchema = z.object({
	type: z.string().optional(),
	q: z.string().optional(),
	asOf: numQuery.optional(),
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
	limit: posIntQuery.optional(),
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
	limit: posIntQuery.optional(),
});

/**
 * GET /diff query — both window bounds (epoch ms) are required. A coerced field reads as optional
 * to the document generator (its input accepts anything), so the two required params say so
 * explicitly; the validator already rejects a missing bound with a 400.
 */
const diffQuerySchema = z.object({
	t1: numQuery.openapi({ param: { required: true } }),
	t2: numQuery.openapi({ param: { required: true } }),
});

/**
 * GET /events (SSE) query. `since` picks the start when no cursor is given: `now` (default — only
 * events after connect) or `beginning` (full replay). `cursor` resumes after a known `seq` (a
 * `Last-Event-ID` header wins over both). `poll` overrides the caught-up poll interval (ms).
 */
const eventsQuerySchema = z.object({
	since: z.enum(['now', 'beginning']).optional(),
	cursor: nonNegIntQuery.optional(),
	poll: posIntQuery.optional(),
});

// --- response contracts ---
//
// The route definitions below declare what each route RETURNS as well as what it accepts, so the
// published document describes real success bodies (not an opaque `{}`) and the handler's
// `c.json(...)` is type-checked against the declaration.
//
// These describe the WIRE shape. The SDK's own types are richer — `data` is per-type Zod-validated
// (`DataOf<S, K>`) rather than an open record — so a handler returning a schema-generic domain type
// is cast to the wire type at the `c.json` call. The cast is safe by construction (every field the
// wire schema names is present on the domain type) and it is why the response schemas live next to
// the routes rather than being inferred from the SDK.

/** The `{ error }` body every failure branch of {@link onError} returns. */
const errorSchema = z.object({ error: z.string(), issues: z.unknown().optional() });

/** A node projection: identity + the validated per-type `data` (open at the wire). */
const nodeSchema = z.object({
	id: z.string(),
	type: z.string(),
	data: z.record(z.string(), z.unknown()),
});

/** What `addEdge` returns — the minted edge's identity, not the whole version row. */
const edgeSchema = z.object({
	id: z.string(),
	rel: z.string(),
	src: z.string(),
	dst: z.string(),
});

/** Raw version rows (`node_versions` / the CDC changelog) are returned column-for-column. */
const versionRowSchema = z.record(z.string(), z.unknown());

const nodeListPageSchema = z.object({
	nodes: z.array(nodeSchema),
	nextCursor: z.string().nullable(),
});

const neighborPageSchema = z.object({
	rows: z.array(nodeSchema),
	nextCursor: z.string().nullable(),
});

const nodeContentSchema = z.object({
	body: z.string().nullable(),
	uri: z.string().nullable(),
	contentType: z.string().nullable(),
	contentHash: z.string().nullable(),
});

const graphSliceSchema = z.object({
	nodes: z.array(z.object({ id: z.string(), type: z.string(), label: z.string().optional() })),
	links: z.array(
		z.object({
			id: z.string(),
			source: z.string(),
			target: z.string(),
			rel: z.string(),
			weight: z.number(),
		}),
	),
	truncated: z.boolean(),
});

const retrievedNodeSchema = z.object({
	id: z.string(),
	body: z.string().nullable(),
	uri: z.string().nullable(),
	depth: z.number(),
});

const journeyRowSchema = z.object({
	id: z.string(),
	arrival_t: z.number(),
	hops: z.number(),
	type: z.string(),
	name: z.unknown(),
});

const changeFeedPageSchema = z.object({
	nodes: z.array(versionRowSchema),
	edges: z.array(versionRowSchema),
	nextCursor: z.object({ nodes: z.string().nullable(), edges: z.string().nullable() }),
});

const temporalDiffSchema = z.object({
	nodes: z.array(versionRowSchema),
	edges: z.array(versionRowSchema),
});

/** One `match` row: the selected aliases, each bound to a node projection. */
const patternPageSchema = z.object({
	rows: z.array(z.record(z.string(), nodeSchema)),
	nextCursor: z.string().nullable(),
});

const bulkResultSchema = z.object({ ids: z.array(z.string()), count: z.number() });

/** `pagerank`/`community`/`centrality` serialize their `Map<id, score>` as a plain object. */
const scoresSchema = z.object({ scores: z.record(z.string(), z.number()) });

/** `null` when no path exists between the endpoints. */
const shortestPathResultSchema = z
	.object({ path: z.array(z.string()), cost: z.number() })
	.nullable();

const topNodeSchema = z.object({
	id: z.string(),
	type: z.string(),
	pagerank: z.number().nullable(),
	community: z.number().nullable(),
	degree: z.number().nullable(),
});

type WireNode = z.infer<typeof nodeSchema>;

// --- route definition helpers ---

/** Path params for every tenant-scoped route; `{id}` routes extend it. */
const scopeParams = z.object({ tenant: z.string(), project: z.string() });
const idParams = scopeParams.extend({ id: z.string() });

/** A JSON `{ error }` response with the given description. */
function jsonError(description: string) {
	return { description, content: { 'application/json': { schema: errorSchema } } };
}

/** A JSON success response carrying `schema`. */
function json<T extends z.ZodType>(description: string, schema: T) {
	return { description, content: { 'application/json': { schema } } };
}

/**
 * The failure branches every authenticated route shares: 400 (wire validation or a domain error
 * mapped by {@link onError}), 401 (authn), 404 (unknown project — the confused-deputy guard — or an
 * unknown id). Write routes add 403 (role below the op).
 */
const READ_ERRORS = {
	400: jsonError('Invalid request'),
	401: jsonError('Unauthenticated'),
	404: jsonError('Not found'),
};
const WRITE_ERRORS = { ...READ_ERRORS, 403: jsonError('Forbidden') };

/** Bearer auth applies to every tenant-scoped route (the `/health`-style ops routes are public). */
const SECURITY = [{ bearerAuth: [] }];

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

/** Build the chained OpenAPI app for `cfg` (internal; the chain's type becomes AppType). */
function buildApp<S extends GraphSchema>(cfg: ServeConfig<S>) {
	// journey takes its own opt-in upcaster (getNode/neighbors upcast via the project Graph).
	const journeyUpcaster = cfg.upcasters ? new Upcaster(cfg.schema, cfg.upcasters) : undefined;
	const base = new OpenAPIHono<ServeEnv<S>>({
		// Wire-validation failures answer with the SAME `{ error, issues }` body every other failure
		// branch uses (see `onError`), which is what the 400 response schema documents and what
		// `@graphx/react` parses. The wrapper's default hook would emit `{ success, error }` instead.
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json({ error: 'validation', issues: result.error.issues }, 400),
	});
	// `cfg.authenticate` is the injection point — bearer is the documented default; swap the
	// scheme to match your deployment (session cookie, hashed API key, etc.).
	base.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
		type: 'http',
		scheme: 'bearer',
	});
	// Cross-cutting middleware must register BEFORE the route handlers (Hono dispatches in
	// registration order), so a `.use('*')` added after the chain wouldn't wrap earlier routes.
	if (cfg.logger) base.use('*', honoLogger());
	if (cfg.cors) base.use('*', cors(cfg.cors === true ? { origin: '*' } : cfg.cors));
	// Authn for the whole tenant group. Registered off the chain: `Hono.use` returns a plain
	// `Hono`, which would drop `.openapi()` from the chain's type for every route after it.
	base.use('/t/:tenant/p/:project/*', authn(cfg));
	// Interactive API reference (Scalar, loaded from CDN) at /docs — points at /openapi.json.
	// On by default (unauthenticated, tenant-agnostic like /openapi.json); `docs: false` disables it.
	// Left off the contract itself (it serves HTML for humans, not an API surface) and off the
	// chain (plain `.get` returns a `Hono`, which would drop `.openapi()` from the chain's type).
	base.get('/docs', (c) =>
		cfg.docs === false ? c.notFound() : c.html(docsHtml(cfg.openapi?.title ?? 'graphx API')),
	);
	const app = base
		// §19.6 ops endpoints — UNAUTHENTICATED + tenant-agnostic by construction: mounted
		// OUTSIDE the `/t/:tenant/p/:project/*` authn group, so they never touch the
		// confused-deputy guard. /health = process up (always 200); /ready gates the load
		// balancer on the sync-before-serve latch (default ready when no latch is configured).
		.openapi(
			createRoute({
				method: 'get',
				path: '/health',
				summary: 'Liveness — the process is up',
				security: [],
				responses: { 200: json('OK', z.object({ status: z.literal('ok') })) },
			}),
			(c) => c.json({ status: 'ok' } as const, 200),
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/ready',
				summary: 'Readiness — sync-before-serve latch (503 until ready)',
				security: [],
				responses: {
					200: json('Ready', z.object({ status: z.literal('ready') })),
					503: json('Not ready', z.object({ status: z.literal('not-ready') })),
				},
			}),
			(c) => {
				const ready = cfg.readiness ? cfg.readiness.isReady() : true;
				return ready
					? c.json({ status: 'ready' } as const, 200)
					: c.json({ status: 'not-ready' } as const, 503);
			},
		)
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/nodes',
				summary: 'Create a node',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: nodeInputSchema } } },
				},
				responses: { 201: json('Created', nodeSchema), ...WRITE_ERRORS },
			}),
			async (c) => {
				const node = await c
					.get('graph')
					.addNode(c.req.valid('json') as AddNodeInput<S, NodeType<S>>);
				return c.json(node as WireNode, 201);
			},
		)
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/edges',
				summary: 'Create an edge',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: edgeInputSchema } } },
				},
				responses: { 201: json('Created', edgeSchema), ...WRITE_ERRORS },
			}),
			async (c) => {
				const edge = await c.get('graph').addEdge(c.req.valid('json') as AddEdgeInput<S, Rel<S>>);
				return c.json(edge, 201);
			},
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/nodes/{id}',
				summary: 'Get a node by id',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: idParams },
				responses: { 200: json('OK', nodeSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const node = await c.get('graph').getNode(c.req.param('id'));
				if (!node) throw new HTTPException(404, { message: 'node not found' });
				return c.json(node as WireNode, 200);
			},
		)
		// Edit a node's data/metadata in place (conditional-close successor, §19.1). Returns
		// the refreshed (upcast) live version; an unknown id throws `no live version` -> 404.
		.openapi(
			createRoute({
				method: 'patch',
				path: '/t/{tenant}/p/{project}/nodes/{id}',
				summary: 'Update a node',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: idParams,
					body: { required: true, content: { 'application/json': { schema: patchNodeSchema } } },
				},
				responses: { 200: json('OK', nodeSchema), ...WRITE_ERRORS },
			}),
			async (c) => {
				const graph = c.get('graph');
				await graph.updateNode(c.req.param('id'), c.req.valid('json'));
				// updateNode succeeded, so the live version exists — the `| null` is unreachable here.
				return c.json((await graph.getNode(c.req.param('id'))) as WireNode, 200);
			},
		)
		// Remove an edge (close the live version, no successor). 204 on success; an unknown
		// id throws `no live version` -> 404.
		.openapi(
			createRoute({
				method: 'delete',
				path: '/t/{tenant}/p/{project}/edges/{id}',
				summary: 'Delete an edge',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: { params: idParams },
				responses: { 204: { description: 'No Content' }, ...WRITE_ERRORS },
			}),
			async (c) => {
				await c.get('graph').deleteEdge(c.req.param('id'));
				return c.body(null, 204);
			},
		)
		// Retract a node (bitemporal close, no successor). 204 on success; an unknown id
		// throws `no live version` -> 404. Mirrors deleteEdge.
		.openapi(
			createRoute({
				method: 'delete',
				path: '/t/{tenant}/p/{project}/nodes/{id}',
				summary: 'Retract a node',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: { params: idParams },
				responses: { 204: { description: 'No Content' }, ...WRITE_ERRORS },
			}),
			async (c) => {
				await c.get('graph').deleteNode(c.req.param('id'));
				return c.body(null, 204);
			},
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/nodes/{id}/neighbors',
				summary: 'Neighbors (unpaginated)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: idParams, query: neighborQuerySchema },
				responses: { 200: json('OK', z.array(nodeSchema)), ...READ_ERRORS },
			}),
			async (c) => {
				const { direction, rel } = c.req.valid('query');
				const list = await c.get('graph').neighbors(c.req.param('id'), {
					direction,
					rels: rel ? [rel] : undefined,
					limits: cfg.limits,
				});
				return c.json(list as WireNode[], 200);
			},
		)
		// Keyset-paginated neighbors (§19.7) — backs the infinite-scroll `useNeighbors`.
		// A tampered cursor throws `invalid cursor` -> 400.
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/nodes/{id}/neighborsPage',
				summary: 'Neighbors (keyset paginated)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: idParams, query: neighborPageQuerySchema },
				responses: { 200: json('OK', neighborPageSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const { direction, rel, limit, cursor } = c.req.valid('query');
				const page = await c.get('graph').neighborsPage(c.req.param('id'), {
					direction,
					rels: rel ? [rel] : undefined,
					limit,
					cursor,
					limits: cfg.limits,
				});
				return c.json(page as z.infer<typeof neighborPageSchema>, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/nodes',
				summary: 'List nodes (keyset paginated)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: nodeListQuerySchema },
				responses: { 200: json('OK', nodeListPageSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const { type, q, asOf, limit, cursor } = c.req.valid('query');
				const page = await c
					.get('graph')
					.listNodes({ type, q, asOf, limit, cursor, limits: cfg.limits });
				return c.json(page as z.infer<typeof nodeListPageSchema>, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/graph',
				summary: 'Canvas slice (nodes + links)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: graphSliceQuerySchema },
				responses: { 200: json('OK', graphSliceSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const { type, q, asOf } = c.req.valid('query');
				const slice = await c.get('graph').graphSlice({ type, q, asOf, limits: cfg.limits });
				return c.json(slice, 200);
			},
		)
		// The live version's content payload (body + provenance), fetched on demand — kept off
		// `GET /nodes/:id` so the typed node projection stays small.
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/nodes/{id}/content',
				summary: 'Live content payload (body + provenance)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: idParams },
				responses: { 200: json('OK', nodeContentSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const content = await c.get('graph').getNodeContent(c.req.param('id'));
				if (!content) throw new HTTPException(404, { message: 'node not found' });
				return c.json(content, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/nodes/{id}/history',
				summary: 'Version trail for a node',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: idParams },
				responses: {
					200: json('OK', z.object({ versions: z.array(versionRowSchema) })),
					...READ_ERRORS,
				},
			}),
			async (c) => {
				const versions = await history(c.get('graph').raw, c.req.param('id'));
				return c.json({ versions }, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/retrieve',
				summary: 'GraphRAG vector retrieve',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: retrieveQuerySchema },
				responses: {
					200: json('OK', z.array(retrievedNodeSchema)),
					...READ_ERRORS,
					501: jsonError('No embedder configured'),
				},
			}),
			async (c) => {
				if (!cfg.embed) throw new HTTPException(501, { message: 'retrieve not configured' });
				const rows = await retrieve(c.get('graph').raw, cfg.embed, {
					...c.req.valid('query'),
					limits: cfg.limits,
					metrics: cfg.metrics
						? { sink: cfg.metrics, op: 'retrieve', tenant: c.get('principal').tenantId }
						: undefined,
				});
				return c.json(rows, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/journey',
				summary: 'Time-respecting traversal',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: journeyInputSchema } } },
				},
				responses: { 200: json('OK', z.array(journeyRowSchema)), ...READ_ERRORS },
			}),
			async (c) => {
				const rows = await journey(c.get('graph').raw, {
					...c.req.valid('json'),
					limits: cfg.limits,
					upcaster: journeyUpcaster,
					metrics: cfg.metrics
						? { sink: cfg.metrics, op: 'journey', tenant: c.get('principal').tenantId }
						: undefined,
				});
				return c.json(rows, 200);
			},
		)
		// §19.10 CDC tail — the headline live-sync route. RAW changelog (no upcaster):
		// reports the bytes written, paged by opaque per-stream `(valid_from, ver)` cursors.
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/changes',
				summary: 'Change feed / CDC tail',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: changesQuerySchema },
				responses: { 200: json('OK', changeFeedPageSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const { nodes, edges, limit } = c.req.valid('query');
				const page = await changeFeed(
					c.get('graph').raw,
					{ nodes, edges },
					{ limit, limits: cfg.limits },
				);
				return c.json(page, 200);
			},
		)
		// Live event stream (SSE, eventing Layer 3) — pushes the durable outbox tail, which IS
		// delete-inclusive (unlike /changes): create/update/delete/supersede all arrive as frames
		// `event: <op>`, `data: <GraphEvent json>`, `id: <seq>`. Server-side tails outboxTail and
		// polls when caught up; a browser resumes after a drop via the auto-sent Last-Event-ID.
		// Requires the outbox (501 otherwise). NOTE: EventSource can't send auth headers — deployments
		// serving browsers must let `authenticate` read the token from a query param or cookie.
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/events',
				summary: 'Live event stream (SSE, delete-inclusive)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: eventsQuerySchema },
				responses: {
					200: {
						description: 'SSE frames: `event: <op>`, `data: <GraphEvent json>`, `id: <seq>`',
						content: { 'text/event-stream': { schema: z.string() } },
					},
					...READ_ERRORS,
					501: jsonError('No outbox configured'),
				},
			}),
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
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/diff',
				summary: 'Snapshot delta over (t1, t2]',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: diffQuerySchema },
				responses: { 200: json('OK', temporalDiffSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const { t1, t2 } = c.req.valid('query');
				return c.json(await diff(c.get('graph').raw, t1, t2), 200);
			},
		)
		// Hybrid GraphRAG search (ANN + FTS5 → RRF → walk → MMR). Needs an embedder (501
		// otherwise, like /retrieve); `rerank` is SDK-only (not wire-serializable).
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/hybrid',
				summary: 'Hybrid retrieve (ANN + FTS + RRF + MMR)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: hybridInputSchema } } },
				},
				responses: {
					200: json('OK', z.array(retrievedNodeSchema)),
					...READ_ERRORS,
					501: jsonError('No embedder configured'),
				},
			}),
			async (c) => {
				if (!cfg.embed) throw new HTTPException(501, { message: 'hybrid retrieve not configured' });
				const rows = await hybridRetrieve(c.get('graph').raw, cfg.embed, {
					...c.req.valid('json'),
					limits: cfg.limits,
				});
				return c.json(rows, 200);
			},
		)
		// Batch node ingestion (§19.8). Validates every row up front (unknown type / bad data →
		// 400 before any index is dropped), loads in chunks, returns the minted ids + count.
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/bulk',
				summary: 'Bulk-load nodes',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: bulkInputSchema } } },
				},
				responses: { 201: json('Created', bulkResultSchema), ...WRITE_ERRORS },
			}),
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
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/match',
				summary: 'Multi-hop pattern query',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: matchInputSchema } } },
				},
				responses: { 200: json('OK', patternPageSchema), ...READ_ERRORS },
			}),
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
				const result = page
					? await query.page({ ...page, limits: cfg.limits })
					: { rows: await query.run(), nextCursor: null };
				return c.json(result as z.infer<typeof patternPageSchema>, 200);
			},
		)
		// --- P8 analytics (§8). shortestPath/topNodes are reads; pagerank/community/centrality
		// PERSIST to node_analytics, so they require `write`. Map results (id -> score) serialize
		// as a plain `scores` object. ---
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/algorithms/shortest-path',
				summary: 'Shortest path',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: shortestPathSchema } } },
				},
				responses: { 200: json('OK', shortestPathResultSchema), ...READ_ERRORS },
			}),
			async (c) => {
				const { src, dst, ...opts } = c.req.valid('json');
				return c.json(await shortestPath(c.get('graph').raw, src, dst, opts), 200);
			},
		)
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/algorithms/pagerank',
				summary: 'PageRank (persists)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: pageRankSchema } } },
				},
				responses: { 200: json('OK', scoresSchema), ...WRITE_ERRORS },
			}),
			async (c) => {
				const scores = await pagerank(c.get('graph').raw, c.req.valid('json'));
				return c.json({ scores: Object.fromEntries(scores) }, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/algorithms/community',
				summary: 'Community detection (persists)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: communitySchema } } },
				},
				responses: { 200: json('OK', scoresSchema), ...WRITE_ERRORS },
			}),
			async (c) => {
				const scores = await community(c.get('graph').raw, c.req.valid('json'));
				return c.json({ scores: Object.fromEntries(scores) }, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'post',
				path: '/t/{tenant}/p/{project}/algorithms/centrality',
				summary: 'Degree centrality (persists)',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'write')],
				request: {
					params: scopeParams,
					body: { required: true, content: { 'application/json': { schema: centralitySchema } } },
				},
				responses: { 200: json('OK', scoresSchema), ...WRITE_ERRORS },
			}),
			async (c) => {
				const scores = await centrality(
					c.get('graph').raw,
					c.req.valid('json').type as CentralityKind | undefined,
				);
				return c.json({ scores: Object.fromEntries(scores) }, 200);
			},
		)
		.openapi(
			createRoute({
				method: 'get',
				path: '/t/{tenant}/p/{project}/algorithms/top',
				summary: 'Top nodes by a persisted metric',
				security: SECURITY,
				middleware: [requireGraph(cfg, 'read')],
				request: { params: scopeParams, query: topNodesQuerySchema },
				responses: { 200: json('OK', z.array(topNodeSchema)), ...READ_ERRORS },
			}),
			async (c) => {
				return c.json(await topNodes(c.get('graph').raw, c.req.valid('query')), 200);
			},
		)
		// Machine-readable HTTP contract (§14), GENERATED from the route definitions above —
		// paths, parameters, request bodies and response schemas all come from the same objects
		// the routes validate against, so the contract cannot drift from what is served.
		// Unauthenticated + tenant-agnostic, like /health.
		.doc31('/openapi.json', {
			openapi: '3.1.0',
			info: { title: cfg.openapi?.title ?? 'graphx', version: cfg.openapi?.version ?? '0.1.0' },
			...(cfg.openapi?.servers ? { servers: cfg.openapi.servers } : {}),
			security: [{ bearerAuth: [] }],
		});
	app.onError(onError);
	return app;
}

/**
 * The app type the typed client consumes: `hc<AppType>(url)`.
 *
 * IMPORTANT — known limitation. This package compiles with `isolatedDeclarations`, which
 * cannot emit Hono's *inferred* per-route RPC schema into `.d.ts` (that schema is produced
 * by whole-program inference over the `.openapi(...).openapi(...)` chain; probed as TS9007/TS9010).
 * So the published `AppType` is the app at the ENV level only. From the built `.d.ts`,
 * `hc<AppType>(url)` is RUNTIME-correct (paths/bodies match the wire Zod contracts) but
 * NOT statically typed: `client.t[...]` request bodies and `res.json()` rows resolve to
 * `unknown`. The §14 "typed client, no codegen" benefit therefore requires consuming the
 * SOURCE rather than the package types: `const app = createApp(cfg); export type AppType =
 * typeof app;` in a module WITHOUT `isolatedDeclarations` recovers full per-route types.
 */
export type AppType = OpenAPIHono<ServeEnv<GraphSchema>>;

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
	app: OpenAPIHono<ServeEnv<S>>;
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
export function createApp<S extends GraphSchema>(cfg: ServeConfig<S>): OpenAPIHono<ServeEnv<S>>;
export function createApp<S extends GraphSchema>(
	cfg: ServeConfig<S> | DevServeConfig<S>,
): OpenAPIHono<ServeEnv<S>> | Promise<CreateAppResult<S>> {
	if ('control' in cfg && cfg.control) return buildApp(cfg as ServeConfig<S>);
	return bootstrapDevApp(cfg as DevServeConfig<S>);
}
