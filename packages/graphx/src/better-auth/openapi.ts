/** Schemas for the Better Auth routes that sit outside the core graph app. */
export function betterAuthPaths(security: Array<Record<string, string[]>>) {
	const grant = {
		type: 'object',
		required: ['subjectType', 'subjectId', 'role'],
		properties: {
			subjectType: { type: 'string', enum: ['user', 'team'] },
			subjectId: { type: 'string', minLength: 1 },
			role: { type: 'string', enum: ['reader', 'editor'] },
		},
	};
	const parameters = ['tenant', 'project'].map((name) => ({
		name,
		in: 'path',
		required: true,
		schema: { type: 'string' },
	}));
	const json = (schema: object) => ({ 'application/json': { schema } });
	const grants = {
		type: 'object',
		required: ['grants'],
		properties: { grants: { type: 'array', items: grant } },
	};
	const errors = {
		401: { description: 'Unauthenticated' },
		403: { description: 'Forbidden' },
		404: { description: 'Project not found' },
	};
	return {
		'/auth-config': {
			get: {
				operationId: 'auth_config',
				summary: 'Discover the authentication mode',
				security: [],
				responses: {
					200: {
						description: 'Authentication configuration',
						content: json({
							type: 'object',
							required: ['mode', 'basePath', 'projectAccess'],
							properties: {
								mode: { type: 'string', enum: ['better-auth'] },
								basePath: { type: 'string' },
								projectAccess: { type: 'boolean' },
							},
						}),
					},
				},
			},
		},
		'/t/{tenant}/p/{project}/permissions': {
			get: {
				operationId: 'project_permissions',
				summary: 'Get the caller’s effective project permissions',
				security,
				parameters,
				responses: {
					...errors,
					200: {
						description: 'Effective permissions',
						content: json({
							type: 'object',
							required: ['read', 'write', 'manage'],
							properties: {
								read: { type: 'boolean' },
								write: { type: 'boolean' },
								manage: { type: 'boolean' },
							},
						}),
					},
				},
			},
		},
		'/t/{tenant}/p/{project}/access': {
			get: {
				operationId: 'list_project_grants',
				summary: 'List project grants (graph manage required)',
				security,
				parameters,
				responses: { ...errors, 200: { description: 'Project grants', content: json(grants) } },
			},
			post: {
				operationId: 'upsert_project_grant',
				summary:
					'Grant a current organization user or team reader/editor access (graph manage required)',
				security,
				parameters,
				requestBody: { required: true, content: json(grant) },
				responses: {
					...errors,
					400: { description: 'Invalid grant or subject outside organization' },
					200: { description: 'Updated project grants', content: json(grants) },
				},
			},
		},
		'/t/{tenant}/p/{project}/access/{subjectType}/{subjectId}': {
			delete: {
				operationId: 'revoke_project_grant',
				summary: 'Revoke a project grant (graph manage required)',
				security,
				parameters: [
					...parameters,
					{
						name: 'subjectType',
						in: 'path',
						required: true,
						schema: { type: 'string', enum: ['user', 'team'] },
					},
					{ name: 'subjectId', in: 'path', required: true, schema: { type: 'string' } },
				],
				responses: {
					...errors,
					400: { description: 'Invalid subject type' },
					200: { description: 'Updated project grants', content: json(grants) },
				},
			},
		},
	};
}
