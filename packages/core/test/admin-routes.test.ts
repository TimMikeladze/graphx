import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Principal } from '../src/authz.ts';
import type { DbClient } from '../src/dialect.ts';
import { makeTestDb } from './harness.ts';
import { addMembership, createProject, createTenant, createUser, initControl } from '../src/control-plane.ts';
import { evict } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { createApp } from '../src/serve.ts';

const SCHEMA = defineGraphSchema({
	nodes: { device: z.object({ type: z.string() }), person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' }, owns: { from: 'person', to: 'device' } },
});

// authenticate: x-admin-token => operator principal scoped to the route tenant; else x-user/x-tenant.
function authenticate(c: {
	req: { header: (n: string) => string | undefined; param: (n: string) => string };
}): Principal {
	if (c.req.header('x-admin-token') === 'secret') {
		return { userId: 'operator', tenantId: c.req.param('tenant'), operator: true };
	}
	const userId = c.req.header('x-user');
	const tenantId = c.req.header('x-tenant');
	if (!userId || !tenantId) throw new Error('missing auth');
	return { userId, tenantId };
}

interface Setup {
	control: DbClient;
	app: ReturnType<typeof createApp<typeof SCHEMA>>;
	tenantA: string;
	editor: string;
	pA: string;
	nsA: string;
}

async function setup(): Promise<Setup> {
	const control = makeTestDb().client;
	await initControl(control);
	const tenantA = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenantA, role: 'editor' });
	const nsA = `ns_${ulid().toLowerCase()}`;
	const pA = await createProject(control, { tenantId: tenantA, name: 'Alpha', dbNamespace: nsA });
	const app = createApp({ control, schema: SCHEMA, authenticate });
	return { control, app, tenantA, editor, pA, nsA };
}

function cleanup(s: Setup): void {
	evict(s.nsA);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${s.nsA}.db${sfx}`, { force: true });
	s.control.close();
}

function hdr(s: Setup): Record<string, string> {
	return { 'x-user': s.editor, 'x-tenant': s.tenantA, 'content-type': 'application/json' };
}

async function addNode(s: Setup, body: unknown): Promise<string> {
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		method: 'POST',
		headers: hdr(s),
		body: JSON.stringify(body),
	});
	return (await res.json()).id;
}

test('GET /nodes lists nodes and filters by type', async () => {
	const s = await setup();
	await addNode(s, { type: 'person', data: { name: 'p1' } });
	const d = await addNode(s, { type: 'device', data: { type: 'router' } });
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes?type=device`, { headers: hdr(s) });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.nodes.map((n: { id: string }) => n.id)).toEqual([d]);
	expect(body.nextCursor).toBeNull();
	cleanup(s);
});

test('GET /graph returns a {nodes,links,truncated} slice', async () => {
	const s = await setup();
	const p1 = await addNode(s, { type: 'person', data: { name: 'p1' } });
	const p2 = await addNode(s, { type: 'person', data: { name: 'p2' } });
	await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s),
		body: JSON.stringify({ rel: 'knows', src: p1, dst: p2 }),
	});
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/graph`, { headers: hdr(s) });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.nodes.length).toBe(2);
	expect(body.links[0]).toMatchObject({ source: p1, target: p2, rel: 'knows' });
	expect(body.truncated).toBe(false);
	cleanup(s);
});

test('GET /nodes/:id/history returns the version trail', async () => {
	const s = await setup();
	const id = await addNode(s, { type: 'person', data: { name: 'p1' } });
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${id}/history`, { headers: hdr(s) });
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.versions.length).toBe(1);
	expect(String(body.versions[0].id)).toBe(id);
	cleanup(s);
});

test('GET /nodes with a malformed cursor -> 400', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes?cursor=not-base64-json`, { headers: hdr(s) });
	expect(res.status).toBe(400);
	cleanup(s);
});

test('operator token reads a tenant graph with no membership row -> 200', async () => {
	const s = await setup();
	await addNode(s, { type: 'person', data: { name: 'p1' } });
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		headers: { 'x-admin-token': 'secret' },
	});
	expect(res.status).toBe(200);
	expect((await res.json()).nodes.length).toBe(1);
	cleanup(s);
});
