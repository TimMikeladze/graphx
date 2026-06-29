import { createContext, createElement, type ReactNode, useContext } from 'react';
import type { GraphTransport } from './transport.ts';

const GraphContext = createContext<GraphTransport | null>(null);

/** Props for {@link GraphProvider}: the transport config + children. `baseUrl` defaults to `''` (same-origin / in-process). */
export interface GraphProviderProps extends Omit<GraphTransport, 'baseUrl'> {
	baseUrl?: string;
	children: ReactNode;
}

/**
 * Supplies the per-project transport (baseUrl/tenant/project/headers/fetch) to every graphx hook
 * via context. Mount it INSIDE the app's `QueryClientProvider`:
 *
 * ```tsx
 * <QueryClientProvider client={qc}>
 *   <GraphProvider baseUrl={API} tenant={t} project={p} headers={() => ({ authorization })}>
 *     <App />
 *   </GraphProvider>
 * </QueryClientProvider>
 * ```
 */
export function GraphProvider({ children, baseUrl = '', ...rest }: GraphProviderProps) {
	const value: GraphTransport = { baseUrl, ...rest };
	return createElement(GraphContext.Provider, { value }, children);
}

/** Read the project transport off context; throws if used outside {@link GraphProvider}. */
export function useGraphTransport(): GraphTransport {
	const ctx = useContext(GraphContext);
	if (!ctx) throw new Error('graphx hooks must be used within <GraphProvider>');
	return ctx;
}
