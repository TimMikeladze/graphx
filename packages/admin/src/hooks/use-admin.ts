import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import type { Role } from '@/lib/types';

/** Create a tenant; refresh the tenant list on success. */
export function useCreateTenant() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api.createTenant(name),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.tenants() }),
	});
}

/** Create a project under a tenant; refresh that tenant's project list. */
export function useCreateProject(tenantId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: { name: string; dbNamespace: string }) => api.createProject(tenantId, body),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects(tenantId) }),
	});
}

/** Create a user; refresh the user list. */
export function useCreateUser() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (email: string) => api.createUser(email),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.users() }),
	});
}

/** Grant a user a role in a tenant. */
export function useAddMembership() {
	return useMutation({
		mutationFn: (body: { userId: string; tenantId: string; role: Role }) => api.addMembership(body),
	});
}

/** Mint an API key (the plaintext is returned once). */
export function useCreateApiKey() {
	return useMutation({
		mutationFn: (body: { tenantId: string; scopes: string[] }) => api.createApiKey(body),
	});
}
