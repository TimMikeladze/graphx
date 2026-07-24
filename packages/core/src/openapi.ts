import { z } from 'zod';
import { WIRE_SCHEMAS as wire } from './serve.ts';

/**
 * OpenAPI 3.1 document generator for the serving layer (§14 contract / DX). The request bodies and
 * query parameters are derived from the SAME Zod wire schemas the routes validate against (via
 * `z.toJSONSchema`), so the contract can never drift from validation. The route list itself is
 * asserted against the live Hono `app.routes` by a test, so adding a route without documenting it
 * fails CI. Responses are described coarsely — the SDK returns domain types (not Zod-validated
 * output), so success bodies are `object`/`array` rather than precise schemas; the typed contract
 * for those is `@graphx/react` / the SDK types.
 *
 * Mount it at `GET /openapi.json` (done in `serve.ts`) or call directly to emit a static spec.
 */

export interface OpenApiOptions {
	title?: string;
	version?: string;
	/** OpenAPI `servers` list, e.g. `[{ url: 'https://api.example.com' }]`. */
	servers?: Array<{ url: string; description?: string }>;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

interface RouteMeta {
	method: Method;
	/** OpenAPI-templated path under the tenant/project prefix, e.g. `/nodes/{id}`. */
	path: string;
	op: 'read' | 'write';
	summary: string;
	query?: z.ZodType;
	body?: z.ZodType;
	success: 200 | 201 | 204;
	/** Success response media type. Default `application/json`; the SSE route is `text/event-stream`. */
	contentType?: string;
	/** Route returns 501 when a required capability is unconfigured (e.g. `/events` without an outbox). */
	notImplemented?: boolean;
}

const PREFIX = '/t/{tenant}/p/{project}';

/** The documented route table — kept in lockstep with `serve.ts` by `openapi.test.ts`'s drift check. */
function routes(): RouteMeta[] {
	return [
		{ method: 'post', path: '/nodes', op: 'write', summary: 'Create a node', body: wire.nodeInput, success: 201 },
		{ method: 'get', path: '/nodes', op: 'read', summary: 'List nodes (keyset paginated)', query: wire.nodeListQuery, success: 200 },
		{ method: 'get', path: '/nodes/{id}', op: 'read', summary: 'Get a node by id', success: 200 },
		{ method: 'patch', path: '/nodes/{id}', op: 'write', summary: 'Update a node', body: wire.patchNode, success: 200 },
		{ method: 'delete', path: '/nodes/{id}', op: 'write', summary: 'Retract a node', success: 204 },
		{ method: 'post', path: '/edges', op: 'write', summary: 'Create an edge', body: wire.edgeInput, success: 201 },
		{ method: 'delete', path: '/edges/{id}', op: 'write', summary: 'Delete an edge', success: 204 },
		{ method: 'get', path: '/nodes/{id}/neighbors', op: 'read', summary: 'Neighbors (unpaginated)', query: wire.neighborQuery, success: 200 },
		{ method: 'get', path: '/nodes/{id}/neighborsPage', op: 'read', summary: 'Neighbors (keyset paginated)', query: wire.neighborPageQuery, success: 200 },
		{ method: 'get', path: '/nodes/{id}/content', op: 'read', summary: 'Live content payload (body + provenance)', success: 200 },
		{ method: 'get', path: '/nodes/{id}/history', op: 'read', summary: 'Version trail for a node', success: 200 },
		{ method: 'get', path: '/graph', op: 'read', summary: 'Canvas slice (nodes + links)', query: wire.graphSliceQuery, success: 200 },
		{ method: 'get', path: '/retrieve', op: 'read', summary: 'GraphRAG vector retrieve', query: wire.retrieveQuery, success: 200 },
		{ method: 'post', path: '/hybrid', op: 'read', summary: 'Hybrid retrieve (ANN + FTS + RRF + MMR)', body: wire.hybridInput, success: 200 },
		{ method: 'post', path: '/journey', op: 'read', summary: 'Time-respecting traversal', body: wire.journeyInput, success: 200 },
		{ method: 'post', path: '/match', op: 'read', summary: 'Multi-hop pattern query', body: wire.matchInput, success: 200 },
		{ method: 'post', path: '/bulk', op: 'write', summary: 'Bulk-load nodes', body: wire.bulkInput, success: 201 },
		{ method: 'get', path: '/changes', op: 'read', summary: 'Change feed / CDC tail', query: wire.changesQuery, success: 200 },
		{ method: 'get', path: '/events', op: 'read', summary: 'Live event stream (SSE, delete-inclusive)', query: wire.eventsQuery, success: 200, contentType: 'text/event-stream', notImplemented: true },
		{ method: 'get', path: '/diff', op: 'read', summary: 'Snapshot delta over (t1, t2]', query: wire.diffQuery, success: 200 },
		{ method: 'post', path: '/algorithms/shortest-path', op: 'read', summary: 'Shortest path', body: wire.shortestPath, success: 200 },
		{ method: 'post', path: '/algorithms/pagerank', op: 'write', summary: 'PageRank (persists)', body: wire.pageRank, success: 200 },
		{ method: 'post', path: '/algorithms/community', op: 'write', summary: 'Community detection (persists)', body: wire.community, success: 200 },
		{ method: 'post', path: '/algorithms/centrality', op: 'write', summary: 'Degree centrality (persists)', body: wire.centrality, success: 200 },
		{ method: 'get', path: '/algorithms/top', op: 'read', summary: 'Top nodes by a persisted metric', query: wire.topNodesQuery, success: 200 },
	];
}

function jsonSchema(s: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(s, { target: 'openapi-3.0' }) as Record<string, unknown>;
}

/** Lower a Zod query schema into a list of OpenAPI `parameters` (one per top-level property). */
function queryParameters(s: z.ZodType): Array<Record<string, unknown>> {
	const schema = jsonSchema(s);
	const data = (schema.properties as Record<string, unknown>) ?? {};
	const required = new Set((schema.required as string[]) ?? []);
	return Object.entries(data).map(([name, propSchema]) => ({
		name,
		in: 'query',
		required: required.has(name),
		schema: propSchema,
	}));
}

const ERROR_SCHEMA = {
	type: 'object',
	properties: { error: { type: 'string' }, issues: {} },
	required: ['error'],
} as const;

function errorRef() {
	return { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
}

function operationId(method: Method, path: string): string {
	const slug = path.replace(/[{}]/g, '').replace(/[/-]+/g, '_').replace(/^_|_$/g, '');
	return `${method}_${slug || 'root'}`;
}

/** Build the OpenAPI 3.1 document for the serving layer. */
export function buildOpenApiDocument(opts: OpenApiOptions = {}): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};

