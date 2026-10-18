import type { DbClient } from '../core/dialect.ts';
import type { GraphxBetterAuth } from './index.ts';

export type ProjectGrant = {
	subjectType: 'user' | 'team';
	subjectId: string;
	role: 'reader' | 'editor';
};

type Adapter = Awaited<GraphxBetterAuth['$context']>['adapter'];

export async function listGrants(control: DbClient, projectId: string): Promise<ProjectGrant[]> {
	const result = await control.execute({
		sql: 'SELECT subject_type, subject_id, role FROM project_grants WHERE project_id = ? ORDER BY subject_type, subject_id',
		args: [projectId],
	});
	return result.rows.map((row) => ({
		subjectType: String(row.subject_type) as ProjectGrant['subjectType'],
		subjectId: String(row.subject_id),
		role: String(row.role) as ProjectGrant['role'],
	}));
}

/** Better Auth remains the source of subject existence and organization ownership. */
export async function validSubject(
	adapter: Adapter,
	tenantId: string,
	grant: Pick<ProjectGrant, 'subjectType' | 'subjectId'>,
): Promise<boolean> {
	if (grant.subjectType === 'team') {
		return !!(await adapter.findOne({
			model: 'team',
			where: [
				{ field: 'id', value: grant.subjectId },
				{ field: 'organizationId', value: tenantId },
			],
		}));
	}
	const user = await adapter.findOne({
		model: 'user',
		where: [{ field: 'id', value: grant.subjectId }],
	});
	return (
		!!user &&
		!!(await adapter.findOne({
			model: 'member',
			where: [
				{ field: 'userId', value: grant.subjectId },
				{ field: 'organizationId', value: tenantId },
			],
		}))
	);
}

export async function granted(
	control: DbClient,
	adapter: Adapter,
	tenantId: string,
	userId: string,
	projectId: string,
	op: 'read' | 'write',
): Promise<boolean> {
	for (const grant of await listGrants(control, projectId)) {
		if (op === 'write' && grant.role !== 'editor') continue;
		if (grant.subjectType === 'user' && grant.subjectId === userId) return true;
		if (grant.subjectType !== 'team' || !(await validSubject(adapter, tenantId, grant))) continue;
		if (
			await adapter.findOne({
				model: 'teamMember',
				where: [
					{ field: 'teamId', value: grant.subjectId },
					{ field: 'userId', value: userId },
				],
			})
		)
			return true;
	}
	return false;
}
