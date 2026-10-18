import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient, useQueries } from '@tanstack/react-query';
import { AccountControl, useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type ProjectGrant } from '@/lib/api';
import {
	authRequest,
	organizations,
	type Invitation,
	type Member,
	type Team,
} from '@/lib/auth-client';
import { useProjects, useTenants } from '@/hooks/use-graph';

const selectClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm';
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="grid gap-4 rounded-xl border bg-card p-5">
			<h2 className="font-semibold">{title}</h2>
			{children}
		</section>
	);
}
function Select({
	label,
	value,
	onChange,
	children,
	name,
	required = false,
}: {
	label: string;
	value?: string;
	onChange?: (value: string) => void;
	children: React.ReactNode;
	name?: string;
	required?: boolean;
}) {
	return (
		<label className="grid min-w-0 gap-2 text-sm">
			{label}
			<select
				aria-label={label}
				className={selectClass}
				name={name}
				value={value}
				onChange={onChange ? (event) => onChange(event.target.value) : undefined}
				required={required}
			>
				{children}
			</select>
		</label>
	);
}
function useAction() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (fn: () => Promise<unknown>) => fn(),
		onSuccess: () => qc.invalidateQueries(),
	});
}
function ActionStatus({ action }: { action: ReturnType<typeof useAction> }) {
	if (action.isError)
		return (
			<p role="alert" className="text-sm text-destructive">
				{action.error.message}
			</p>
		);
	if (action.isSuccess)
		return (
			<p role="status" className="text-sm text-muted-foreground">
				Saved.
			</p>
		);
	return null;
}
function useOrganization() {
	const [id, setId] = useState(() => sessionStorage.getItem('graphx.organization') ?? '');
	const tenants = useTenants();
	const full = useQuery({
		queryKey: ['organization', id],
		queryFn: () => organizations.full(id),
		enabled: Boolean(id),
	});
	const permissions = [
		['graph', 'manage'],
		['member', 'update'],
		['member', 'delete'],
		['invitation', 'create'],
		['invitation', 'cancel'],
		['team', 'create'],
	] as const;
	const results = useQueries({
		queries: permissions.map(([resource, action]) => ({
			queryKey: ['organization-permission', id, resource, action],
			queryFn: () =>
				authRequest<{ success: boolean }>('/organization/has-permission', {
					organizationId: id,
					permissions: { [resource]: [action] },
				}),
			enabled: Boolean(id),
		})),
	});
	const [manage, updateMembers, removeMembers, inviteMembers, cancelInvitations, createTeams] =
		results.map((result) => result.data?.success === true);

	return {
		id,
		setId: (value: string) => {
			sessionStorage.setItem('graphx.organization', value);
			setId(value);
		},
		tenants,
		full,
		manage,
		updateMembers,
		removeMembers,
		inviteMembers,
		cancelInvitations,
		createTeams,
	};
}
function OrganizationSelect({ org }: { org: ReturnType<typeof useOrganization> }) {
	return (
		<div className="grid gap-2">
			<Select label="Organization" value={org.id} onChange={org.setId}>
				<option value="">Choose an organization</option>
				{org.tenants.data?.map((tenant) => (
					<option key={tenant.id} value={tenant.id}>
						{tenant.name}
					</option>
				))}
			</Select>
			{org.tenants.isError && (
				<p role="alert" className="text-sm text-destructive">
					{org.tenants.error.message}
					<Button variant="outline" size="sm" onClick={() => void org.tenants.refetch()}>
						Retry
					</Button>
				</p>
			)}
			{org.full.isError && (
				<p role="alert" className="text-sm text-destructive">
					{org.full.error.message}
				</p>
			)}
		</div>
	);
}
function Header({ admin = false }: { admin?: boolean }) {
	return (
		<header className="flex flex-wrap items-start justify-between gap-4">
			<div>
				<h1 className="text-xl font-semibold">
					{admin ? 'Organization administration' : 'graphx admin'}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					{admin
						? 'Manage members, invitations, teams, and project access.'
						: 'Choose an organization and project to explore.'}
				</p>
				<Link
					to={admin ? '/' : '/admin'}
					className="mt-3 inline-block text-sm underline underline-offset-4"
				>
					{admin ? 'Back to projects' : 'Organization administration'}
				</Link>
			</div>
			<AccountControl />
		</header>
	);
}

