import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { getMigrations } from 'better-auth/db/migration';
import type { BetterAuthOptions } from 'better-auth';
import { Validator } from '@seriousme/openapi-schema-validator';
import { z } from 'zod';
import { createBetterAuthApp, createGraphxAuth } from '../../src/better-auth/index.ts';
import type { GraphxAuthOptions } from '../../src/better-auth/index.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { evict } from '../../src/core/db.ts';
import { makeTestDb, tableExistsSql } from '../core/harness.ts';

const schema = defineGraphSchema({ nodes: { note: z.object({ title: z.string() }) }, edges: {} });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

async function setup(
	config: {
		basePath?: string;
		development?: boolean;
		dynamicOrigins?: boolean | 'startup';
		graphql?: boolean;
		projectAccess?: boolean;
		events?: boolean;
		baseURL?: BetterAuthOptions['baseURL'];
		secondaryStorage?: BetterAuthOptions['secondaryStorage'];
		apiKey?: GraphxAuthOptions['apiKey'];
	} = {},
) {
	const {
		basePath = '/api/auth',
		development = false,
		dynamicOrigins = false,
		graphql = false,
		baseURL = 'http://localhost:8743',
	} = config;
	const authDb = new Database(':memory:');
	const auth = createGraphxAuth(
		{
			database: authDb,
			secondaryStorage: config.secondaryStorage,
			baseURL,
			basePath,
			secret: 'graphx-test-secret-that-is-at-least-32-bytes',
			emailAndPassword: { enabled: true },
			advanced: { disableOriginCheck: false },
			trustedOrigins: dynamicOrigins
				? async (request?: Request) =>
						request
							? ['http://localhost:3000', 'https://*.example.test']
							: dynamicOrigins === 'startup'
								? ['https://untrusted.example']
								: []
				: ['http://localhost:3000'],
			rateLimit: { enabled: false },
			telemetry: { enabled: false },
			logger: { disabled: true },
		},
		{ development, apiKey: config.apiKey },
	);
	await (await getMigrations(auth.options)).runMigrations();
	const control = makeTestDb();
	const app = await createBetterAuthApp({
		auth,
		control: control.client,
		schema,
		development,
		graphql,
		projectAccess: config.projectAccess,
		events: config.events ? { outbox: true } : undefined,
	});
	cleanup.push(async () => {
		const projects = await control.client.execute('SELECT db_namespace FROM projects');
		for (const row of projects.rows) evict(String(row.db_namespace));
		await control.teardown();
		authDb.close();
	});
	async function signup(name: string) {
		const response = await app.request(`http://localhost:8743${basePath}/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
			body: JSON.stringify({ name, email: `${name}@example.test`, password: 'test-password-123' }),
		});
		expect(response.status).toBe(200);
		const cookie = response.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.join('; ');
		const body = await response.json();
		return {
			headers: new Headers({ cookie, host: 'localhost:8743' }),
			user: body.user,
			token: body.token,
		};
	}
	const owner = await signup('owner');
	const org = await auth.api.createOrganization({
		headers: owner.headers,
		body: { name: 'Acme', slug: 'acme' },
	});
	async function request(path: string, headers: HeadersInit = owner.headers, body?: unknown) {
		const h = new Headers(headers);
		if (h.has('cookie') && body !== undefined) h.set('origin', 'http://localhost:3000');
		if (body !== undefined) h.set('content-type', 'application/json');
		return app.request(`http://localhost:8743${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: h,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
	const created = await request(`/t/${org!.id}/projects`, owner.headers, { name: 'Notes' });
	expect(created.status).toBe(201);
	const project = (await created.json()).id as string;
	const base = `/t/${org!.id}/p/${project}`;
	return {
		app,
		auth,
		authDb,
		control: control.client,
		owner,
		org: org!,
		project,
		base,
		signup,
		request,
	};
}

test('Better Auth owns identity; Graphx initializes only the project registry', async () => {
	const s = await setup();
	for (const table of ['users', 'tenants', 'memberships', 'api_keys']) {
		expect((await s.control.execute(tableExistsSql(s.control, table))).rows.length).toBe(0);
	}
	expect((await s.request(`${s.base}/nodes`)).status).toBe(200);
	const created = await s.request(`${s.base}/nodes`, s.owner.headers, {
		type: 'note',
		data: { title: 'Hello' },
	});
	expect(created.status).toBe(201);
	const node = await created.json();
	expect((await (await s.request(`${s.base}/nodes/${node.id}`)).json()).data.title).toBe('Hello');
	expect((await (await s.request(`/t/${s.org.id}/projects`)).json()).projects).toEqual([
		{ id: s.project, name: 'Notes' },
	]);
});

test('organization roles gate graph writes and project creation; role changes apply immediately', async () => {
	const s = await setup();
	const viewer = await s.signup('viewer');
	const member = await s.auth.api.addMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, userId: viewer.user.id, role: 'viewer' },
	});
	expect((await s.request(`${s.base}/nodes`, viewer.headers)).status).toBe(200);
	expect(
		(
			await s.request(`${s.base}/nodes`, viewer.headers, {
				type: 'note',
				data: { title: 'Denied' },
			})
		).status,
	).toBe(403);
	expect(
		(await s.request(`/t/${s.org.id}/projects`, viewer.headers, { name: 'Denied' })).status,
	).toBe(403);
	await s.auth.api.updateMemberRole({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, memberId: member!.id, role: 'member' },
	});
	expect(
		(
			await s.request(`${s.base}/nodes`, viewer.headers, {
				type: 'note',
				data: { title: 'Allowed' },
			})
		).status,
	).toBe(201);
	expect(
		(await s.request(`/t/${s.org.id}/projects`, viewer.headers, { name: 'Denied' })).status,
	).toBe(403);
	await s.auth.api.removeMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, memberIdOrEmail: member!.id },
	});
	expect((await s.request(`${s.base}/nodes`, viewer.headers)).status).toBe(403);
	expect((await s.request(`/t/${s.org.id}/projects`, viewer.headers)).status).toBe(403);
});

