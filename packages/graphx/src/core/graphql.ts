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
	/**
	 * Query GraphiQL opens with on a first visit. Default: a sample that reads the schema and the
	 * first nodes. The dev `createApp` fills in its own tenant and project, so it runs as is.
	 */
	defaultQuery?: string;
}

/** The GraphiQL starter query, run against `tenant`/`project` (literal ids, or `$tenant`/`$project`). */
export function sampleQuery(scope?: { tenant: string; project: string }): string {
	const t = scope ? JSON.stringify(scope.tenant) : '$tenant';
	const p = scope ? JSON.stringify(scope.project) : '$project';
	const head = scope
		? 'query Sample {'
		: '# Set tenant and project in the Variables pane below.\nquery Sample($tenant: String!, $project: String!) {';
	return `# graphx over GraphQL: every REST route is a field. Open Docs (top left) for all of them.
# Press the run button (Cmd/Ctrl+Enter).
${head}
  getSchema(tenant: ${t}, project: ${p}) {
    nodes { type }
    edges { rel }
  }
  listNodes(tenant: ${t}, project: ${p}, limit: 5) {
    nodes { id type data }
    nextCursor
  }
}
`;
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
			// GraphiQL is served below, with graphx's own starter query.
			graphiql: false,
			title: opts.title,
			// The app's own `cors` middleware already ran; don't add a second set of headers.
			cors: false,
			context: (request: Request) => ({ headers: request.headers }),
		});
	};

	return async (request) => {
		const url = new URL(request.url);
		if (
			opts.graphiql !== false &&
			request.method === 'GET' &&
			!url.searchParams.has('query') &&
			(request.headers.get('accept') ?? '').includes('text/html')
		) {
			try {
				const { renderGraphiQL } = await import('openapi-x-graphql');
				const html = renderGraphiQL({
					endpoint: path,
					title: opts.title,
					defaultQuery: opts.defaultQuery ?? sampleQuery(),
				});
				return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
			} catch (err) {
				if (!isMissingModule(err)) throw err;
				return missingPackage();
			}
		}
		handler ??= build();
		try {
			return await (
				await handler
			)(request);
		} catch (err) {
			if (isMissingModule(err)) {
				handler = undefined;
				return missingPackage();
			}
			throw err;
		}
	};
}

function missingPackage(): Response {
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

function isMissingModule(err: unknown): boolean {
	const e = err as { code?: string; message?: string };
	return (
		e?.code === 'ERR_MODULE_NOT_FOUND' ||
		e?.code === 'MODULE_NOT_FOUND' ||
		/Cannot find (module|package) ['"]?openapi-x-graphql/.test(e?.message ?? '')
	);
}
