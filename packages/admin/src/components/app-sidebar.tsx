import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, ChartRelationshipIcon, Key01Icon } from '@hugeicons/core-free-icons';
import { Combobox } from '@/components/combobox';
import { KindFilter } from '@/components/filters/kind-filter';
import { ModeToggle } from '@/components/filters/mode-toggle';
import { SearchBox } from '@/components/filters/search-box';
import { NodeList } from '@/components/node-list';
import { TypeDot } from '@/components/type-dot';
import { Button } from '@/components/ui/button';
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	useSidebar,
} from '@/components/ui/sidebar';
import { useProjects, useTenants } from '@/hooks/use-graph';
import { fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ExplorerFilters } from '@/lib/types';

/** One removable active-filter pill. */
function FilterChip({ children, onClear }: { children: React.ReactNode; onClear: () => void }) {
	return (
		<span className="inline-flex h-5 items-center gap-1 rounded-full bg-secondary py-0.5 pr-1 pl-2 text-[0.625rem] text-secondary-foreground">
			{children}
			<button
				type="button"
				onClick={onClear}
				className="rounded-full p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
				aria-label="Clear filter"
			>
				<HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-2.5" />
			</button>
		</span>
	);
}

function Field({
	label,
	className,
	children,
}: {
	label: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn('flex flex-col gap-1', className)}>
			<span className="text-[0.7rem] font-medium text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

export function AppSidebar({
	tenant,
	project,
	filters,
	types,
	selectedId,
	onSelectNode,
	onFilterChange,
}: {
	tenant: string;
	project: string;
	filters: ExplorerFilters;
	types: string[];
	selectedId?: string;
	onSelectNode: (id: string) => void;
	onFilterChange: (patch: Partial<ExplorerFilters>) => void;
}) {
	const navigate = useNavigate();
	const tenants = useTenants();
	const projects = useProjects(tenant);
	const { isMobile, setOpenMobile } = useSidebar();

	// Switching tenant: load the chosen tenant's projects, then jump to its first project.
	const [desiredTenant, setDesiredTenant] = useState<string | null>(null);
	const switchProjects = useProjects(desiredTenant ?? undefined);
	useEffect(() => {
		if (desiredTenant && switchProjects.data && switchProjects.data.length > 0) {
			const first = switchProjects.data[0].id;
			setDesiredTenant(null);
			navigate({
				to: '/t/$tenant/p/$project',
				params: { tenant: desiredTenant, project: first },
				search: { expand: [] },
			});
		}
	}, [desiredTenant, switchProjects.data, navigate]);

	const hasFilters =
		filters.type !== undefined ||
		filters.q !== undefined ||
		filters.asOf !== undefined ||
		filters.mode !== undefined;

	return (
		<Sidebar>
			<SidebarHeader className="border-b">
				<Link
					to="/"
					className="flex items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors hover:bg-sidebar-accent"
				>
					<span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
						<HugeiconsIcon icon={ChartRelationshipIcon} strokeWidth={2} className="size-4" />
					</span>
					<span className="flex flex-col leading-none">
						<span className="text-sm font-semibold">graphx</span>
						<span className="text-[0.65rem] tracking-wide text-muted-foreground uppercase">
							Explorer
						</span>
					</span>
				</Link>
			</SidebarHeader>

			{/* One panel: scope → filters → results. Only the node list scrolls. */}
			<SidebarContent className="overflow-hidden">
				<SidebarGroup className="shrink-0 border-b pb-2">
					<SidebarGroupContent className="flex gap-2 px-2 pt-1">
						<Field label="Tenant" className="min-w-0 flex-1">
							<Combobox
								items={(tenants.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
								value={tenant}
								onChange={(tid) => {
									if (tid !== tenant) setDesiredTenant(tid);
								}}
								placeholder="Tenant"
							/>
						</Field>
						<Field label="Project" className="min-w-0 flex-1">
							<Combobox
								items={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
								value={project}
								onChange={(pid) => {
									if (pid !== project) {
										navigate({
											to: '/t/$tenant/p/$project',
											params: { tenant, project: pid },
											search: { expand: [] },
										});
									}
								}}
								placeholder="Project"
							/>
						</Field>
					</SidebarGroupContent>
				</SidebarGroup>

				<SidebarGroup className="shrink-0 border-b pb-2">
					<SidebarGroupLabel className="h-6 justify-between">
						<span>Filters</span>
						{hasFilters && (
							<Button
								variant="link"
								size="xs"
								className="h-auto p-0 text-muted-foreground"
								onClick={() =>
									onFilterChange({
										type: undefined,
										q: undefined,
										asOf: undefined,
										mode: undefined,
									})
								}
							>
								Clear all
							</Button>
						)}
					</SidebarGroupLabel>
					<SidebarGroupContent className="flex flex-col gap-2 px-2">
						<SearchBox value={filters.q} onChange={(q) => onFilterChange({ q })} />
						<ModeToggle
							value={filters.mode}
							onChange={(mode) => onFilterChange({ mode: mode === 'text' ? undefined : mode })}
						/>
						<KindFilter
							value={filters.type}
							types={types}
							onChange={(type) => onFilterChange({ type })}
						/>
						{hasFilters && (
							<div className="flex flex-wrap gap-1 pt-0.5">
								{filters.type !== undefined && (
									<FilterChip onClear={() => onFilterChange({ type: undefined })}>
										<TypeDot type={filters.type} />
										{filters.type}
									</FilterChip>
								)}
								{filters.q !== undefined && (
									<FilterChip onClear={() => onFilterChange({ q: undefined })}>
										“{filters.q}”
									</FilterChip>
								)}
								{filters.asOf !== undefined && (
									<FilterChip onClear={() => onFilterChange({ asOf: undefined })}>
										as of {fmtTime(filters.asOf)}
									</FilterChip>
								)}
							</div>
						)}
					</SidebarGroupContent>
				</SidebarGroup>

				<NodeList
					className="min-h-0 flex-1"
					tenant={tenant}
					project={project}
					filters={filters}
					selectedId={selectedId}
					onSelect={(id) => {
						onSelectNode(id);
						// On mobile the sidebar is a sheet covering the canvas — close it on pick.
						if (isMobile) setOpenMobile(false);
					}}
				/>
			</SidebarContent>

			<SidebarFooter className="border-t">
				<Link to="/admin">
					<Button variant="ghost" size="sm" className="w-full justify-start">
						<HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
						Administration
					</Button>
				</Link>
			</SidebarFooter>
		</Sidebar>
	);
}
