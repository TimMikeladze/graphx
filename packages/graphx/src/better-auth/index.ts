import { APIError, type BetterAuthOptions } from 'better-auth';
import { originCheckMiddleware } from 'better-auth/api';
import { role } from 'better-auth/plugins/access';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { authorize, AuthzError, type Principal } from '../core/authz.ts';
import { createProject } from '../core/control-plane.ts';
import type { DbClient } from '../core/dialect.ts';
import type { GraphSchema } from '../core/graph.ts';
import { applyConnPragmas } from '../core/runtime.ts';
import { createApp, type ServeConfig } from '../core/serve.ts';
import { resolveOriginContext } from './origins.ts';
import { betterAuthPaths } from './openapi.ts';
import { liveApiKey } from './api-key-state.ts';
import { granted, listGrants, validSubject } from './project-access.ts';
export type { ProjectGrant } from './project-access.ts';

export {
	createGraphxAuth,
	graphxAccessControl,
	graphxRoles,
	type GraphxAuth,
	type GraphxAuthOptions,
} from './preset.ts';

/** Structural so configured Better Auth instances can retain their additional plugins and fields. */
export interface GraphxBetterAuth {
	handler(request: Request): Promise<Response>;
	options: BetterAuthOptions;
	$context: Promise<{
		options: BetterAuthOptions;
		trustedOrigins: string[];
		isTrustedOrigin(origin: string): boolean;
		authCookies: { sessionToken: { name: string } };
		adapter: {
			findOne(input: {
				model: string;
				where: Array<{ field: string; value: string }>;
			}): Promise<unknown>;
		};
	}>;
	api: {
		getSession(input: {
			headers: Headers;
			query: { disableCookieCache: boolean };
			returnHeaders: true;
		}): Promise<{
			headers: Headers;
			response: { user: { id: string } } | null;
		}>;
		hasPermission(input: {
			headers: Headers;
			body: { organizationId: string; permissions: { graph: Permission[] } };
		}): Promise<{ success: boolean }>;
		verifyApiKey(input: { headers: Headers; body: { configId: string; key: string } }): Promise<{
			valid: boolean;
			key: { id: string; referenceId: string; permissions?: unknown } | null;
		}>;
	};
}

export interface BetterAuthServeConfig<S extends GraphSchema> extends Omit<
	ServeConfig<S>,
	'authenticate' | 'reauthenticate' | 'authorizeTenant' | 'authorizeProject'
> {
	auth: GraphxBetterAuth;
	/** Require direct/team grants or explicit API-key project scopes. Defaults to false. */
	projectAccess?: boolean;
	/** Defaults to `NODE_ENV === 'development'`. Allows credentialed CORS from any origin in development. */
	development?: boolean;
}

/** Creates only Graphx's registry. Better Auth organizations supply tenant IDs. */
export async function initBetterAuthControl(control: DbClient): Promise<void> {
	await applyConnPragmas(control);
	await control.executeMultiple(`CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
		name TEXT NOT NULL, db_namespace TEXT NOT NULL UNIQUE
	);
	CREATE TABLE IF NOT EXISTS project_grants (
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		subject_type TEXT NOT NULL CHECK(subject_type IN ('user', 'team')),
		subject_id TEXT NOT NULL,
		role TEXT NOT NULL CHECK(role IN ('reader', 'editor')),
		PRIMARY KEY(project_id, subject_type, subject_id)
	);`);
}

type Proof = { headers: Headers } | { permissions: Record<string, string[]>; keyId: string };
type Permission = 'read' | 'write' | 'manage';

function permissions(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	if (
		!Object.values(value).every(
			(actions) => Array.isArray(actions) && actions.every((action) => typeof action === 'string'),
		)
	)
		return {};
	return value as Record<string, string[]>;
}

