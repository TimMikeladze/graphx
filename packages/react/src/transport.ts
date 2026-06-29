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
	const res = await doFetch(url, { method: opts.method, headers, body });

	if (!res.ok) {
		const parsed = (await res.json().catch(() => null)) as {
			error?: string;
			issues?: unknown;
		} | null;
		throw new GraphError(res.status, parsed?.error ?? res.statusText, parsed?.issues);
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}