test('URL organization is checked even when the session has another active organization', async () => {
	const s = await setup();
	const other = await s.auth.api.createOrganization({
		headers: s.owner.headers,
		body: { name: 'Other', slug: 'other' },
	});
	await s.auth.api.setActiveOrganization({
		headers: s.owner.headers,
		body: { organizationId: other!.id },
	});
	expect((await s.request(`${s.base}/nodes`)).status).toBe(200);
	expect((await s.request(`/t/${other!.id}/p/${s.project}/nodes`)).status).toBe(404);
	const outsider = await s.signup('outsider');
	expect((await s.request(`${s.base}/nodes`, outsider.headers)).status).toBe(403);
	expect((await s.request(`${s.base}/nodes`, {})).status).toBe(401);
});

test('Better Auth dynamic roles supply graph permissions without local membership records', async () => {
	const s = await setup();
	const reader = await s.signup('dynamic-reader');
	await s.auth.api.createOrgRole({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, role: 'reader', permission: { graph: ['read'] } },
	});
	await s.auth.api.addMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, userId: reader.user.id, role: 'reader' },
	});
	expect((await s.request(`${s.base}/nodes`, reader.headers)).status).toBe(200);
	expect(
		(
			await s.request(`${s.base}/nodes`, reader.headers, {
				type: 'note',
				data: { title: 'Denied' },
			})
		).status,
	).toBe(403);
});

test('organization API keys enforce scopes, tenant isolation, revocation, and one verification per request', async () => {
	const s = await setup();
	const key = await s.auth.api.createApiKey({
		body: {
			configId: 'graphx',
			organizationId: s.org.id,
			userId: s.owner.user.id,
			permissions: { graph: ['read'] },
		},
	});
	const headers = { 'x-api-key': key.key };
	expect((await s.request(`${s.base}/nodes`, headers)).status).toBe(200);
	const stored = s.authDb.query('SELECT requestCount FROM apikey WHERE id = ?').get(key.id) as {
		requestCount: number;
	};
	expect(stored.requestCount).toBe(1);
	expect(
		(await s.request(`${s.base}/nodes`, headers, { type: 'note', data: { title: 'Denied' } }))
			.status,
	).toBe(403);
	expect((await s.request(`${s.base}/nodes`, { authorization: `Bearer ${key.key}` })).status).toBe(
		200,
	);
	expect((await s.request(`/t/other/p/${s.project}/nodes`, headers)).status).toBe(404);
	await s.auth.api.deleteApiKey({
		headers: s.owner.headers,
		body: { configId: 'graphx', keyId: key.id },
	});
	expect((await s.request(`${s.base}/nodes`, headers)).status).toBe(401);
});

