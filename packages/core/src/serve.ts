import type { DbClient } from './dialect.ts';
import { zValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
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
import type { Kind, Rel } from './define-graph-schema.ts';
import type { MetricsSink, QueryLimits } from './governance.ts';
import { type AddEdgeInput, type AddNodeInput, Graph, type GraphSchema } from './graph.ts';
import { hybridRetrieve } from './hybrid.ts';
import { journey } from './journey.ts';
import { match, type PatternBuilder } from './pattern.ts';
import { type EmbedFn, retrieve } from './retrieve.ts';
import { changeFeed, diff, history } from './temporal.ts';
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
	 * journey route) applies it, so the HTTP read surfaces return props in the latest schema
	 * shape over the wire. Omit ⇒ raw stored props (pre-P12 behavior).
	 */
	upcasters?: UpcasterRegistry;
	/**
	 * P15 (§19.6) metrics sink. When set, read routes increment a per-tenant query counter
	 * (`graphx_queries_total`) and journey/retrieve observe traversal + slow-query histograms.
	 * Omit ⇒ no metrics, zero overhead (additive — behavior byte-identical to pre-P15).
	 */
	metrics?: MetricsSink;
	/**
	 * P15 (§19.6) readiness latch gating `/ready` (the load-balancer health gate). Build one with
	 * {@link createReadiness}, serve immediately (`/ready` → 503), run `syncIfReplica(...)` for the
	 * served namespaces ("sync-before-serve"), then call `markReady()` (`/ready` → 200). Omit ⇒
	 * ready immediately (the non-replica case — there is no sync to wait on).
	 */
	readiness?: Readiness;
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
): Promise<Graph<S>> {
	const { client } = await resolveProjectDb(control, principal, projectId, op);
	return new Graph(client, schema, upcasters);
}

// --- wire contracts (the Zod schema is the single source feeding every surface) ---

const directionSchema = z.enum(['forward', 'reverse', 'both']);

/** POST /nodes body. `props` is validated per-kind by `Graph.addNode` (ZodError → 400). */
const nodeInputSchema = z.object({
	kind: z.string(),
	props: z.record(z.string(), z.unknown()).default({}),
	emb: z.array(z.number()).optional(),
	body: z.string().optional(),
	uri: z.string().optional(),
	content_hash: z.string().optional(),
	content_type: z.string().optional(),
});

/** PATCH /nodes/:id body — every field optional; `Graph.updateNode` merges onto the live version. */
const patchNodeSchema = z.object({
	kind: z.string().optional(),
	props: z.record(z.string(), z.unknown()).optional(),
	emb: z.array(z.number()).optional(),
	body: z.string().optional(),
	uri: z.string().optional(),
	content_hash: z.string().optional(),
	embed_hash: z.string().optional(),
	content_type: z.string().optional(),
});