export function OrganizationHome() {
	const org = useOrganization();
	const projects = useProjects(org.id || undefined);
	const action = useAction();
	const invitationId = new URLSearchParams(window.location.search).get('invitation');
	const invitations = useQuery({
		queryKey: ['my-invitations'],
		queryFn: () => authRequest<Invitation[]>('/organization/list-user-invitations'),
	});
	return (
		<main className="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 p-6 sm:p-8">
			<Header />
			{(invitationId || invitations.data?.some((invite) => invite.status === 'pending')) && (
				<Panel title="Organization invitations">
					{invitationId && (
						<Button
							onClick={() =>
								action.mutate(async () => {
									await authRequest('/organization/accept-invitation', {
										invitationId,
									});
									window.history.replaceState({}, '', '/');
								})
							}
						>
							Accept invitation
						</Button>
					)}
					{invitations.data
						?.filter((invite) => invite.status === 'pending' && invite.id !== invitationId)
						.map((invite) => (
							<div key={invite.id} className="flex items-center justify-between gap-3 text-sm">
								<span>
									{invite.email} · {invite.role}
								</span>
								<Button
									size="sm"
									onClick={() =>
										action.mutate(() =>
											authRequest('/organization/accept-invitation', {
												invitationId: invite.id,
											}),
										)
									}
								>
									Accept invitation
								</Button>
							</div>
						))}
				</Panel>
			)}
			<Panel title="Organizations">
				<OrganizationSelect org={org} />
				<form
					className="flex flex-wrap gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						const form = new FormData(event.currentTarget);
						const name = String(form.get('name')).trim();
						action.mutate(async () => {
							const created = await authRequest<{ id: string }>('/organization/create', {
								name,
								slug: `${
									name
										.toLowerCase()
										.replace(/[^a-z0-9]+/g, '-')
										.replace(/^-|-$/g, '') || 'organization'
								}-${crypto.randomUUID().slice(0, 8)}`,
							});
							org.setId(created.id);
						});
					}}
				>
					<Input
						aria-label="New organization name"
						name="name"
						placeholder="Organization name"
						className="flex-1"
						required
					/>
					<Button type="submit" disabled={action.isPending}>
						Create organization
					</Button>
				</form>
			</Panel>
			{org.id && (
				<Panel title="Projects">
					{projects.isLoading && <p role="status">Loading projects…</p>}
					{projects.isError && (
						<p role="alert" className="text-sm text-destructive">
							{projects.error.message}
							<Button size="sm" variant="outline" onClick={() => void projects.refetch()}>
								Retry
							</Button>
						</p>
					)}
					{projects.data?.map((project) => (
						<Link
							key={project.id}
							to="/t/$tenant/p/$project"
							params={{ tenant: org.id, project: project.id }}
							search={{ expand: [] }}
							className="flex justify-between rounded-md border p-3 text-sm hover:bg-accent"
						>
							<span>{project.name}</span>
							<span className="text-muted-foreground">Open project →</span>
						</Link>
					))}
					{projects.data?.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No accessible projects in this organization.
						</p>
					)}
					{org.manage && (
						<form
							className="flex flex-wrap gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								const name = String(new FormData(event.currentTarget).get('name'));
								action.mutate(() => api.createProject(org.id, { name, dbNamespace: '' }));
							}}
						>
							<Input
								name="name"
								aria-label="New project name"
								placeholder="Project name"
								className="flex-1"
								required
							/>
							<Button type="submit" disabled={action.isPending}>
								Create project
							</Button>
						</form>
					)}
				</Panel>
			)}
			<ActionStatus action={action} />
		</main>
	);
}