test('keys without graph permissions are denied and an explicit bad key cannot fall back to cookies', async () => {
	const s = await setup();
	const key = await s.auth.api.createApiKey({
		body: { configId: 'graphx', organizationId: s.org.id, userId: s.owner.user.id },
	});
	expect((await s.request(`${s.base}/nodes`, { 'x-api-key': key.key })).status).toBe(403);
	const headers = new Headers(s.owner.headers);
	headers.set('x-api-key', 'invalid-api-key-that-is-long-enough');
	expect((await s.request(`${s.base}/nodes`, headers)).status).toBe(401);
	headers.delete('x-api-key');
	headers.set('authorization', 'Bearer invalid-api-key-that-is-long-enough');
	expect((await s.request(`${s.base}/nodes`, headers)).status).toBe(401);
});

test('bearer sessions are validated by Better Auth and revoked sessions stop working', async () => {
	const s = await setup();
	expect(
		(await s.request(`${s.base}/nodes`, { authorization: `Bearer ${s.owner.token}` })).status,
	).toBe(200);
	await s.auth.api.signOut({ headers: s.owner.headers });
	expect((await s.request(`${s.base}/nodes`, s.owner.headers)).status).toBe(401);
});

test('custom auth paths and credentialed CORS use Better Auth trusted origins', async () => {
	const s = await setup({ basePath: '/identity' });
	const allowed = await s.app.request('http://localhost:8743/identity/get-session', {
		headers: { origin: 'http://localhost:3000' },
	});
	expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
	expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
	const denied = await s.app.request(`http://localhost:8743${s.base}/nodes`, {
		headers: { origin: 'https://untrusted.example' },
	});
	expect(denied.headers.get('access-control-allow-origin')).toBeNull();
	const spec = await (await s.app.request('http://localhost:8743/openapi.json')).json();
	expect(spec.components.securitySchemes.sessionCookie.in).toBe('cookie');
	expect(spec.components.securitySchemes.apiKeyAuth.name).toBe('x-api-key');
	expect(spec.paths['/t/{tenant}/p/{project}/nodes'].get.security).toContainEqual({
		sessionCookie: [],
	});
	expect((await new Validator().validate(spec)).valid).toBe(true);
});

test('development accepts arbitrary origins for auth endpoints and graph requests', async () => {
	const s = await setup({ development: true });
	const response = await s.app.request('http://localhost:8743/api/auth/sign-in/email', {
		method: 'POST',
		headers: { origin: 'http://127.0.0.1:49371', 'content-type': 'application/json' },
		body: JSON.stringify({ email: 'owner@example.test', password: 'test-password-123' }),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:49371');
});

test('cookie mutations reject untrusted and missing origins before changing project or graph data', async () => {
	const s = await setup();
	for (const origin of ['https://untrusted.example', '']) {
		const headers = new Headers(s.owner.headers);
		headers.set('content-type', 'text/plain');
		if (origin) headers.set('origin', origin);
		const response = await s.app.request(`http://localhost:8743/t/${s.org.id}/projects`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ name: 'CSRF' }),
		});
		expect(response.status).toBe(403);
		headers.set('content-type', 'application/json');
		const graphResponse = await s.app.request(`http://localhost:8743${s.base}/nodes`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ type: 'note', data: { title: 'CSRF' } }),
		});
		expect(graphResponse.status).toBe(403);
	}
	expect((await (await s.request(`/t/${s.org.id}/projects`)).json()).projects).toHaveLength(1);
});

test('request-dependent trusted-origin patterns work for CORS and cookie writes', async () => {
	const s = await setup({ dynamicOrigins: true });
	const headers = new Headers(s.owner.headers);
	headers.set('origin', 'https://app.example.test');
	headers.set('content-type', 'application/json');
	const response = await s.app.request(`http://localhost:8743/t/${s.org.id}/projects`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ name: 'Allowed' }),
	});
	expect(response.status).toBe(201);
	expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
});

test('startup callback origins are replaced by the request-specific trusted origins', async () => {
	const s = await setup({ dynamicOrigins: 'startup' });
	const headers = new Headers(s.owner.headers);
	headers.set('origin', 'https://untrusted.example');
	headers.set('content-type', 'application/json');
	const response = await s.app.request(`http://localhost:8743/t/${s.org.id}/projects`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ name: 'Denied' }),
	});
	expect(response.status).toBe(403);
	expect(response.headers.get('access-control-allow-origin')).toBeNull();
});