	for (const r of routes()) {
		const fullPath = `${PREFIX}${r.path}`;
		const hasId = r.path.includes('{id}');
		const pathItem = (paths[fullPath] ??= {
			parameters: [
				{ name: 'tenant', in: 'path', required: true, schema: { type: 'string' } },
				{ name: 'project', in: 'path', required: true, schema: { type: 'string' } },
				...(hasId ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] : []),
			],
		});

		const responses: Record<string, unknown> = {};
		responses[String(r.success)] =
			r.success === 204
				? { description: 'No Content' }
				: { description: 'OK', content: { [r.contentType ?? 'application/json']: { schema: {} } } };
		if (r.body || r.query) responses['400'] = errorRef();
		responses['401'] = { description: 'Unauthenticated' };
		if (r.op === 'write') responses['403'] = { description: 'Forbidden' };
		responses['404'] = errorRef();
		if (r.notImplemented) responses['501'] = errorRef();

		pathItem[r.method] = {
			summary: r.summary,
			operationId: operationId(r.method, r.path),
			security: [{ bearerAuth: [] }],
			...(r.query ? { parameters: queryParameters(r.query) } : {}),
			...(r.body
				? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(r.body) } } } }
				: {}),
			responses,
		};
	}

	return {
		openapi: '3.1.0',
		info: { title: opts.title ?? 'graphx', version: opts.version ?? '0.1.0' },
		...(opts.servers ? { servers: opts.servers } : {}),
		security: [{ bearerAuth: [] }],
		components: {
			securitySchemes: {
				// `cfg.authenticate` is the injection point — bearer is the documented default; swap
				// the scheme to match your deployment (session cookie, hashed API key, etc.).
				bearerAuth: { type: 'http', scheme: 'bearer' },
			},
			schemas: { Error: ERROR_SCHEMA },
		},
		paths,
	};
}