/** POST /edges body. `src`/`dst` are ULID node ids; props validated per-rel by `addEdge`. */
const edgeInputSchema = z.object({
	rel: z.string(),
	src: z.string(),
	dst: z.string(),
	weight: z.number().nonnegative().optional(), // mirror the DB CHECK(weight >= 0) at the wire layer
	props: z.record(z.string(), z.unknown()).optional(),
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

/** GET /nodes query — kind/full-text/as-of filters + keyset pagination. */
const nodeListQuerySchema = z.object({
	kind: z.string().optional(),
	q: z.string().optional(),
	asOf: z.coerce.number().optional(),
	limit: z.coerce.number().optional(),
	cursor: z.string().optional(),
});

/** GET /graph query — kind/full-text/as-of filters for the canvas slice. */
const graphSliceQuerySchema = z.object({
	kind: z.string().optional(),
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
const centralitySchema = z.object({ kind: z.enum(['degree', 'in', 'out']).optional() });

/** GET /algorithms/top query — `by` is whitelisted to the persisted metric columns. */
const topNodesQuerySchema = z.object({
	by: z.enum(['pagerank', 'community', 'degree']),
	kind: z.string().optional(),
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
			z.object({ node: z.object({ alias: z.string(), kind: z.string() }) }),
			z.object({ edge: z.object({ rel: z.string(), direction: patternDirectionSchema.optional() }) }),
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

/** One POST /bulk row. `kind`/`props` validated per-kind by `bulkLoad` (unknown kind / bad props → 400). */
const bulkRowSchema = z.object({
	kind: z.string(),
	props: z.record(z.string(), z.unknown()).default({}),
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
		const graph = await graphForProject(
			cfg.control,
			principal,
			project,
			op,
			cfg.schema,
			cfg.upcasters,
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
	if (err instanceof HTTPException) return err.getResponse();
	if (err instanceof AuthzError) return c.json({ error: err.message }, err.status);
	if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
	// Graph.updateNode/deleteEdge on a missing id -> the target doesn't exist (404, not 400).
	if (/^(updateNode|deleteEdge): no live version/.test(err.message)) {
		return c.json({ error: err.message }, 404);
	}
	// Graph.addNode/addEdge (unknown kind/rel, endpoint-kind mismatch), bulkLoad (unknown
	// kind), and a malformed PatternBuilder program throw a prefixed `Error` on bad input —
	// those are client errors.
	if (/^(add(Node|Edge)|bulkLoad|PatternBuilder):/.test(err.message)) {
		return c.json({ error: err.message }, 400);
	}
	// Constraint violations that slip past wire validation are bad input, not a server
	// fault: a FK to a non-existent node (unconstrained rel skips the kind check),
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
	const app = new Hono<ServeEnv<S>>()
		// §19.6 ops endpoints — UNAUTHENTICATED + tenant-agnostic by construction: mounted
		// OUTSIDE the `/t/:tenant/p/:project/*` authn group, so they never touch the
		// confused-deputy guard. /health = process up (always 200); /ready gates the load
		// balancer on the sync-before-serve latch (default ready when no latch is configured).
		.get('/health', (c) => c.json({ status: 'ok' }))
		.get('/ready', (c) => {
			const ready = cfg.readiness ? cfg.readiness.isReady() : true;
			return c.json({ status: ready ? 'ready' : 'not-ready' }, ready ? 200 : 503);
		})
		.use('/t/:tenant/p/:project/*', authn(cfg))
		.post(
			'/t/:tenant/p/:project/nodes',
			requireGraph(cfg, 'write'),
			zValidator('json', nodeInputSchema),
			async (c) => {
				const node = await c.get('graph').addNode(c.req.valid('json') as AddNodeInput<S, Kind<S>>);
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
		// Edit a node's props/metadata in place (conditional-close successor, §19.1). Returns
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
				const { kind, q, asOf, limit, cursor } = c.req.valid('query');
				const page = await c
					.get('graph')
					.listNodes({ kind, q, asOf, limit, cursor, limits: cfg.limits });
				return c.json(page);
			},
		)
		.get(
			'/t/:tenant/p/:project/graph',
			requireGraph(cfg, 'read'),
			zValidator('query', graphSliceQuerySchema),
			async (c) => {
				const { kind, q, asOf } = c.req.valid('query');
				const slice = await c.get('graph').graphSlice({ kind, q, asOf, limits: cfg.limits });
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
		// Batch node ingestion (§19.8). Validates every row up front (unknown kind / bad props →
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
				const builder = match(cfg.schema, c.get('graph').raw, cfg.upcasters) as PatternBuilder<
					S,
					Record<string, Kind<S>>
				>;
				for (const step of steps) {
					if ('node' in step) builder.node(step.node.alias, step.node.kind as Kind<S>);
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
					c.req.valid('json').kind as CentralityKind | undefined,
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
 * Build the serving app for `cfg`. Mount it (e.g. `Bun.serve({ fetch: app.fetch })`)
 * and consume it with the typed client `hc<AppType>(url)`. The returned value is the
 * fully chained app, so a same-module `typeof` recovers precise route types.
 */
export function createApp<S extends GraphSchema>(cfg: ServeConfig<S>): Hono<ServeEnv<S>> {
	return buildApp(cfg);
}
