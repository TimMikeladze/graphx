// GraphQL over the serving app (docs/graphql.md). The schema is generated from the app's own
// OpenAPI document by `openapi-x-graphql` (an optional peer, imported only when enabled), and every
// resolver dispatches the HTTP request it describes back into the same app in-process — so
// validation, authn, authz, limits and error mapping are the REST route's, not a second copy.

/** `graphql` option on {@link import('./serve.ts').ServeConfig}. */
export interface GraphQLOptions {
	/** Endpoint path. Default `/graphql`. */
	path?: string;
	/** Serve GraphiQL on a browser `GET` of the endpoint. Default `true`. */
	graphiql?: boolean;
}

/** The parts of an `OpenAPIHono` app this module needs. */
export interface GraphQLHost {
	fetch: (request: Request) => Response | Promise<Response>;
	getOpenAPI31Document: (config: {
		openapi: '3.1.0';
		info: { title: string; version: string };
	}) => unknown;
}

// Origin of dispatched requests. Never leaves the process — `fetch` below routes it to the app.
const INTERNAL_ORIGIN = 'http://graphx.internal';

// Headers that describe the GraphQL request itself, not the caller — never copied onto a route call.
const SKIP_HEADERS = new Set([
	'accept',
	'accept-encoding',
	'connection',
	'content-length',
	'content-type',
	'host',
	'transfer-encoding',
]);

/**
 * Build a `(Request) => Promise<Response>` that serves GraphQL for `host`. The schema is built on
 * the first call and cached; a missing `openapi-x-graphql` install answers 501 with the fix.
 */
export function createGraphQLEndpoint(
	host: GraphQLHost,
	opts: GraphQLOptions & { title: string; version: string },
): (request: Request) => Promise<Response> {
	const path = opts.path ?? '/graphql';
	let handler: Promise<(request: Request) => Promise<Response>> | undefined;

	const build = async () => {
		const { createGraphQLSchema, createGraphQLHandler } = await import('openapi-x-graphql');
		const document = host.getOpenAPI31Document({
			openapi: '3.1.0',
			info: { title: opts.title, version: opts.version },
		});
		const { schema } = await createGraphQLSchema(document as Record<string, unknown>, {
			baseUrl: INTERNAL_ORIGIN,
			// Same rule as MCP: a route without an operationId (health, ready, SSE events) is not
			// part of the callable surface.
			filter: (op) => Boolean(op.raw.operationId),
			includeInfoField: false,
			fetch: ((input: Request | string | URL, init?: RequestInit) =>
				Promise.resolve(host.fetch(new Request(input, init)))) as typeof fetch,
			// Forward the caller's identity (authorization, cookies, x-*) onto every route call.
			onRequest: (upstream, { context }) => {
				const caller = (context as { headers: Headers }).headers;
				const headers = new Headers(upstream.headers);
				for (const [k, v] of caller) {
					if (!SKIP_HEADERS.has(k) && !headers.has(k)) headers.set(k, v);
				}
				return new Request(upstream, { headers });
			},
		});
		return createGraphQLHandler(schema, {
			path,
			graphiql: opts.graphiql,
			title: opts.title,
			// The app's own `cors` middleware already ran; don't add a second set of headers.
			cors: false,
			context: (request: Request) => ({ headers: request.headers }),
		});
	};

	return async (request) => {
		handler ??= build();
		try {
			return await (
				await handler
			)(request);
		} catch (err) {
			if (isMissingModule(err)) {
				handler = undefined;
				return Response.json(
					{
						errors: [
							{
								message:
									'GraphQL needs the optional `openapi-x-graphql` package: install it next to graphx',
							},
						],
					},
					{ status: 501 },
				);
			}
			throw err;
		}
	};
}

function isMissingModule(err: unknown): boolean {
	const e = err as { code?: string; message?: string };
	return (
		e?.code === 'ERR_MODULE_NOT_FOUND' ||
		e?.code === 'MODULE_NOT_FOUND' ||
		/Cannot find (module|package) ['"]?openapi-x-graphql/.test(e?.message ?? '')
	);
}
