/**
 * Project-scoped React Query key factory. Every key starts `['graphx', project, …]` so a
 * `QueryClient` shared across projects never cross-invalidates. The `neighbors`/`listNodes`/etc.
 * keys put their opaque opts LAST, so a no-opts call (`neighbors(id)`) is a strict prefix of the
 * opts-bearing query key — `invalidateQueries({ queryKey: neighbors(id) })` then matches every
 * filter variant (React Query does partial prefix matching by default).
 */
export function graphKeys(project: string) {
	const root = ['graphx', project] as const;
	return {
		all: root,
		node: (id: string) => [...root, 'node', id] as const,
		neighbors: (id: string, opts?: unknown) =>
			opts === undefined
				? ([...root, 'neighbors', id] as const)
				: ([...root, 'neighbors', id, opts] as const),
		history: (id: string) => [...root, 'history', id] as const,
		listNodes: (opts?: unknown) => [...root, 'listNodes', opts] as const,
		graphSlice: (opts?: unknown) => [...root, 'graphSlice', opts] as const,
		retrieve: (params: unknown) => [...root, 'retrieve', params] as const,
		hybrid: (body: unknown) => [...root, 'hybrid', body] as const,
		journey: (body: unknown) => [...root, 'journey', body] as const,
		match: (body: unknown) => [...root, 'match', body] as const,
		diff: (t1: number, t2: number) => [...root, 'diff', t1, t2] as const,
		shortestPath: (body: unknown) => [...root, 'algorithms', 'shortest-path', body] as const,
		topNodes: (query: unknown) => [...root, 'algorithms', 'top', query] as const,
		changes: () => [...root, 'changes'] as const,
	};
}

/** The shape returned by {@link graphKeys} — handy for typing manual-invalidation helpers. */
export type GraphKeys = ReturnType<typeof graphKeys>;
