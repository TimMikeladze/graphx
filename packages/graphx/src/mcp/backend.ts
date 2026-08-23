/**
 * The seam between MCP tool calls and graphx's serving layer. Handlers are never
 * reimplemented here: a tool call becomes an HTTP request, and the only difference between
 * running against a local graph and a deployed one is who answers that request.
 *
 * `localBackend` dispatches straight into a Hono app — Hono routes a `Request` to a
 * `Response` without a socket — so the local path runs the *same* authn, authz, upcasting,
 * and governance middleware as production, because it is that middleware.
 */

/** Optional request parts for a {@link Backend} call. */
export interface BackendInit {
	/** Query-string pairs, already stringified. Omitted keys produce no parameter. */
	query?: Record<string, string>;
	/** JSON request body. `undefined` sends no body. */
	body?: unknown;
}

/** One method: a graphx HTTP request, however it is delivered. */
export interface Backend {
	call(method: string, path: string, init?: BackendInit): Promise<Response>;
}

/** The structural bit of a Hono app the local backend needs. */
export interface FetchLike {
	fetch(req: Request): Response | Promise<Response>;
}

/** Config for {@link remoteBackend}. `fetch` is injectable for tests. */
export interface RemoteBackendConfig {
	/** Base URL of a running graphx server, with or without a trailing slash. */
	url: string;
	/** Bearer credential. Omit when the deployment authenticates some other way. */
	apiKey?: string;
	/** Override the fetch implementation (tests). Defaults to the global. */
	fetch?: (req: Request) => Promise<Response>;
}

/** `?a=1&b=2`, or `''` when there is nothing to encode. */
function queryString(query: Record<string, string> | undefined): string {
	if (!query) return '';
	const params = new URLSearchParams(query);
	const s = params.toString();
	return s ? `?${s}` : '';
}

function buildRequest(
	url: string,
	method: string,
	init: BackendInit | undefined,
	headers: Record<string, string>,
): Request {
	const hasBody = init?.body !== undefined;
	return new Request(url, {
		method,
		headers: hasBody ? { 'content-type': 'application/json', ...headers } : headers,
		body: hasBody ? JSON.stringify(init?.body) : undefined,
	});
}

/**
 * In-process backend. `headers` are attached to every request — a dev app reads
 * `x-user`/`x-tenant`, a production app reads whatever its `authenticate` expects.
 * The origin is a placeholder: Hono routes on the path and never dials it.
 */
export function localBackend(app: FetchLike, headers: Record<string, string> = {}): Backend {
	return {
		call: (method, path, init) =>
			Promise.resolve(
				app.fetch(
					buildRequest(
						`http://graphx.local${path}${queryString(init?.query)}`,
						method,
						init,
						headers,
					),
				),
			),
	};
}

/** HTTP backend against a deployed graphx server. */
export function remoteBackend(cfg: RemoteBackendConfig): Backend {
	const base = cfg.url.replace(/\/+$/, '');
	const doFetch = cfg.fetch ?? ((req: Request) => fetch(req));
	const headers: Record<string, string> = cfg.apiKey
		? { authorization: `Bearer ${cfg.apiKey}` }
		: {};
	return {
		call: (method, path, init) =>
			doFetch(buildRequest(`${base}${path}${queryString(init?.query)}`, method, init, headers)),
	};
}