test('organization deletion makes its API keys unusable for existing and new projects', async () => {
	const s = await setup();
	const key = await s.auth.api.createApiKey({
		body: {
			configId: 'graphx',
			organizationId: s.org.id,
			userId: s.owner.user.id,
			permissions: { graph: ['read', 'manage'] },
		},
	});
	await s.auth.api.deleteOrganization({
		headers: s.owner.headers,
		body: { organizationId: s.org.id },
	});
	const headers = { 'x-api-key': key.key };
	expect((await s.request(`${s.base}/nodes`, headers)).status).toBe(401);
	expect((await s.request(`/t/${s.org.id}/projects`, headers)).status).toBe(401);
	expect((await s.request(`/t/${s.org.id}/projects`, headers, { name: 'Orphan' })).status).toBe(
		401,
	);
});

test('GraphQL uses Better Auth permissions and origin checks for cookie mutations', async () => {
	const s = await setup({ graphql: true });
	const body = {
		query: `mutation { createNode(tenant: "${s.org.id}", project: "${s.project}", input: { type: "note", data: { title: "GraphQL" } }) { id } }`,
	};
	const created = await s.request('/graphql', s.owner.headers, body);
	expect(created.status).toBe(200);
	expect((await created.json()).data.createNode.id).toBeString();
	const headers = new Headers(s.owner.headers);
	headers.set('origin', 'https://untrusted.example');
	headers.set('content-type', 'text/plain');
	expect(
		(
			await s.app.request('http://localhost:8743/graphql', {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			})
		).status,
	).toBe(403);
});

test('dynamic base URLs reject HTTP origins on DNS hosts beginning with 127', async () => {
	const s = await setup({
		baseURL: {
			allowedHosts: ['localhost:8743', '127.example.test'],
			fallback: 'http://localhost:8743',
		},
	});
	const headers = new Headers(s.owner.headers);
	headers.set('origin', 'http://127.example.test');
	headers.set('content-type', 'application/json');
	const response = await s.app.request(`http://localhost:8743/t/${s.org.id}/projects`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ name: 'Denied' }),
	});
	expect(response.status).toBe(403);
	expect(response.headers.get('access-control-allow-origin')).toBeNull();
	const native = await s.app.request('http://localhost:8743/api/auth/sign-in/email', {
		method: 'POST',
		headers,
		body: JSON.stringify({ email: 'owner@example.test', password: 'test-password-123' }),
	});
	expect(native.status).toBe(403);
});

test('organization API keys work with a dynamic base URL without a fallback', async () => {
	const s = await setup({
		baseURL: { allowedHosts: ['localhost:8743'] },
		apiKey: { permissions: { defaultPermissions: { graph: ['read'] } } },
	});
	const key = await s.auth.api.createApiKey({
		headers: s.owner.headers,
		body: { configId: 'graphx', organizationId: s.org.id },
	});
	expect((await s.request(`${s.base}/nodes`, { 'x-api-key': key.key })).status).toBe(200);
});

test('auth discovery exposes the custom path and optional project access mode', async () => {
	const s = await setup({ basePath: '/identity', projectAccess: true });
	const discovery = await s.request('/auth-config', {});
	expect(discovery.status).toBe(200);
	expect(await discovery.json()).toEqual({
		mode: 'better-auth',
		basePath: '/identity',
		projectAccess: true,
	});
});

test('direct grants restrict lists, reads and writes and are capped by current organization permissions', async () => {
	const s = await setup({ projectAccess: true });
	const member = await s.signup('project-member');
	const membership = await s.auth.api.addMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, userId: member.user.id, role: 'member' },
	});
	expect((await s.request(`${s.base}/nodes`, member.headers)).status).toBe(403);
	expect(await (await s.request(`${s.base}/permissions`, member.headers)).json()).toEqual({
		read: false,
		write: false,
		manage: false,
	});
	expect(await (await s.request(`/t/${s.org.id}/projects`, member.headers)).json()).toEqual({
		projects: [],
	});
	const grant = { subjectType: 'user', subjectId: member.user.id, role: 'reader' };
	expect((await s.request(`${s.base}/access`, s.owner.headers, grant)).status).toBe(200);
	expect(await (await s.request(`${s.base}/access`)).json()).toEqual({ grants: [grant] });
	expect(await (await s.request(`${s.base}/permissions`, member.headers)).json()).toEqual({
		read: true,
		write: false,
		manage: false,
	});
	expect((await s.request(`${s.base}/nodes`, member.headers)).status).toBe(200);
	expect(await (await s.request(`/t/${s.org.id}/projects`, member.headers)).json()).toEqual({
		projects: [{ id: s.project, name: 'Notes' }],
	});
	expect(
		(
			await s.request(`${s.base}/nodes`, member.headers, {
				type: 'note',
				data: { title: 'Denied' },
			})
		).status,
	).toBe(403);
	expect((await s.request(`${s.base}/access`, member.headers)).status).toBe(403);
	await s.request(`${s.base}/access`, s.owner.headers, { ...grant, role: 'editor' });
	expect(
		(
			await s.request(`${s.base}/nodes`, member.headers, {
				type: 'note',
				data: { title: 'Allowed' },
			})
		).status,
	).toBe(201);
	await s.auth.api.updateMemberRole({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, memberId: membership!.id, role: 'viewer' },
	});
	expect(await (await s.request(`${s.base}/permissions`, member.headers)).json()).toEqual({
		read: true,
		write: false,
		manage: false,
	});
	await s.auth.api.removeMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, memberIdOrEmail: membership!.id },
	});
	expect((await s.request(`${s.base}/nodes`, member.headers)).status).toBe(403);
});

