import { GraphError } from './errors.ts';

/**
 * Transport config for one project. Supplied by {@link GraphProvider} via context; passed to
 * {@link request} on every call. `headers` is a getter (re-read per request so a refreshed token
 * is picked up); `fetch` defaults to the global — inject it for SSR or to point at an in-process
 * Hono app (`app.request`) in tests.
 */
export interface GraphTransport {
	/** Origin the server is mounted at, e.g. `https://api.example.com`. Empty string for same-origin / in-process. */
	baseUrl: string;
	tenant: string;
	project: string;
	/** Per-request auth headers (JWT / session / API key). Re-invoked each call. */
	headers?: () => Record<string, string> | Promise<Record<string, string>>;
	/** Transport impl; defaults to `globalThis.fetch`. */
	fetch?: typeof fetch;
}

/** One HTTP call against the project's route surface. */
export interface RequestOpts {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	/** Path under `/t/:tenant/p/:project`, e.g. `/nodes` or `/nodes/${id}/neighborsPage`. */
	path: string;
	/** Query params; `undefined` values are omitted, others coerced to strings. */
	query?: Record<string, unknown>;
	/** JSON request body (POST/PATCH). */
	body?: unknown;
}

/** The subset of a Hono app the {@link appFetch} adapter needs (kept structural so this package
 * pulls in no `hono` / `graphx-core` runtime — pass any object with a `request` method). */
export interface RequestLike {
	request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>;
}

/**
 * Adapt an in-process Hono app to a `fetch`, so `<GraphProvider fetch={appFetch(app)} baseUrl="">`
 * drives the hooks against real routes with NO server, port, or CORS. Ideal for tests and SSR: the
 * transport builds same-origin `/t/:tenant/...` paths, which `app.request` serves directly.
 *
 * ```ts
 * const { app, tenant, project } = await createApp({ schema });
 * render(<GraphProvider baseUrl="" tenant={tenant} project={project} fetch={appFetch(app)}><App/></GraphProvider>);
 * ```
 */
export function appFetch(app: RequestLike): typeof fetch {
	return ((input: string | URL | Request, init?: RequestInit) =>
		Promise.resolve(app.request(input, init))) as typeof fetch;
}

function qs(query: Record<string, unknown> | undefined): string {
	if (!query) return '';
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(query)) {
		if (v !== undefined && v !== null) params.set(k, String(v));
	}
	const s = params.toString();
	return s ? `?${s}` : '';
}

/**
 * Issue one request and map the response to the graphx contract: 2xx → parsed JSON (or `undefined`
 * for 204/empty), non-2xx → a thrown {@link GraphError} carrying the `onError` `{ error, issues }`
 * shape. The thrown error becomes the React Query `error` on a hook.
 */
export async function request<T>(t: GraphTransport, opts: RequestOpts): Promise<T> {
	const url = `${t.baseUrl}/t/${t.tenant}/p/${t.project}${opts.path}${qs(opts.query)}`;
	const headers: Record<string, string> = { ...(t.headers ? await t.headers() : {}) };
	let body: string | undefined;
	if (opts.body !== undefined) {
		body = JSON.stringify(opts.body);
		headers['content-type'] = 'application/json';
	}
	const doFetch = t.fetch ?? globalThis.fetch;
	let res: Response;
	try {
		res = await doFetch(url, { method: opts.method, headers, body });
	} catch (e) {
		// The server was unreachable / the request never completed (DNS, offline, CORS-blocked).
		// Surface it as a GraphError with status 0 (`code: 'network'`) so hooks classify it the same
		// way as HTTP errors, instead of a raw TypeError leaking through.
		throw new GraphError(0, e instanceof Error ? e.message : 'network error');
	}

	if (!res.ok) {
		// Read the body once as text, then try JSON. The serving layer returns `{ error, issues }`
		// JSON for most errors, but a bare string for some paths — fall back to the raw text so the
		// message is never lost (otherwise it collapses to the generic statusText).
		const raw = await res.text().catch(() => '');
		let message = res.statusText;
		let issues: unknown;
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as { error?: string; issues?: unknown };
				message = parsed.error ?? raw;
				issues = parsed.issues;
			} catch {
				message = raw;
			}
		}
		throw new GraphError(res.status, message, issues);
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}
