import {
	createContext,
	createElement,
	Fragment,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from 'react';
import type { GraphTransport } from './transport.ts';

const GraphContext = createContext<GraphTransport | null>(null);

/**
 * Props for {@link GraphProvider}. Two ways to identify the project:
 *
 * - **Explicit** — pass `tenant` + `project` (the production path; ids come from your auth/session).
 * - **Bootstrap** — pass a `bootstrap` URL (e.g. `createApp`'s `GET /demo`). The provider fetches
 *   `{ tenant, project, user }` from it on mount and wires the transport for you, so a dev app needs
 *   no hardcoded ids. Render a `fallback` while it resolves. The fetched `user` is sent as `x-user`
 *   (and `tenant` as `x-tenant`) so the dev server authenticates as the seeded principal.
 *
 * `baseUrl` defaults to `''` (same-origin / in-process via {@link appFetch}).
 */
export interface GraphProviderProps {
	baseUrl?: string;
	tenant?: string;
	project?: string;
	/** URL returning `{ tenant, project, user }` (e.g. `/demo`). Fetched on mount; supersedes `tenant`/`project`. */
	bootstrap?: string;
	/** Rendered while a `bootstrap` fetch is in flight (nothing by default). */
	fallback?: ReactNode;
	/** Per-request auth headers (JWT / session / API key). Re-invoked each call. */
	headers?: GraphTransport['headers'];
	/** Transport impl; defaults to `globalThis.fetch`. Use {@link appFetch} for an in-process app. */
	fetch?: typeof fetch;
	children: ReactNode;
}

function provide(value: GraphTransport, children: ReactNode) {
	return createElement(GraphContext.Provider, { value }, children);
}

/**
 * Supplies the per-project transport to every graphx hook via context. Mount it INSIDE the app's
 * `QueryClientProvider`:
 *
 * ```tsx
 * <QueryClientProvider client={qc}>
 *   <GraphProvider baseUrl={API} tenant={t} project={p} headers={() => ({ authorization })}>
 *     <App />
 *   </GraphProvider>
 * </QueryClientProvider>
 * ```
 *
 * Or, against a `createApp` dev server, skip the ids entirely:
 *
 * ```tsx
 * <GraphProvider bootstrap="/demo" fallback={<Spinner />}><App /></GraphProvider>
 * ```
 */
export function GraphProvider({
	children,
	baseUrl = '',
	tenant,
	project,
	bootstrap,
	fallback = null,
	headers,
	fetch: fetchProp,
}: GraphProviderProps) {
	if (bootstrap) {
		return createElement(BootstrapGate, {
			baseUrl,
			bootstrap,
			fallback,
			headers,
			fetch: fetchProp,
			children,
		});
	}
	if (!tenant || !project) {
		throw new Error('GraphProvider requires `tenant` + `project` (or a `bootstrap` URL)');
	}
	return provide({ baseUrl, tenant, project, headers, fetch: fetchProp }, children);
}

interface BootstrapGateProps {
	baseUrl: string;
	bootstrap: string;
	fallback: ReactNode;
	headers?: GraphTransport['headers'];
	fetch?: typeof fetch;
	children: ReactNode;
}

interface Session {
	tenant: string;
	project: string;
	user: string;
}

/** Fetches `{ tenant, project, user }` from the bootstrap URL once, then provides the transport. */
function BootstrapGate({
	baseUrl,
	bootstrap,
	fallback,
	headers,
	fetch: fetchProp,
	children,
}: BootstrapGateProps) {
	const [session, setSession] = useState<Session | null>(null);
	const [error, setError] = useState<Error | null>(null);
	// Read `fetch` through a ref so an inline `fetch={appFetch(app)}` (new identity every parent
	// render) does NOT retrigger the effect — the bootstrap is a one-time fetch per (baseUrl,
	// bootstrap), and depending on `fetchProp` would loop (refetch → setSession → re-render → …).
	const fetchRef = useRef(fetchProp);
	fetchRef.current = fetchProp;

	useEffect(() => {
		let cancelled = false;
		const f = fetchRef.current ?? globalThis.fetch;
		(async () => {
			try {
				const res = await f(`${baseUrl}${bootstrap}`);
				if (!res.ok) throw new Error(`bootstrap ${bootstrap} → ${res.status}`);
				const s = (await res.json()) as Session;
				if (!cancelled) setSession(s);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [baseUrl, bootstrap]);

	if (error) throw error; // surface a misconfigured bootstrap URL to an error boundary
	if (!session) return createElement(Fragment, null, fallback);

	// Authenticate as the bootstrapped principal by default; caller `headers` win on conflict.
	const identity = { 'x-user': session.user, 'x-tenant': session.tenant };
	const mergedHeaders: GraphTransport['headers'] = async () => ({
		...identity,
		...(headers ? await headers() : {}),
	});
	return provide(
		{
			baseUrl,
			tenant: session.tenant,
			project: session.project,
			headers: mergedHeaders,
			fetch: fetchProp,
		},
		children,
	);
}

/** Read the project transport off context; throws if used outside {@link GraphProvider}. */
export function useGraphTransport(): GraphTransport {
	const ctx = useContext(GraphContext);
	if (!ctx) throw new Error('graphx hooks must be used within <GraphProvider>');
	return ctx;
}