test('team grants use live ownership and membership and revoke without touching identities', async () => {
	const s = await setup({ projectAccess: true });
	const member = await s.signup('team-member');
	await s.auth.api.addMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, userId: member.user.id, role: 'member' },
	});
	const team = await s.auth.api.createTeam({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, name: 'Editors' },
	});
	await s.auth.api.addTeamMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, teamId: team.id, userId: member.user.id },
	});
	const grant = { subjectType: 'team', subjectId: team.id, role: 'editor' };
	expect((await s.request(`${s.base}/access`, s.owner.headers, grant)).status).toBe(200);
	expect(
		(await s.request(`${s.base}/nodes`, member.headers, { type: 'note', data: { title: 'Team' } }))
			.status,
	).toBe(201);
	await s.auth.api.removeTeamMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, teamId: team.id, userId: member.user.id },
	});
	expect((await s.request(`${s.base}/nodes`, member.headers)).status).toBe(403);
	await s.auth.api.addTeamMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, teamId: team.id, userId: member.user.id },
	});
	const headers = new Headers(s.owner.headers);
	headers.set('origin', 'http://localhost:3000');
	expect(
		(
			await s.app.request(`http://localhost:8743${s.base}/access/team/${team.id}`, {
				method: 'DELETE',
				headers,
			})
		).status,
	).toBe(200);
	expect((await s.request(`${s.base}/nodes`, member.headers)).status).toBe(403);
	expect(await (await s.request(`${s.base}/access`)).json()).toEqual({ grants: [] });
});

test('grant management validates live subjects and ownership before reading or changing grants', async () => {
	const s = await setup({ projectAccess: true });
	const outsider = await s.signup('grant-outsider');
	const other = await s.auth.api.createOrganization({
		headers: s.owner.headers,
		body: { name: 'Other grants', slug: 'other-grants' },
	});
	const team = await s.auth.api.createTeam({
		headers: s.owner.headers,
		body: { organizationId: other!.id, name: 'Foreign' },
	});
	for (const grant of [
		{ subjectType: 'user', subjectId: outsider.user.id, role: 'reader' },
		{ subjectType: 'team', subjectId: team.id, role: 'editor' },
		{ subjectType: 'team', subjectId: 'missing', role: 'reader' },
	])
		expect((await s.request(`${s.base}/access`, s.owner.headers, grant)).status).toBe(400);
	expect((await s.request(`/t/${other!.id}/p/${s.project}/access`)).status).toBe(404);
	expect((await s.request(`/t/${other!.id}/p/${s.project}/permissions`)).status).toBe(404);
	expect((await s.request(`${s.base}/access`, {})).status).toBe(401);
	const badHeaders = new Headers(s.owner.headers);
	badHeaders.set('origin', 'https://untrusted.example');
	expect(
		(
			await s.app.request(`http://localhost:8743${s.base}/access/user/${outsider.user.id}`, {
				method: 'DELETE',
				headers: badHeaders,
			})
		).status,
	).toBe(403);
	expect(await (await s.request(`${s.base}/permissions`)).json()).toEqual({
		read: true,
		write: true,
		manage: true,
	});
});

