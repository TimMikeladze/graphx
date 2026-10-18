import type { Database } from 'bun:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { createGraphxAuth } from '../packages/graphx/src/better-auth/index.ts';

export interface AdminAuthOptions {
	database: Database;
	baseURL: string;
	email: string;
	password: string;
	secret?: string;
	onInvitation?: (email: string, url: string) => void;
}

/** Development bootstrap. Existing accounts and passwords are left intact on restart. */
export async function setupAdminAuth(options: AdminAuthOptions) {
	const auth = createGraphxAuth(
		{
			database: options.database,
			baseURL: options.baseURL,
			secret: options.secret ?? 'graphx-admin-development-secret-change-before-deploying',
			emailAndPassword: { enabled: true },
			rateLimit: { enabled: false },
			telemetry: { enabled: false },
		},
		{
			development: true,
			organization: {
				sendInvitationEmail: async (invitation, request) => {
					const origin =
						request?.headers.get('origin') ?? process.env.ADMIN_UI_URL ?? 'http://localhost:5173';
					const url = new URL('/', origin);
					url.searchParams.set('invitation', invitation.id);
					options.onInvitation?.(invitation.email, url.toString());
				},
			},
		},
	);
	await (await getMigrations(auth.options)).runMigrations();
	const adapter = (await auth.$context).adapter;
	const existing = await adapter.findOne<{ id: string }>({
		model: 'user',
		where: [{ field: 'email', value: options.email.toLowerCase() }],
	});
	const userId =
		existing?.id ??
		(
			await auth.api.createUser({
				body: { email: options.email, name: 'Admin', password: options.password, role: 'admin' },
			})
		).user.id;
	async function ensureOrganization(name: string, slug: string): Promise<string> {
		const organization = await adapter.findOne<{ id: string }>({
			model: 'organization',
			where: [{ field: 'slug', value: slug }],
		});
		if (organization) return organization.id;
		const created = await auth.api.createOrganization({ body: { name, slug, userId } });
		if (!created) throw new Error(`Could not create organization ${slug}`);
		return created.id;
	}
	return { auth, userId, ensureOrganization };
}
