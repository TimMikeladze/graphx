import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import {
	createApiKey,
	createProject,
	createTenant,
	createUser,
	hashApiKey,
	initControl,
	listProjects,
	listTenants,
	listUsers,
} from '../src/control-plane.ts';
import { makeTestDb } from './harness.ts';

async function freshControl() {
	const control = makeTestDb().client;
	await initControl(control);
	return control;
}

test('listTenants returns created tenants by name', async () => {
	const control = await freshControl();
	await createTenant(control, { name: 'Globex' });
	await createTenant(control, { name: 'Acme' });
	const tenants = await listTenants(control);
	expect(tenants.map((t) => t.name)).toEqual(['Acme', 'Globex']);
	expect(tenants[0].id.length).toBe(26);
	control.close();
});

test('listProjects is scoped to one tenant', async () => {
	const control = await freshControl();
	const a = await createTenant(control, { name: 'A' });
	const b = await createTenant(control, { name: 'B' });
	await createProject(control, { tenantId: a, name: 'Alpha', dbNamespace: `ns_${ulid().toLowerCase()}` });
	await createProject(control, { tenantId: b, name: 'Beta', dbNamespace: `ns_${ulid().toLowerCase()}` });
	const projA = await listProjects(control, a);
	expect(projA.map((p) => p.name)).toEqual(['Alpha']);
	expect(projA[0].dbNamespace.startsWith('ns_')).toBe(true);
	control.close();
});

test('listUsers returns created users by email', async () => {
	const control = await freshControl();
	await createUser(control, { email: 'b@test.dev' });
	await createUser(control, { email: 'a@test.dev' });
	const users = await listUsers(control);
	expect(users.map((u) => u.email)).toEqual(['a@test.dev', 'b@test.dev']);
	control.close();
});

test('createApiKey stores only the hash and returns the plaintext once', async () => {
	const control = await freshControl();
	const tenant = await createTenant(control, { name: 'Acme' });
	const { key } = await createApiKey(control, { tenantId: tenant, scopes: ['read'] });
	expect(key.startsWith('gxk_')).toBe(true);
	const stored = await control.execute('SELECT hash, tenant_id, scopes FROM api_keys');
	expect(stored.rows.length).toBe(1);
	expect(String(stored.rows[0].hash)).toBe(hashApiKey(key)); // only the hash is persisted
	expect(String(stored.rows[0].hash)).not.toBe(key);
	expect(JSON.parse(String(stored.rows[0].scopes))).toEqual(['read']);
	control.close();
});
