import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { get, type Meta } from './api.ts';
import './styles.css';

const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
});

function Root() {
	const meta = useQuery({ queryKey: ['meta'], queryFn: () => get<Meta>('/metro/meta') });
	if (meta.isError)
		return <div className="boot">Can't reach the metro API: {String(meta.error)}</div>;
	if (!meta.data) return <div className="boot">Connecting…</div>;
	return <App meta={meta.data} />;
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<Root />
		</QueryClientProvider>
	</StrictMode>,
);
