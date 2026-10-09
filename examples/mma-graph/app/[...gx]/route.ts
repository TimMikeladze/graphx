import { mma } from '@/src/server/runtime';

/**
 * The graphx-generated HTTP surface, mounted as the root catch-all — static routes and pages
 * (`/`, `/fighters/…`, `/api/…`) take precedence, everything else lands here:
 *
 *   /t/{tenant}/p/{project}/…   the generated graph routes (nodes, edges, retrieval, match, …)
 *   /openapi.json, /docs        the generated OpenAPI document + interactive reference
 *   /graphql                    GraphQL over the same routes (GraphiQL on a browser GET)
 *   /health, /ready, /demo      liveness/readiness + the GraphProvider bootstrap payload
 *   /admin/…                    the operator control-plane app (createAdminApp)
 *
 * The Hono app is served through its standard `fetch` — Next's Request/Response are web
 * standard, so no adapter layer is needed.
 */
export const dynamic = 'force-dynamic';

type Handler = (req: Request) => Promise<Response>;

const handle: Handler = async (req) => {
	const { app } = await mma();
	return app.fetch(req);
};

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
