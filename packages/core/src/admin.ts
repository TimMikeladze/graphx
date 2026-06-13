import type { Client } from '@libsql/client';
import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z, ZodError } from 'zod';
import {
	addMembership,
	createApiKey,
	createProject,
	createTenant,
	createUser,
	listProjects,
	listTenants,
	listUsers,
} from './control-plane.ts';

/**
 * The operator (admin) sub-app — control-plane registry CRUD, gated by an operator credential
 * and mounted by the deployment at `/admin` (`app.route('/admin', createAdminApp(cfg))`). This is
 * a SEPARATE auth realm from the tenant-scoped graph routes in `serve.ts`: there is no per-tenant
 * role here, only "is this caller an operator". `authenticate` is the single injection point — a
 * dev build compares a bearer/header token to a configured secret; production verifies a real
 * operator session/JWT. Throwing is surfaced as 401.
 */
export interface AdminConfig {
	/** The shared control-plane client (registry of tenants/projects/users/memberships/api_keys). */
	control: Client;
	/** Operator authn: verify the request is an operator. Throw to reject (mapped to 401). */
	authenticate: (c: Context) => void | Promise<void>;
}

const tenantBody = z.object({ name: z.string().min(1) });
const projectBody = z.object({ name: z.string().min(1), dbNamespace: z.string().min(1) });
const userBody = z.object({ email: z.string().min(3) });
const membershipBody = z.object({
	userId: z.string(),
	tenantId: z.string(),
	role: z.enum(['owner', 'editor', 'viewer']),
});
const apiKeyBody = z.object({ tenantId: z.string(), scopes: z.array(z.string()).default([]) });

/** Error map for the admin sub-app: Zod → 400, control-plane UNIQUE/FK → 400, else 500. */
function adminError(err: Error, c: Context) {
	if (err instanceof HTTPException) return err.getResponse();
	if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
	if (String((err as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT')) {
		return c.json({ error: 'constraint violation' }, 400);
	}
	return c.json({ error: 'internal' }, 500);
}

/** Build the operator-gated control-plane CRUD sub-app. Mount with `app.route('/admin', ...)`. */
export function createAdminApp(cfg: AdminConfig): Hono {
	const app = new Hono();
	app.use('*', async (c, next) => {
		try {
			await cfg.authenticate(c);
		} catch {
			throw new HTTPException(401, { message: 'unauthenticated' });
		}
		await next();
	});
	app
		.get('/tenants', async (c) => c.json({ tenants: await listTenants(cfg.control) }))
		.post('/tenants', zValidator('json', tenantBody), async (c) => {
			const id = await createTenant(cfg.control, c.req.valid('json'));
			return c.json({ id }, 201);
		})
		.get('/tenants/:id/projects', async (c) =>
			c.json({ projects: await listProjects(cfg.control, c.req.param('id')) }),
		)
		.post('/tenants/:id/projects', zValidator('json', projectBody), async (c) => {
			const { name, dbNamespace } = c.req.valid('json');
			const id = await createProject(cfg.control, { tenantId: c.req.param('id'), name, dbNamespace });
			return c.json({ id }, 201);
		})
		.get('/users', async (c) => c.json({ users: await listUsers(cfg.control) }))
		.post('/users', zValidator('json', userBody), async (c) => {
			const id = await createUser(cfg.control, c.req.valid('json'));
			return c.json({ id }, 201);
		})
		.post('/memberships', zValidator('json', membershipBody), async (c) => {
			await addMembership(cfg.control, c.req.valid('json'));
			return c.body(null, 204);
		})
		.post('/api-keys', zValidator('json', apiKeyBody), async (c) => {
			const { key } = await createApiKey(cfg.control, c.req.valid('json'));
			return c.json({ key }, 201);
		});
	app.onError(adminError);
	return app;
}
