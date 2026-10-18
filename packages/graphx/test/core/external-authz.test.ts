import { expect, test } from 'bun:test';
import { authorize, AuthzError, resolveProjectDb } from '../../src/core/authz.ts';
import { initControl, createProject, createTenant } from '../../src/core/control-plane.ts';
import { makeTestDb } from './harness.ts';

test('external authorization replaces local membership while preserving project ownership', async () => {
	const db = makeTestDb();
	try {
		await initControl(db.client);
		const tenant = await createTenant(db.client, { name: 'External' });
		const project = await createProject(db.client, {
			tenantId: tenant,
			name: 'P',
			dbNamespace: 'external',
		});
		const principal = { userId: 'external-user', tenantId: tenant };
		expect(await authorize(db.client, principal, project, 'read', async () => {})).toEqual({
			dbNamespace: 'external',
		});
		await expect(
			authorize(db.client, principal, project, 'write', async () => {
				throw new AuthzError(403, 'denied');
			}),
		).rejects.toMatchObject({ status: 403 });
		await expect(
			authorize(db.client, { ...principal, tenantId: 'other' }, project, 'read', async () => {}),
		).rejects.toMatchObject({ status: 404 });
	} finally {
		await db.teardown();
	}
});

test('project authorization runs after ownership and before opening a database', async () => {
	const db = makeTestDb();
	try {
		await initControl(db.client);
		const tenant = await createTenant(db.client, { name: 'Scoped' });
		const project = await createProject(db.client, {
			tenantId: tenant,
			name: 'P',
			dbNamespace: 'must-never-open',
		});
		let checks = 0;
		const deny = async () => {
			checks++;
			throw new AuthzError(403, 'project denied');
		};
		await expect(
			resolveProjectDb(
				db.client,
				{ userId: 'u', tenantId: tenant },
				project,
				'read',
				undefined,
				async () => {},
				deny,
			),
		).rejects.toMatchObject({ status: 403, message: 'project denied' });
		expect(checks).toBe(1);
		await expect(
			resolveProjectDb(
				db.client,
				{ userId: 'u', tenantId: 'other' },
				project,
				'read',
				undefined,
				async () => {},
				deny,
			),
		).rejects.toMatchObject({ status: 404 });
		expect(checks).toBe(1);
	} finally {
		await db.teardown();
	}
});
