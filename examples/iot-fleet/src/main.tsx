import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GraphProvider } from 'graphx-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const queryClient = new QueryClient();

// `bootstrap="/demo"` fetches the seeded { tenant, project, user } from the dev server and wires the
// transport (incl. the x-user/x-tenant auth headers) itself — no Boot component, no hardcoded ids.
createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<GraphProvider
				bootstrap="/demo"
				fallback={<p style={{ padding: 20, fontFamily: 'system-ui' }}>connecting…</p>}
			>
				<App />
			</GraphProvider>
		</QueryClientProvider>
	</StrictMode>,
);
