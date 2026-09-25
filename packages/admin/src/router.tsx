import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { parseExplorerSearch } from '@/lib/explorer-search';
import { AdminPage } from '@/routes/admin-page';
import { ExplorerPage } from '@/routes/explorer-page';
import { IndexPage } from '@/routes/index-page';
import { ReviewPage } from '@/routes/review-page';
import { RootLayout } from '@/routes/root-layout';

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: IndexPage,
});

const explorerRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/t/$tenant/p/$project',
	// URL search params are the explorer's filter/selection state (spec §6).
	validateSearch: (search: Record<string, unknown>) => parseExplorerSearch(search),
	component: ExplorerPage,
});

/** The curator's queue for pairs Jev could not settle. `rel` picks the queue, `into` the accept rel. */
const reviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/t/$tenant/p/$project/review',
	validateSearch: (search: Record<string, unknown>): { rel?: string; into?: string } => ({
		rel: typeof search.rel === 'string' ? search.rel : undefined,
		into: typeof search.into === 'string' ? search.into : undefined,
	}),
	component: ReviewPage,
});

const adminRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/admin',
	component: AdminPage,
});

const routeTree = rootRoute.addChildren([indexRoute, explorerRoute, reviewRoute, adminRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