test('restricted API keys require graph and project scopes even for grant management', async () => {
	const s = await setup({ projectAccess: true });
	for (const permissions of [
		{ graph: ['read', 'write', 'manage'] },
		{ project: [s.project] },
		{ graph: ['read'], project: ['other'] },
	]) {
		const key = await s.auth.api.createApiKey({
			body: { configId: 'graphx', organizationId: s.org.id, userId: s.owner.user.id, permissions },
		});
		const headers = { 'x-api-key': key.key };
		expect((await s.request(`${s.base}/nodes`, headers)).status).toBe(403);
		expect((await s.request(`${s.base}/access`, headers)).status).toBe(403);
		expect(await (await s.request(`/t/${s.org.id}/projects`, headers)).json()).toEqual(
			permissions.graph?.includes('read') ? { projects: [] } : { error: 'forbidden' },
		);
	}
	const key = await s.auth.api.createApiKey({
		body: {
			configId: 'graphx',
			organizationId: s.org.id,
			userId: s.owner.user.id,
			permissions: { graph: ['read', 'manage'], project: [s.project] },
		},
	});
	const headers = { 'x-api-key': key.key };
	expect((await s.request(`${s.base}/nodes`, headers)).status).toBe(200);
	expect((await s.request(`${s.base}/access`, headers)).status).toBe(200);
	expect(await (await s.request(`${s.base}/permissions`, headers)).json()).toEqual({
		read: true,
		write: false,
		manage: true,
	});
	expect(
		(await s.request(`/t/${s.org.id}/projects`, headers, { name: 'Key-created' })).status,
	).toBe(201);
});

test('restricted GraphQL dispatch enforces project grants for mutations', async () => {
	const s = await setup({ projectAccess: true, graphql: true });
	const member = await s.signup('graphql-member');
	await s.auth.api.addMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, userId: member.user.id, role: 'member' },
	});
	const body = {
		query: `mutation { createNode(tenant: "${s.org.id}", project: "${s.project}", input: { type: "note", data: { title: "GraphQL" } }) { id } }`,
	};
	const denied = await s.request('/graphql', member.headers, body);
	expect((await denied.json()).errors).toBeDefined();
	await s.request(`${s.base}/access`, s.owner.headers, {
		subjectType: 'user',
		subjectId: member.user.id,
		role: 'editor',
	});
	const allowed = await s.request('/graphql', member.headers, body);
	expect((await allowed.json()).data.createNode.id).toBeString();
});

test('project discovery defaults to organization-wide access and OpenAPI documents grant routes', async () => {
	const s = await setup();
	expect(await (await s.request('/auth-config', {})).json()).toEqual({
		mode: 'better-auth',
		basePath: '/api/auth',
		projectAccess: false,
	});
	const spec = await (await s.request('/openapi.json', {})).json();
	expect(spec.paths['/auth-config'].get.security).toEqual([]);
	expect(spec.paths['/t/{tenant}/p/{project}/permissions'].get.responses[200]).toBeDefined();
	expect(spec.paths['/t/{tenant}/p/{project}/access'].post.requestBody).toBeDefined();
	expect(
		spec.paths['/t/{tenant}/p/{project}/access/{subjectType}/{subjectId}'].delete,
	).toBeDefined();
	expect((await new Validator().validate(spec)).valid).toBe(true);
});

test('revoking a direct grant hides only that project and cannot mutate cross-organization grants', async () => {
	const s = await setup({ projectAccess: true });
	const member = await s.signup('revoke-member');
	await s.auth.api.addMember({
		headers: s.owner.headers,
		body: { organizationId: s.org.id, userId: member.user.id, role: 'member' },
	});
	const otherProject = await (
		await s.request(`/t/${s.org.id}/projects`, s.owner.headers, { name: 'Hidden' })
	).json();
	const grant = { subjectType: 'user', subjectId: member.user.id, role: 'reader' };
	await s.request(`${s.base}/access`, s.owner.headers, grant);
	expect(await (await s.request(`/t/${s.org.id}/projects`, member.headers)).json()).toEqual({
		projects: [{ id: s.project, name: 'Notes' }],
	});
	expect(
		(await s.request(`/t/${s.org.id}/p/${otherProject.id}/nodes`, member.headers)).status,
	).toBe(403);
	const other = await s.auth.api.createOrganization({
		headers: s.owner.headers,
		body: { name: 'Foreign revoke', slug: 'foreign-revoke' },
	});
	const headers = new Headers(s.owner.headers);
	headers.set('origin', 'http://localhost:3000');
	expect(
		(
			await s.app.request(
				`http://localhost:8743/t/${other!.id}/p/${s.project}/access/user/${member.user.id}`,
				{ method: 'DELETE', headers },
			)
		).status,
	).toBe(404);
	expect(
		(
			await s.app.request(`http://localhost:8743${s.base}/access/user/${member.user.id}`, {
				method: 'DELETE',
				headers,
			})
		).status,
	).toBe(200);
	expect((await s.request(`${s.base}/nodes`, member.headers)).status).toBe(403);
	expect(await (await s.request(`/t/${s.org.id}/projects`, member.headers)).json()).toEqual({
		projects: [],
	});
});

