import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { zValidator } from '@hono/zod-validator';
import { z, ZodError } from 'zod';
import type { Auth } from './auth.ts';

/** Operation class for a route — passed to `resolveAuth` so operators can gate writes. */
export type AuthOp = 'read' | 'write';

/** Per-request server config. `authenticate` is L1; `resolveAuth` yields the engine for the request. */
export interface AuthServeConfig {
	/** L1 authn: verify the request → an opaque principal. Throw to reject (mapped to 401). */
	authenticate: (c: Context) => unknown | Promise<unknown>;
	/**
	 * Resolve the {@link Auth} engine for this request and op (the operator owns tenant/project →
	 * `${project}__auth` namespace resolution + op-level authz). Throw an {@link HTTPException} for a
	 * precise status, or any error → 403.
	 */
	resolveAuth: (c: Context, principal: unknown, op: AuthOp) => Auth | Promise<Auth>;
}

/** Hono env: the per-request principal + the resolved engine. */
export type AuthEnv = { Variables: { principal: unknown; auth: Auth } };

const tupleSchema = z.object({
	object: z.string(),
	relation: z.string(),
	subject: z.string(),
	subjectRelation: z.string().optional(),
});
const tuplesBody = z.object({
	writes: z.array(tupleSchema).default([]),
	deletes: z.array(tupleSchema).default([]),
});
const checkBody = z.object({
	object: z.string(),
	relation: z.string(),
	subject: z.string(),
	asOf: z.number().int().nonnegative().optional(),
});
const expandBody = z.object({
	object: z.string(),
	relation: z.string(),
	asOf: z.number().int().nonnegative().optional(),
});
const listBody = z.object({
	subject: z.string(),
	relation: z.string(),
	type: z.string(),
	asOf: z.number().int().nonnegative().optional(),
	limit: z.number().int().positive().optional(),
	cursor: z.string().optional(),
});

function authn(cfg: AuthServeConfig): MiddlewareHandler<AuthEnv> {
	return createMiddleware<AuthEnv>(async (c, next) => {
		let principal: unknown;
		try {
			principal = await cfg.authenticate(c);
		} catch {
			throw new HTTPException(401, { message: 'unauthenticated' });
		}
		c.set('principal', principal);
		await next();
	});
}

function requireAuth(cfg: AuthServeConfig, op: AuthOp): MiddlewareHandler<AuthEnv> {
	return createMiddleware<AuthEnv>(async (c, next) => {
		let auth: Auth;
		try {
			auth = await cfg.resolveAuth(c, c.get('principal'), op);
		} catch (e) {
			if (e instanceof HTTPException) throw e;
			throw new HTTPException(403, { message: 'forbidden' });
		}
		c.set('auth', auth);
		await next();
	});
}

function onError(err: Error, c: Context): Response {
	if (err instanceof HTTPException) return err.getResponse();
	if (err instanceof ZodError) return c.json({ error: 'validation', issues: err.issues }, 400);
	// Model-validation errors (unknown type/relation, bad ref, ...) are caller input → 400.
	// `auth: unhandled rewrite` is an internal invariant violation → fall through to 500 (no leak).
	if (err.message.startsWith('auth:') && !err.message.includes('unhandled rewrite')) {
		return c.json({ error: err.message }, 400);
	}
	return c.json({ error: 'internal' }, 500);
}

/**
 * Build a standalone Hono app exposing the ReBAC engine. Mount it under your URL scheme,
 * e.g. `app.route('/t/:tenant/p/:project/auth', createAuthApp(cfg))`, and have `cfg.resolveAuth`
 * read the route params to select the project's auth engine.
 */
export function createAuthApp(cfg: AuthServeConfig): Hono<AuthEnv> {
	const app = new Hono<AuthEnv>()
		.post('/check', authn(cfg), requireAuth(cfg, 'read'), zValidator('json', checkBody), async (c) => {
			const { object, relation, subject, asOf } = c.req.valid('json');
			const allowed = await c.get('auth').check(object, relation, subject, { asOf });
			return c.json({ allowed });
		})
		.post('/tuples', authn(cfg), requireAuth(cfg, 'write'), zValidator('json', tuplesBody), async (c) => {
			const { writes, deletes } = c.req.valid('json');
			const auth = c.get('auth');
			if (writes.length > 0) await auth.write(writes);
			if (deletes.length > 0) await auth.delete(deletes);
			return c.json({ ok: true });
		})
		.post('/expand', authn(cfg), requireAuth(cfg, 'read'), zValidator('json', expandBody), async (c) => {
			const { object, relation, asOf } = c.req.valid('json');
			return c.json(await c.get('auth').expand(object, relation, { asOf }));
		})
		.post(
			'/list-objects',
			authn(cfg),
			requireAuth(cfg, 'read'),
			zValidator('json', listBody),
			async (c) => {
				const { subject, relation, type, asOf, limit, cursor } = c.req.valid('json');
				return c.json(await c.get('auth').listObjects(subject, relation, type, { asOf, limit, cursor }));
			},
		);
	app.onError(onError);
	return app;
}
