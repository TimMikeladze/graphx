import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GraphProvider } from '@graphx/react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const queryClient = new QueryClient();

interface Demo {
	tenant: string;
	project: string;
	user: string;
}

/** Fetch the seeded session ids from the server, then configure the provider. */
function Boot() {
	const [demo, setDemo] = useState<Demo | null>(null);
	useEffect(() => {
		fetch('/demo')
			.then((r) => r.json())
			.then(setDemo);
	}, []);
	if (!demo) return <p style={{ padding: 20, fontFamily: 'system-ui' }}>connecting…</p>;
	return (
		<GraphProvider
			baseUrl=""
			tenant={demo.tenant}
			project={demo.project}
			headers={() => ({ 'x-user': demo.user, 'x-tenant': demo.tenant })}
		>
			<App />
		</GraphProvider>
	);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<Boot />
		</QueryClientProvider>
	</StrictMode>,
);
