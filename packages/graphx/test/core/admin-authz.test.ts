import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { authorize, AuthzError } from '../../src/core/authz.ts';
import { createProject, createTenant, initControl } from '../../src/core/control-plane.ts';
import { makeTestDb } from './harness.ts';

async function controlWithProject() {
	const control = makeTestDb().client;
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const ns = `ns_${ulid().toLowerCase()}`;
	const project = await createProject(control, {
		tenantId: tenant,
		name: 'Alpha',
		dbNamespace: ns,
	});
	return { control, tenant, project, ns };
}

test('operator principal bypasses membership check and resolves the namespace', async () => {
	const { control, tenant, project, ns } = await controlWithProject();
	// No membership row exists for this operator user at all.
	const res = await authorize(
		control,
		{ userId: 'operator', tenantId: tenant, operator: true },
		project,
		'write',
	);
	expect(res.dbNamespace).toBe(ns);
	control.close();
});

test('operator still cannot reach a project outside the principal tenant (404, no leak)', async () => {
	const { control, project } = await controlWithProject();
	await expect(
		authorize(
			control,
			{ userId: 'operator', tenantId: 'some-other-tenant', operator: true },
			project,
			'read',
		),
	).rejects.toBeInstanceOf(AuthzError);
	control.close();
});

test('non-operator with no membership is still 403', async () => {
	const { control, tenant, project } = await controlWithProject();
	await expect(
		authorize(control, { userId: 'nobody', tenantId: tenant }, project, 'read'),
	).rejects.toMatchObject({ status: 403 });
	control.close();
});
