import { type BetterAuthOptions } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { type DbClient, defineGraphSchema } from 'graphx';
import { createBetterAuthApp, createGraphxAuth } from 'graphx/better-auth';
import { z } from 'zod';

export async function configure(database: BetterAuthOptions['database'], control: DbClient) {
	const auth = createGraphxAuth(
		{
			database,
			baseURL: 'https://example.test',
			user: { additionalFields: { favoriteColor: { type: 'string', required: false } } },
			plugins: [twoFactor()],
		},
		{ apiKey: { rateLimit: { enabled: true, maxRequests: 100, timeWindow: 60_000 } } },
	);
	const schema = defineGraphSchema({ nodes: { note: z.object({ title: z.string() }) }, edges: {} });
	const app = await createBetterAuthApp({ auth, control, schema });
	const headers = new Headers();
	await auth.api.enableTwoFactor({ headers, body: { password: 'password' } });
	await auth.api.createOrgRole({
		headers,
		body: { organizationId: 'org', role: 'reader', permission: { graph: ['read'] } },
	});
	await auth.api.createTeam({ headers, body: { organizationId: 'org', name: 'Editors' } });
	await auth.api.createApiKey({
		body: {
			configId: 'graphx',
			organizationId: 'org',
			userId: 'user',
			permissions: { graph: ['read'] },
		},
	});
	const session = await auth.api.getSession({ headers });
	const color: string | null | undefined = session?.user.favoriteColor;
	// @ts-expect-error Unknown user fields must not become `any` through the auth wrapper.
	const unknown = session?.user.fieldThatDoesNotExist;
	return { app, color, unknown };
}
