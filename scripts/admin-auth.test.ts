import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { setupAdminAuth } from './admin-auth.ts';

test('admin auth bootstrap creates a usable account once and preserves organization ownership', async () => {
	const database = new Database(':memory:');
	try {
		const options = {
			database,
			baseURL: 'http://localhost:8899',
			email: 'admin@example.test',
			password: 'development-password',
		};
		const first = await setupAdminAuth(options);
		const organization = await first.ensureOrganization('Acme', 'acme');
		const second = await setupAdminAuth(options);
		expect(second.userId).toBe(first.userId);
		expect(await second.ensureOrganization('Acme', 'acme')).toBe(organization);
		const session = await second.auth.api.signInEmail({
			body: { email: options.email, password: options.password },
		});
		expect(session.user.id).toBe(first.userId);
		await expect(
			(await second.auth.$context).adapter.findOne({
				model: 'member',
				where: [
					{ field: 'userId', value: first.userId },
					{ field: 'organizationId', value: organization },
				],
			}),
		).resolves.toMatchObject({ role: 'owner' });
	} finally {
		database.close();
	}
});