export function OrganizationAdmin() {
	const { session } = useAuth();
	const org = useOrganization();
	const action = useAction();
	const teams = useQuery({
		queryKey: ['teams', org.id],
		queryFn: () => organizations.teams(org.id),
		enabled: Boolean(org.id),
	});
	const [teamId, setTeamId] = useState('');
	const team = teams.data?.find((value) => value.id === teamId);
	const teamMembers = useQuery({
		queryKey: ['team-members', org.id, team?.id],
		queryFn: () =>
			authRequest<{ id: string; userId: string }[]>('/organization/list-team-members', undefined, {
				teamId: team!.id,
			}),
		enabled: Boolean(team),
	});
	return (
		<main className="mx-auto flex min-h-svh max-w-4xl flex-col gap-6 p-6 sm:p-8">
			<Header admin />
			<Panel title="Organization">
				<OrganizationSelect org={org} />
				{org.id && org.full.data && (
					<p className="text-sm text-muted-foreground">
						{org.manage
							? 'You can manage this organization’s projects.'
							: 'Your organization role allows you to view membership.'}
					</p>
				)}
			</Panel>
			{org.full.data && (
				<>
					<Panel title="Members">
						{org.full.data.members.map((member) => (
							<MemberRow
								key={member.id}
								member={member}
								manage={org.updateMembers}
								remove={org.removeMembers}
								run={(fn) => action.mutate(fn)}
								organizationId={org.id}
							/>
						))}
					</Panel>
					<Panel title="Invitations">
						{org.inviteMembers && (
							<form
								className="flex flex-wrap items-end gap-3"
								onSubmit={(event) => {
									event.preventDefault();
									const form = new FormData(event.currentTarget);
									action.mutate(() =>
										authRequest('/organization/invite-member', {
											email: form.get('email'),
											role: form.get('role'),
											organizationId: org.id,
										}),
									);
								}}
							>
								<label className="grid flex-1 gap-2 text-sm">
									Email
									<Input name="email" type="email" required />
								</label>
								<RoleSelect />
								<Button type="submit" disabled={action.isPending}>
									Invite member
								</Button>
							</form>
						)}
						{org.full.data.invitations
							.filter((invite) => invite.status === 'pending')
							.map((invite) => (
								<div
									className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
									key={invite.id}
								>
									<span>
										{invite.email} · {invite.role}
									</span>
									{org.cancelInvitations && (
										<div className="flex gap-2">
											<Button
												size="sm"
												variant="outline"
												onClick={() => {
													void navigator.clipboard
														.writeText(
															`${window.location.origin}/?invitation=${encodeURIComponent(invite.id)}`,
														)
														.catch(() => {});
												}}
											>
												Copy invitation link
											</Button>
											<Button
												size="sm"
												variant="outline"
												onClick={() =>
													action.mutate(() =>
														authRequest('/organization/cancel-invitation', {
															invitationId: invite.id,
														}),
													)
												}
											>
												Cancel invitation
											</Button>
										</div>
									)}
								</div>
							))}
					</Panel>
					<Panel title="Teams">
						{teams.isError && (
							<p role="alert" className="text-sm text-destructive">
								{teams.error.message}
							</p>
						)}
						{org.createTeams && (
							<form
								className="flex gap-2"
								onSubmit={(event) => {
									event.preventDefault();
									const name = String(new FormData(event.currentTarget).get('name'));
									action.mutate(() =>
										authRequest('/organization/create-team', {
											name,
											organizationId: org.id,
										}),
									);
								}}
							>
								<Input name="name" placeholder="Team name" aria-label="New team name" required />
								<Button type="submit" disabled={action.isPending}>
									Create team
								</Button>
							</form>
						)}
						<Select label="Team" value={team?.id ?? ''} onChange={setTeamId}>
							<option value="">Choose a team</option>
							{teams.data?.map((value) => (
								<option key={value.id} value={value.id}>
									{value.name}
								</option>
							))}
						</Select>
						{team && (
							<>
								{teamMembers.isError && (
									<p role="alert" className="text-sm text-destructive">
										{teamMembers.error.message.toLowerCase().includes('not a member')
											? org.updateMembers
												? 'Join this team to view its members.'
												: 'Better Auth requires team membership to view members. Ask an organization administrator to add your account.'
											: teamMembers.error.message}
									</p>
								)}
								{teamMembers.isError &&
									org.updateMembers &&
									session &&
									teamMembers.error.message.toLowerCase().includes('not a member') && (
										<Button
											variant="outline"
											className="justify-self-start"
											onClick={() =>
												action.mutate(() =>
													authRequest('/organization/add-team-member', {
														teamId: team.id,
														userId: session.user.id,
														organizationId: org.id,
													}),
												)
											}
										>
											Join team
										</Button>
									)}
								{teamMembers.data?.map((value) => (
									<div
										key={value.id}
										className="flex items-center justify-between gap-2 rounded-md border p-3 text-sm"
									>
										<span>
											{org.full.data?.members.find((member) => member.userId === value.userId)?.user
												.email ?? value.userId}
										</span>
										{org.removeMembers && (
											<Button
												size="sm"
												variant="outline"
												onClick={() =>
													action.mutate(() =>
														authRequest('/organization/remove-team-member', {
															teamId: team.id,
															userId: value.userId,
															organizationId: org.id,
														}),
													)
												}
											>
												Remove from team
											</Button>
										)}
									</div>
								))}
								{org.updateMembers && (
									<form
										className="flex flex-wrap items-end gap-3"
										onSubmit={(event) => {
											event.preventDefault();
											const userId = String(new FormData(event.currentTarget).get('userId'));
											action.mutate(() =>
												authRequest('/organization/add-team-member', {
													teamId: team.id,
													userId,
													organizationId: org.id,
												}),
											);
										}}
									>
										<Select label="Organization member" name="userId" required>
											<option value="">Choose a member</option>
											{org.full.data.members
												.filter(
													(member) =>
														!teamMembers.data?.some((value) => value.userId === member.userId),
												)
												.map((member) => (
													<option key={member.id} value={member.userId}>
														{member.user.email}
													</option>
												))}
										</Select>
										<Button type="submit" disabled={action.isPending}>
											Add to team
										</Button>
									</form>
								)}
							</>
						)}
					</Panel>
					{org.manage && (
						<ProjectAccess
							organizationId={org.id}
							members={org.full.data.members}
							teams={teams.data ?? []}
						/>
					)}
				</>
			)}
			<ActionStatus action={action} />
		</main>
	);
}
function RoleSelect({ value, onChange }: { value?: string; onChange?: (role: string) => void }) {
	return (
		<Select label="Role" name="role" value={value} onChange={onChange}>
			<option value="member">Member</option>
			<option value="admin">Admin</option>
			<option value="owner">Owner</option>
		</Select>
	);
}
function MemberRow({
	member,
	manage,
	remove,
	organizationId,
	run,
}: {
	member: Member;
	manage: boolean;
	remove: boolean;
	organizationId: string;
	run: (fn: () => Promise<unknown>) => void;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
			<div className="text-sm">
				<p>{member.user.name}</p>
				<p className="text-muted-foreground">{member.user.email}</p>
			</div>
			{manage || remove ? (
				<div className="flex items-end gap-2">
					{manage && (
						<RoleSelect
							value={member.role}
							onChange={(role) =>
								run(() =>
									authRequest('/organization/update-member-role', {
										memberId: member.id,
										role,
										organizationId,
									}),
								)
							}
						/>
					)}
					{remove && (
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								run(() =>
									authRequest('/organization/remove-member', {
										memberIdOrEmail: member.id,
										organizationId,
									}),
								)
							}
						>
							Remove member
						</Button>
					)}
				</div>
			) : (
				<span className="text-sm">{member.role}</span>
			)}
		</div>
	);
}
function ProjectAccess({
	organizationId,
	members,
	teams,
}: {
	organizationId: string;
	members: Member[];
	teams: Team[];
}) {
	const { config } = useAuth();
	const projects = useProjects(organizationId);
	const [picked, setPicked] = useState('');
	const project = projects.data?.find((value) => value.id === picked);
	const [subjectType, setSubjectType] = useState<'user' | 'team'>('user');
	const action = useAction();
	const grants = useQuery({
		queryKey: ['project-access', organizationId, project?.id],
		queryFn: () => api.projectAccess(organizationId, project!.id),
		enabled: Boolean(project) && config.mode === 'better-auth' && config.projectAccess,
	});
	if (config.mode !== 'better-auth' || !config.projectAccess) return null;
	return (
		<Panel title="Project access">
			<p className="text-sm text-muted-foreground">
				Owners and admins can manage every project. Other members need a reader or editor grant,
				directly or through a team.
			</p>
			<Select label="Project" value={project?.id ?? ''} onChange={setPicked}>
				<option value="">Choose a project</option>
				{projects.data?.map((value) => (
					<option key={value.id} value={value.id}>
						{value.name}
					</option>
				))}
			</Select>
			{project && (
				<>
					{grants.isError && (
						<p role="alert" className="text-sm text-destructive">
							{grants.error.message}
						</p>
					)}
					<form
						className="flex flex-wrap items-end gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							const form = new FormData(event.currentTarget);
							action.mutate(() =>
								api.grantProject(organizationId, project.id, {
									subjectType,
									subjectId: String(form.get('subjectId')),
									role: form.get('role') as ProjectGrant['role'],
								}),
							);
						}}
					>
						<Select
							label="Subject type"
							value={subjectType}
							onChange={(value) => setSubjectType(value as 'user' | 'team')}
						>
							<option value="user">User</option>
							<option value="team">Team</option>
						</Select>
						<Select
							key={subjectType}
							label={subjectType === 'user' ? 'User' : 'Grant team'}
							name="subjectId"
							required
						>
							<option value="">Choose {subjectType}</option>
							{subjectType === 'user'
								? members.map((member) => (
										<option key={member.id} value={member.userId}>
											{member.user.email}
										</option>
									))
								: teams.map((team) => (
										<option key={team.id} value={team.id}>
											{team.name}
										</option>
									))}
						</Select>
						<Select label="Project role" name="role">
							<option value="reader">Reader</option>
							<option value="editor">Editor</option>
						</Select>
						<Button type="submit" disabled={action.isPending}>
							Grant access
						</Button>
					</form>
					{grants.data?.map((grant) => (
						<div
							key={`${grant.subjectType}:${grant.subjectId}`}
							className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
						>
							<span>
								{grant.subjectType === 'user'
									? (members.find((member) => member.userId === grant.subjectId)?.user.email ??
										grant.subjectId)
									: (teams.find((team) => team.id === grant.subjectId)?.name ??
										grant.subjectId)}{' '}
								· {grant.subjectType} · {grant.role}
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									action.mutate(() =>
										api.revokeProject(
											organizationId,
											project.id,
											grant.subjectType,
											grant.subjectId,
										),
									)
								}
							>
								Revoke access
							</Button>
						</div>
					))}
				</>
			)}
			<ActionStatus action={action} />
		</Panel>
	);
}