for (const revoked of ['grant', 'session', 'api-key'] as const) {
	test(`an open event stream closes after ${revoked} revocation`, async () => {
		const s = await setup({ projectAccess: true, events: true });
		const member = await s.signup(`stream-${revoked}`);
		await s.auth.api.addMember({
			headers: s.owner.headers,
			body: { organizationId: s.org.id, userId: member.user.id, role: 'member' },
		});
		await s.request(`${s.base}/access`, s.owner.headers, {
			subjectType: 'user',
			subjectId: member.user.id,
			role: 'reader',
		});
		const key =
			revoked === 'api-key'
				? await s.auth.api.createApiKey({
						body: {
							configId: 'graphx',
							organizationId: s.org.id,
							userId: s.owner.user.id,
							permissions: { graph: ['read'], project: [s.project] },
						},
					})
				: undefined;
		const ac = new AbortController();
		const response = await s.app.request(
			`http://localhost:8743${s.base}/events?since=now&poll=20`,
			{ headers: key ? { 'x-api-key': key.key } : member.headers, signal: ac.signal },
		);
		expect(response.status).toBe(200);
		const reader = response.body!.getReader();
		let timer: ReturnType<typeof setTimeout> | undefined;
		async function next() {
			try {
				return await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('event stream did not close after revocation')),
							1500,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		try {
			await next(); // initial cursor ping proves the connection is established
			const before = await (
				await s.request(`${s.base}/nodes`, s.owner.headers, {
					type: 'note',
					data: { title: 'Before revocation' },
				})
			).json();
			let initial = '';
			while (!initial.includes(before.id)) {
				const part = await next();
				expect(part.done).toBe(false);
				initial += new TextDecoder().decode(part.value);
			}
			if (revoked === 'grant') {
				const headers = new Headers(s.owner.headers);
				headers.set('origin', 'http://localhost:3000');
				expect(
					(
						await s.app.request(`http://localhost:8743${s.base}/access/user/${member.user.id}`, {
							method: 'DELETE',
							headers,
						})
					).status,
				).toBe(200);
			} else if (revoked === 'session') await s.auth.api.signOut({ headers: member.headers });
			else
				await s.auth.api.deleteApiKey({
					headers: s.owner.headers,
					body: { configId: 'graphx', keyId: key!.id },
				});
			const after = await (
				await s.request(`${s.base}/nodes`, s.owner.headers, {
					type: 'note',
					data: { title: 'After revocation' },
				})
			).json();
			let remaining = '';
			let timedOut = false;
			const closeTimer = setTimeout(() => {
				timedOut = true;
				void reader.cancel();
			}, 1000);
			try {
				while (true) {
					const part = await next();
					if (part.done) break;
					remaining += new TextDecoder().decode(part.value);
				}
			} finally {
				clearTimeout(closeTimer);
			}
			expect(remaining).not.toContain(after.id);
			expect(timedOut).toBe(false);
		} finally {
			ac.abort();
			await reader.cancel().catch(() => {});
		}
	});
}

for (const storageMode of [
	'database',
	'secondary-storage',
	'global-secondary',
	'fallback',
] as const) {
	test(`event polls preserve the initial API-key quota in ${storageMode}`, async () => {
		const records = new Map<string, string>();
		const storage = {
			get: async (key: string) => records.get(key) ?? null,
			set: async (key: string, value: string) => {
				records.set(key, value);
			},
			delete: async (key: string) => {
				records.delete(key);
			},
		};
		const s = await setup({
			projectAccess: true,
			events: true,
			secondaryStorage: storageMode === 'global-secondary' ? storage : undefined,
			apiKey: {
				storage: storageMode === 'database' ? 'database' : 'secondary-storage',
				customStorage: storageMode === 'global-secondary' ? undefined : storage,
				fallbackToDatabase: storageMode === 'fallback',
			},
		});
		const key = await s.auth.api.createApiKey({
			body: {
				configId: 'graphx',
				organizationId: s.org.id,
				userId: s.owner.user.id,
				remaining: 1,
				permissions: { graph: ['read'], project: [s.project] },
			},
		});
		const response = await s.app.request(
			`http://localhost:8743${s.base}/events?since=now&poll=10`,
			{ headers: { 'x-api-key': key.key } },
		);
		expect(response.status).toBe(200);
		const reader = response.body!.getReader();
		try {
			await reader.read();
			await Bun.sleep(150);
			const node = await (
				await s.request(`${s.base}/nodes`, s.owner.headers, {
					type: 'note',
					data: { title: 'Still authorized' },
				})
			).json();
			let received = '';
			const timeout = setTimeout(() => {
				void reader.cancel();
			}, 1000);
			try {
				while (!received.includes(node.id)) {
					const part = await reader.read();
					if (part.done) break;
					received += new TextDecoder().decode(part.value);
				}
			} finally {
				clearTimeout(timeout);
			}
			expect(received).toContain(node.id);
			const saved =
				storageMode === 'database' || storageMode === 'fallback'
					? s.authDb.query('SELECT remaining, requestCount FROM apikey WHERE id = ?').get(key.id)
					: JSON.parse(records.get(`api-key:by-id:${key.id}`)!);
			expect(saved).toMatchObject({ remaining: 0, requestCount: 1 });
			await s.auth.api.deleteApiKey({
				headers: s.owner.headers,
				body: { configId: 'graphx', keyId: key.id },
			});
			let timedOut = false;
			const revokeTimeout = setTimeout(() => {
				timedOut = true;
				void reader.cancel();
			}, 1000);
			try {
				while (!(await reader.read()).done) {}
			} finally {
				clearTimeout(revokeTimeout);
			}
			expect(timedOut).toBe(false);
		} finally {
			await reader.cancel();
		}
	});
}

for (const change of ['permissions', 'enabled', 'expiry'] as const) {
	test(`an API-key event stream closes after live ${change} changes`, async () => {
		const s = await setup({ projectAccess: true, events: true });
		const key = await s.auth.api.createApiKey({
			body: {
				configId: 'graphx',
				organizationId: s.org.id,
				userId: s.owner.user.id,
				permissions: { graph: ['read'], project: [s.project] },
			},
		});
		const response = await s.app.request(
			`http://localhost:8743${s.base}/events?since=now&poll=10`,
			{ headers: { 'x-api-key': key.key } },
		);
		const reader = response.body!.getReader();
		try {
			await reader.read();
			await Bun.sleep(30);
			if (change === 'expiry')
				s.authDb
					.query('UPDATE apikey SET expiresAt = ? WHERE id = ?')
					.run(Date.now() - 1000, key.id);
			else
				await s.auth.api.updateApiKey({
					...(change === 'permissions' ? {} : { headers: s.owner.headers }),
					body: {
						configId: 'graphx',
						userId: s.owner.user.id,
						keyId: key.id,
						...(change === 'enabled'
							? { enabled: false }
							: { permissions: { graph: ['read'], project: [] } }),
					},
				});
			const timeout = setTimeout(() => {
				void reader.cancel();
			}, 1000);
			let timedOut = false;
			try {
				const ended = await Promise.race([
					reader.read(),
					Bun.sleep(500).then(() => {
						timedOut = true;
						return { done: false };
					}),
				]);
				expect(ended.done).toBe(true);
				expect(timedOut).toBe(false);
			} finally {
				clearTimeout(timeout);
			}
		} finally {
			await reader.cancel();
		}
	});
}

test('custom key validators reject event streams before returning an SSE response', async () => {
	const s = await setup({ events: true, apiKey: { customAPIKeyValidator: async () => true } });
	const key = await s.auth.api.createApiKey({
		body: {
			configId: 'graphx',
			organizationId: s.org.id,
			userId: s.owner.user.id,
			permissions: { graph: ['read'] },
		},
	});
	const response = await s.request(`${s.base}/events`, { 'x-api-key': key.key });
	expect(response.status).toBe(501);
	expect(response.headers.get('content-type')).not.toContain('text/event-stream');
	expect(await response.text()).toContain('custom API-key validator');
});

test('non-preset API-key event streams return 501 before starting a stream', async () => {
	const s = await setup({ events: true });
	const app = await createBetterAuthApp({
		auth: { ...s.auth },
		control: s.control,
		schema,
		events: { outbox: true },
	});
	const key = await s.auth.api.createApiKey({
		body: {
			configId: 'graphx',
			organizationId: s.org.id,
			userId: s.owner.user.id,
			permissions: { graph: ['read'] },
		},
	});
	const response = await app.request(`http://localhost:8743${s.base}/events`, {
		headers: { 'x-api-key': key.key },
	});
	expect(response.status).toBe(501);
	expect(response.headers.get('content-type')).not.toContain('text/event-stream');
});
