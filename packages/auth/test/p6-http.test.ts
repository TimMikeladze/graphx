import { expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { makeTestDb } from '../../core/test/harness.ts';
import type { DbClient } from '../../core/src/dialect.ts';
import { Graph, init } from '../../core/src/index.ts';
import { Auth } from '../src/auth.ts';
import { createAuthApp } from '../src/http.ts';
import { defineAuthModel, rel } from '../src/model.ts';

const MODEL = defineAuthModel({ user: {}, doc: { editor: rel(), viewer: rel().or('editor') } });

async function freshApp(): Promise<{ db: DbClient; app: ReturnType<typeof createAuthApp> }> {
	const db = makeTestDb().client;
	await init(db, 4);
	const auth = new Auth(new Graph(db, MODEL.schema), MODEL);
	const app = createAuthApp({
		// L1 authn: require a bearer token, else throw → 401
		authenticate: (c) => {
			if (!c.req.header('authorization')) throw new Error('no token');
			return { svc: 'app' };
		},
		// resolve the engine; deny writes for a "reader" token → 403
		resolveAuth: (c, _principal, op) => {
			if (op === 'write' && c.req.header('authorization') === 'Bearer reader') {
				throw new HTTPException(403, { message: 'read-only' });
			}
			return auth;
		},
	});
	return { db, app };
}

const H = { authorization: 'Bearer writer', 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createAuthApp>, path: string, body: unknown, headers = H) =>
	app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

test('P6: /tuples writes, then /check reflects it', async () => {
	const { db, app } = await freshApp();
	const w = await post(app, '/tuples', {
		writes: [{ object: 'doc:1', relation: 'editor', subject: 'user:alice' }],
	});
	expect(w.status).toBe(200);
	expect(await w.json()).toEqual({ ok: true });

	const r = await post(app, '/check', {
		object: 'doc:1',
		relation: 'viewer',
		subject: 'user:alice',
	});
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ allowed: true }); // via editor⇒viewer
	db.close();
});

test('P6: /check is false for a non-grant', async () => {
	const { db, app } = await freshApp();
	const r = await post(app, '/check', { object: 'doc:1', relation: 'viewer', subject: 'user:bob' });
	expect(await r.json()).toEqual({ allowed: false });
	db.close();
});

test('P6: 401 when authn throws (no token)', async () => {
	const { db, app } = await freshApp();
	const r = await post(
		app,
		'/check',
		{ object: 'doc:1', relation: 'viewer', subject: 'user:a' },
		{
			'content-type': 'application/json',
		},
	);
	expect(r.status).toBe(401);
	db.close();
});

test('P6: 403 when resolveAuth denies the op', async () => {
	const { db, app } = await freshApp();
	const r = await post(
		app,
		'/tuples',
		{ writes: [{ object: 'doc:1', relation: 'editor', subject: 'user:a' }] },
		{ authorization: 'Bearer reader', 'content-type': 'application/json' },
	);
	expect(r.status).toBe(403);
	db.close();
});

test('P6: 400 on a malformed body', async () => {
	const { db, app } = await freshApp();
	const r = await post(app, '/check', { object: 'doc:1' }); // missing relation/subject
	expect(r.status).toBe(400);
	db.close();
});

test('P6: 400 on an unknown relation (model validation)', async () => {
	const { db, app } = await freshApp();
	const r = await post(app, '/check', { object: 'doc:1', relation: 'owner', subject: 'user:a' });
	expect(r.status).toBe(400);
	db.close();
});

test('P6: /expand returns the userset tree', async () => {
	const { db, app } = await freshApp();
	await post(app, '/tuples', {
		writes: [{ object: 'doc:1', relation: 'editor', subject: 'user:alice' }],
	});
	const r = await post(app, '/expand', { object: 'doc:1', relation: 'viewer' });
	expect(r.status).toBe(200);
	const tree = await r.json();
	// doc.viewer = union(self, computed(editor)); editor leaf has alice
	expect(tree).toEqual({
		type: 'union',
		children: [
			{ type: 'leaf', subjects: [], usersets: [] },
			{ type: 'leaf', subjects: ['user:alice'], usersets: [] },
		],
	});
	db.close();
});

test('P6: /list-objects returns a page', async () => {
	const { db, app } = await freshApp();
	await post(app, '/tuples', {
		writes: [
			{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
			{ object: 'doc:2', relation: 'editor', subject: 'user:alice' },
		],
	});
	const r = await post(app, '/list-objects', {
		subject: 'user:alice',
		relation: 'viewer',
		type: 'doc',
	});
	expect(r.status).toBe(200);
	expect(await r.json()).toEqual({ objects: ['doc:1', 'doc:2'], nextCursor: null });
	db.close();
});

test('P6: /list-objects paginates via limit + cursor', async () => {
	const { db, app } = await freshApp();
	await post(app, '/tuples', {
		writes: [
			{ object: 'doc:1', relation: 'viewer', subject: 'user:alice' },
			{ object: 'doc:2', relation: 'viewer', subject: 'user:alice' },
		],
	});
	const p1 = await (
		await post(app, '/list-objects', {
			subject: 'user:alice',
			relation: 'viewer',
			type: 'doc',
			limit: 1,
		})
	).json();
	expect(p1).toEqual({ objects: ['doc:1'], nextCursor: 'doc:1' });
	const p2 = await (
		await post(app, '/list-objects', {
			subject: 'user:alice',
			relation: 'viewer',
			type: 'doc',
			limit: 1,
			cursor: 'doc:1',
		})
	).json();
	expect(p2).toEqual({ objects: ['doc:2'], nextCursor: 'doc:2' });
	db.close();
});

test('P6: 403 when resolveAuth throws a plain (non-HTTPException) error', async () => {
	const db = makeTestDb().client;
	await init(db, 4);
	const _auth = new Auth(new Graph(db, MODEL.schema), MODEL);
	const app = createAuthApp({
		authenticate: () => ({ svc: 'app' }),
		resolveAuth: () => {
			throw new Error('boom'); // plain error → requireAuth maps to 403
		},
	});
	const r = await app.request('/check', {
		method: 'POST',
		headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
		body: JSON.stringify({ object: 'doc:1', relation: 'viewer', subject: 'user:a' }),
	});
	expect(r.status).toBe(403);
	db.close();
});

test('P6: 400 on a negative limit (schema rejects it before the engine)', async () => {
	const { db, app } = await freshApp();
	const r = await post(app, '/list-objects', {
		subject: 'user:alice',
		relation: 'viewer',
		type: 'doc',
		limit: -1,
	});
	expect(r.status).toBe(400);
	db.close();
});
