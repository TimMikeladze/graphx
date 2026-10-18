import { createAuthClient } from 'better-auth/react';

export type AuthConfig =
	| { mode: 'legacy' }
	| {
			mode: 'better-auth';
			basePath: string;
			projectAccess: boolean;
	  };
export interface Session {
	user: { id: string; name: string; email: string };
	session: { id: string };
}
export interface Organization {
	id: string;
	name: string;
	slug: string;
}
export interface Member {
	id: string;
	userId: string;
	role: string;
	user: { name: string; email: string };
}
export interface Team {
	id: string;
	name: string;
}
export interface Invitation {
	id: string;
	email: string;
	role: string;
	status: string;
}
export interface FullOrganization extends Organization {
	members: Member[];
	invitations: Invitation[];
	teams?: Team[];
}

let config: AuthConfig = { mode: 'legacy' };
let client: ReturnType<typeof createAuthClient> | undefined;
let expired: (() => void) | undefined;
export const getAuthConfig = () => config;
export function configureAuth(value: AuthConfig) {
	config = value;
	client =
		value.mode === 'better-auth'
			? createAuthClient({
					basePath: value.basePath,
					fetchOptions: { credentials: 'include' },
				})
			: undefined;
}
export function setSessionExpiredHandler(handler: () => void) {
	expired = handler;
}
export function expireSession() {
	expired?.();
}
export async function discoverAuth(): Promise<AuthConfig> {
	const response = await fetch('/auth-config', { credentials: 'include' });
	if (response.status === 404) return { mode: 'legacy' };
	if (!response.ok) throw new Error(`Authentication discovery failed (${response.status})`);
	const value = await response.json();
	if (
		value.mode !== 'better-auth' ||
		typeof value.basePath !== 'string' ||
		!value.basePath.startsWith('/')
	) {
		throw new Error('Invalid authentication configuration');
	}
	return value as AuthConfig;
}
export async function authRequest<T>(
	path: string,
	body?: Record<string, unknown>,
	query?: Record<string, string>,
): Promise<T> {
	if (!client) throw new Error('Authentication is not configured');
	const { data, error } = await client.$fetch<T>(path, {
		method: body ? 'POST' : 'GET',
		body,
		query,
		credentials: 'include',
	});
	if (error) {
		if (error.status === 401 && path === '/get-session') return null as T;
		if (error.status === 401 && path !== '/get-session' && !path.startsWith('/sign-'))
			expireSession();
		throw new Error(error.message ?? `Request failed (${error.status})`);
	}
	return data as T;
}
export const organizations = {
	list: () => authRequest<Organization[]>('/organization/list'),
	full: (id: string) =>
		authRequest<FullOrganization>('/organization/get-full-organization', undefined, {
			organizationId: id,
		}),
	teams: (id: string) =>
		authRequest<Team[]>('/organization/list-teams', undefined, {
			organizationId: id,
		}),
};
