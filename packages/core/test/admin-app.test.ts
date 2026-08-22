import { expect, test } from 'bun:test';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { ulid } from 'ulidx';
import { createAdminApp } from '../src/admin.ts';
import { initControl } from '../src/control-plane.ts';
import type { DbClient } from '../src/dialect.ts';
import { makeTestDb } from './harness.ts';

function operatorAuth(c: Context): void {
	if (c.req.header('x-admin-token') !== 'secret') throw new Error('forbidden');
}

interface Setup {
	control: DbClient;
	app: Hono;
}

async function setup(): Promise<Setup> {
	const control = makeTestDb().client;
	await initControl(control);
	// Mount under /admin exactly as the deployment does.
	const app = new Hono();
	app.route('/admin', createAdminApp({ control, authenticate: operatorAuth }));
	return { control, app };
}

const AUTH = { 'x-admin-token': 'secret', 'content-type': 'application/json' };

test('unauthenticated admin request -> 401', async () => {
	const s = await setup();
	const res = await s.app.request('/admin/tenants');
	expect(res.status).toBe(401);
	s.control.close();
});

test('create + list tenants round-trips', async () => {
	const s = await setup();
	const created = await s.app.request('/admin/tenants', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ name: 'Acme' }),
	});
	expect(created.status).toBe(201);
	const { id } = await created.json();
	expect(id.length).toBe(26);
	const list = await s.app.request('/admin/tenants', { headers: AUTH });
	expect((await list.json()).tenants).toEqual([{ id, name: 'Acme' }]);
	s.control.close();
});

test('create project under a tenant + list projects', async () => {
	const s = await setup();
	const t = await (
		await s.app.request('/admin/tenants', {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ name: 'Acme' }),
		})
	).json();
	const ns = `ns_${ulid().toLowerCase()}`;
	const created = await s.app.request(`/admin/tenants/${t.id}/projects`, {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ name: 'Alpha', dbNamespace: ns }),
	});
	expect(created.status).toBe(201);
	const list = await s.app.request(`/admin/tenants/${t.id}/projects`, { headers: AUTH });
	const { projects } = await list.json();
	expect(projects).toEqual([{ id: (await created.json()).id, name: 'Alpha', dbNamespace: ns }]);
	s.control.close();
});

test('create user, add membership (204), mint api-key (201, key once)', async () => {
	const s = await setup();
	const t = await (
		await s.app.request('/admin/tenants', {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ name: 'Acme' }),
		})
	).json();
	const u = await (
		await s.app.request('/admin/users', {
			method: 'POST',
			headers: AUTH,
			body: JSON.stringify({ email: 'a@test.dev' }),
		})
	).json();
	expect(u.id.length).toBe(26);

	const mem = await s.app.request('/admin/memberships', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ userId: u.id, tenantId: t.id, role: 'editor' }),
	});
	expect(mem.status).toBe(204);

	const key = await s.app.request('/admin/api-keys', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ tenantId: t.id, scopes: ['read'] }),
	});
	expect(key.status).toBe(201);
	expect((await key.json()).key.startsWith('gxk_')).toBe(true);
	s.control.close();
});

test('invalid body -> 400 (Zod validation mapped)', async () => {
	const s = await setup();
	const res = await s.app.request('/admin/tenants', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ name: '' }), // min(1) fails
	});
	expect(res.status).toBe(400);
	s.control.close();
});

test('duplicate user email -> 400 (constraint mapped, not 500)', async () => {
	const s = await setup();
	await s.app.request('/admin/users', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ email: 'dup@test.dev' }),
	});
	const again = await s.app.request('/admin/users', {
		method: 'POST',
		headers: AUTH,
		body: JSON.stringify({ email: 'dup@test.dev' }),
	});
	expect(again.status).toBe(400);
	s.control.close();
});
