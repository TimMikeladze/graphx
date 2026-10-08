import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { GraphProvider } from 'graphx/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { get, type Meta } from './api.ts';
import './styles.css';

const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
});

/**
 * `/city/meta` carries the dev principal (tenant, project, user). graphx's hooks get them through
 * an explicit `GraphProvider` rather than `bootstrap`, because the project changes when a
 * scenario is picked — every hook below then reads that scenario's branch.
 */
function Root() {
	const meta = useQuery({ queryKey: ['meta'], queryFn: () => get<Meta>('/city/meta') });
	if (meta.isError)
		return <div className="boot">Can't reach the city API: {String(meta.error)}</div>;
	if (!meta.data) return <div className="boot">Connecting…</div>;
	const m = meta.data;
	return (
		<GraphProvider
			tenant={m.tenant}
			project={m.project}
			headers={() => ({ 'x-user': m.user, 'x-tenant': m.tenant })}
		>
			<App meta={m} />
		</GraphProvider>
	);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<Root />
		</QueryClientProvider>
	</StrictMode>,
);