/** Mounts Better Auth and the graph API with organization permissions and no mirrored identity tables. */
export async function createBetterAuthApp<S extends GraphSchema>(
	cfg: BetterAuthServeConfig<S>,
): Promise<Hono> {
	await initBetterAuthControl(cfg.control);
	const { auth } = cfg;
	const projectAccess = cfg.projectAccess ?? false;
	const proofs = new WeakMap<Principal, Proof>();
	const development = cfg.development ?? process.env.NODE_ENV === 'development';
	const authContext = await auth.$context;

	async function authenticate(c: Context): Promise<Principal> {
		const tenantId = c.req.param('tenant');
		if (!tenantId) throw new Error('missing organization');
		const headers = new Headers(c.req.raw.headers);
		if (!headers.has('host')) headers.set('host', new URL(c.req.url).host);
		const explicitKey = c.req.header('x-api-key');
		const authorization = c.req.header('authorization');
		// An explicit credential must not fall back to a different user's cookie session.
		if (authorization) headers.delete('cookie');
		if (explicitKey === undefined) {
			const session = await auth.api.getSession({
				headers,
				query: { disableCookieCache: true },
				returnHeaders: true,
			});
			for (const cookie of session.headers.getSetCookie())
				c.header('set-cookie', cookie, { append: true });
			if (session.response) {
				const principal = { userId: session.response.user.id, tenantId };
				proofs.set(principal, { headers });
				return principal;
			}
		}
		const key = explicitKey ?? authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
		if (!key) throw new Error('unauthenticated');
		const verified = await auth.api.verifyApiKey({ headers, body: { configId: 'graphx', key } });
		if (!verified.valid || !verified.key) throw new Error('unauthenticated');
		const organization = await authContext.adapter.findOne({
			model: 'organization',
			where: [{ field: 'id', value: verified.key.referenceId }],
		});
		if (!organization) throw new Error('unauthenticated');
		const principal = { userId: `api-key:${verified.key.id}`, tenantId: verified.key.referenceId };
		proofs.set(principal, {
			permissions: permissions(verified.key.permissions),
			keyId: verified.key.id,
		});
		return principal;
	}

	async function reauthenticate(c: Context, previous: Principal): Promise<Principal> {
		const proof = proofs.get(previous);
		if (!proof || !('permissions' in proof)) return authenticate(c);
		const key = await liveApiKey(auth, proof.keyId, previous.tenantId);
		const organization = await authContext.adapter.findOne({
			model: 'organization',
			where: [{ field: 'id', value: previous.tenantId }],
		});
		if (!organization) throw new Error('unauthenticated');
		const principal = { userId: previous.userId, tenantId: previous.tenantId };
		proofs.set(principal, { keyId: proof.keyId, permissions: permissions(key.permissions) });
		return principal;
	}

	async function authorizePermission(principal: Principal, permission: Permission): Promise<void> {
		const proof = proofs.get(principal);
		if (!proof) throw new AuthzError(403, 'forbidden');
		if ('permissions' in proof) {
			// The same evaluator Better Auth uses in verifyApiKey; verification consumes a key's allowance only once.
			if (!role(proof.permissions).authorize({ graph: [permission] }).success)
				throw new AuthzError(403, 'forbidden');
			return;
		}
		try {
			const result = await auth.api.hasPermission({
				headers: proof.headers,
				body: { organizationId: principal.tenantId, permissions: { graph: [permission] } },
			});
			if (!result.success) throw new AuthzError(403, 'forbidden');
		} catch (error) {
			if (error instanceof APIError) throw new AuthzError(403, 'forbidden');
			throw error;
		}
	}

	async function permitted(principal: Principal, permission: Permission): Promise<boolean> {
		try {
			await authorizePermission(principal, permission);
			return true;
		} catch (error) {
			if (error instanceof AuthzError && error.status === 403) return false;
			throw error;
		}
	}

	async function authorizeProject(
		principal: Principal,
		projectId: string,
		op: Permission,
	): Promise<void> {
		if (!projectAccess) return;
		const proof = proofs.get(principal);
		if (!proof) throw new AuthzError(403, 'forbidden');
		if ('permissions' in proof) {
			if (!proof.permissions.project?.includes(projectId)) throw new AuthzError(403, 'forbidden');
			return;
		}
		if (await permitted(principal, 'manage')) return;
		if (
			op === 'manage' ||
			!(await granted(
				cfg.control,
				authContext.adapter,
				principal.tenantId,
				principal.userId,
				projectId,
				op,
			))
		)
			throw new AuthzError(403, 'forbidden');
	}

	async function projectPrincipal(
		c: Context,
	): Promise<{ principal: Principal; projectId: string }> {
		let principal: Principal;
		try {
			principal = await authenticate(c);
		} catch {
			throw new HTTPException(401, { message: 'unauthenticated' });
		}
		const projectId = c.req.param('project')!;
		if (principal.tenantId !== c.req.param('tenant'))
			throw new AuthzError(404, 'project not found');
		// Check project ownership before probing permissions or grants; this never opens its DB.
		await authorize(cfg.control, principal, projectId, 'read', async () => {});
		return { principal, projectId };
	}

	async function projectManager(c: Context): Promise<{ principal: Principal; projectId: string }> {
		const result = await projectPrincipal(c);
		await authorizePermission(result.principal, 'manage');
		await authorizeProject(result.principal, result.projectId, 'manage');
		return result;
	}

	const app = new Hono();
	if (cfg.cors !== false) {
		app.use(
			'*',
			cors(
				typeof cfg.cors === 'object'
					? cfg.cors
					: {
							credentials: true,
							origin: async (origin, c) => {
								return development ||
									(await resolveOriginContext(authContext, c.req.raw)).isTrustedOrigin(origin)
									? origin
									: undefined;
							},
						},
			),
		);
	}
	const authPath = (auth.options.basePath ?? '/api/auth').replace(/\/$/, '');
	app.all(`${authPath}/*`, (c) => auth.handler(c.req.raw));
	app.get('/auth-config', (c) =>
		c.json({ mode: 'better-auth', basePath: authPath, projectAccess }),
	);
	app.use('*', async (c, next) => {
		if (
			!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
			c.req.header('cookie') &&
			!c.req.header('authorization') &&
			c.req.header('x-api-key') === undefined
		) {
			try {
				const originContext = {
					request: c.req.raw,
					context: await resolveOriginContext(authContext, c.req.raw),
				};
				await originCheckMiddleware(originContext);
			} catch (error) {
				if (error instanceof APIError)
					throw new HTTPException(403, { message: 'untrusted origin' });
				throw error;
			}
		}
		await next();
	});

	const grantSchema = z.object({
		subjectType: z.enum(['user', 'team']),
		subjectId: z.string().min(1),
		role: z.enum(['reader', 'editor']),
	});
	app.get('/t/:tenant/p/:project/permissions', async (c) => {
		const { principal, projectId } = await projectPrincipal(c);
		const result = { read: false, write: false, manage: false };
		for (const op of ['read', 'write', 'manage'] as const) {
			if (!(await permitted(principal, op))) continue;
			try {
				await authorizeProject(principal, projectId, op);
				result[op] = true;
			} catch (error) {
				if (!(error instanceof AuthzError && error.status === 403)) throw error;
			}
		}
		return c.json(result);
	});
	app.get('/t/:tenant/p/:project/access', async (c) => {
		const { projectId } = await projectManager(c);
		return c.json({ grants: await listGrants(cfg.control, projectId) });
	});
	app.post('/t/:tenant/p/:project/access', async (c) => {
		const { principal, projectId } = await projectManager(c);
		const body = grantSchema.safeParse(await c.req.json());
		if (!body.success) return c.json({ error: 'validation', issues: body.error.issues }, 400);
		if (!(await validSubject(authContext.adapter, principal.tenantId, body.data)))
			return c.json({ error: 'subject is not in organization' }, 400);
		const { subjectType, subjectId, role: grantRole } = body.data;
		await cfg.control.execute({
			sql: 'INSERT INTO project_grants (project_id, subject_type, subject_id, role) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, subject_type, subject_id) DO UPDATE SET role = excluded.role',
			args: [projectId, subjectType, subjectId, grantRole],
		});
		return c.json({ grants: await listGrants(cfg.control, projectId) });
	});
	app.delete('/t/:tenant/p/:project/access/:subjectType/:subjectId', async (c) => {
		const { projectId } = await projectManager(c);
		const subjectType = z.enum(['user', 'team']).safeParse(c.req.param('subjectType'));
		if (!subjectType.success) return c.json({ error: 'invalid subject type' }, 400);
		await cfg.control.execute({
			sql: 'DELETE FROM project_grants WHERE project_id = ? AND subject_type = ? AND subject_id = ?',
			args: [projectId, subjectType.data, c.req.param('subjectId')],
		});
		return c.json({ grants: await listGrants(cfg.control, projectId) });
	});

	app.post('/t/:tenant/projects', async (c) => {
		let principal: Principal;
		try {
			principal = await authenticate(c);
		} catch {
			throw new HTTPException(401, { message: 'unauthenticated' });
		}
		if (principal.tenantId !== c.req.param('tenant')) throw new AuthzError(404, 'tenant not found');
		await authorizePermission(principal, 'manage');
		const body = z.object({ name: z.string().trim().min(1) }).safeParse(await c.req.json());
		if (!body.success) return c.json({ error: 'validation', issues: body.error.issues }, 400);
		const id = await createProject(cfg.control, {
			tenantId: principal.tenantId,
			name: body.data.name,
			dbNamespace: `gx_${ulid().toLowerCase()}`,
		});
		return c.json({ id }, 201);
	});

	const graph = createApp({
		...cfg,
		cors: false,
		authenticate,
		reauthenticate,
		authorizeTenant: authorizePermission,
		authorizeProject,
	});
	app.get('/openapi.json', async (c) => {
		const response = await graph.request(c.req.raw);
		const document = await response.json();
		const security: Array<Record<string, string[]>> = [
			{ sessionCookie: [] },
			{ bearerAuth: [] },
			{ apiKeyAuth: [] },
		];
		document.components.securitySchemes.sessionCookie = {
			type: 'apiKey',
			in: 'cookie',
			name: authContext.authCookies.sessionToken.name,
		};
		document.components.securitySchemes.apiKeyAuth = {
			type: 'apiKey',
			in: 'header',
			name: 'x-api-key',
		};
		document.security = security;
		for (const path of Object.values(document.paths) as Array<
			Record<string, { security?: unknown }>
		>) {
			for (const operation of Object.values(path))
				if (operation.security) operation.security = security;
		}
		document.paths['/t/{tenant}/projects'].post = {
			operationId: 'create_project',
			summary: 'Create a project in a Better Auth organization',
			security,
			parameters: [{ name: 'tenant', in: 'path', required: true, schema: { type: 'string' } }],
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							required: ['name'],
							properties: { name: { type: 'string', minLength: 1 } },
						},
					},
				},
			},
			responses: {
				201: {
					description: 'Project created',
					content: {
						'application/json': {
							schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
						},
					},
				},
				400: { description: 'Invalid request' },
				401: { description: 'Unauthenticated' },
				403: { description: 'Forbidden' },
			},
		};
		Object.assign(document.paths, betterAuthPaths(security));
		return c.json(document);
	});
	app.route('/', graph);
	app.onError((error, c) => {
		if (error instanceof HTTPException) return error.getResponse();
		if (error instanceof AuthzError) return c.json({ error: error.message }, error.status);
		if (error instanceof SyntaxError) return c.json({ error: 'invalid JSON' }, 400);
		return c.json({ error: 'internal' }, 500);
	});
	return app;
}
