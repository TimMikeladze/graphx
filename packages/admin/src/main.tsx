import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import './index.css';
import { ThemeProvider } from '@/components/theme-provider.tsx';
import { TooltipProvider } from '@/components/ui/tooltip';
import { router } from '@/router';

import { ApiError } from '@/lib/api';

/**
 * One retry for the flaky cases, none for the answered ones: a 4xx is the server's verdict, and
 * repeating the request cannot change it. This matters most after a retraction, where a stale
 * inspector would otherwise ask twice for a node that no longer has a live version.
 */
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			refetchOnWindowFocus: false,
			retry: (failureCount, error) => {
				if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
				return failureCount < 1;
			},
		},
	},
});

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ThemeProvider>
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<RouterProvider router={router} />
				</TooltipProvider>
			</QueryClientProvider>
		</ThemeProvider>
	</StrictMode>,
);
