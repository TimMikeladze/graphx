import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from '~/app';
import './index.css';

const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ThemeProvider defaultTheme="dark">
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<App />
				</TooltipProvider>
			</QueryClientProvider>
		</ThemeProvider>
	</StrictMode>,
);
