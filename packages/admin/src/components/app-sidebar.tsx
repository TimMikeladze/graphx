import { useEffect, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  ChartRelationshipIcon,
  Key01Icon,
} from "@hugeicons/core-free-icons"
import { Combobox } from "@/components/combobox"
import { AsOfPicker } from "@/components/filters/as-of-picker"
import { KindFilter } from "@/components/filters/kind-filter"
import { SearchBox } from "@/components/filters/search-box"
import { TypeDot } from "@/components/type-dot"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
} from "@/components/ui/sidebar"
import { useProjects, useTenants } from "@/hooks/use-graph"
import { fmtTime } from "@/lib/format"
import type { ExplorerFilters } from "@/lib/types"

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
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.7rem] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export function AppSidebar({
  tenant,
  project,
  filters,
  types,
  count,
  onFilterChange,
}: {
  tenant: string
  project: string
  filters: ExplorerFilters
  types: string[]
  count?: number
  onFilterChange: (patch: Partial<ExplorerFilters>) => void
}) {
  const navigate = useNavigate()
  const tenants = useTenants()
  const projects = useProjects(tenant)

  // Switching tenant: load the chosen tenant's projects, then jump to its first project.
  const [desiredTenant, setDesiredTenant] = useState<string | null>(null)
  const switchProjects = useProjects(desiredTenant ?? undefined)
  useEffect(() => {
    if (desiredTenant && switchProjects.data && switchProjects.data.length > 0) {
      const first = switchProjects.data[0].id
      setDesiredTenant(null)
      navigate({
        to: "/t/$tenant/p/$project",
        params: { tenant: desiredTenant, project: first },
        search: { expand: [] },
      })
    }
  }, [desiredTenant, switchProjects.data, navigate])

  const hasFilters =
    filters.type !== undefined || filters.q !== undefined || filters.asOf !== undefined

  return (
    <Sidebar>
      <SidebarHeader className="border-b">
        <Link to="/" className="flex items-center gap-2 px-2 py-1 font-semibold">
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <HugeiconsIcon icon={ChartRelationshipIcon} strokeWidth={2} className="size-3.5" />
          </span>
          <span className="text-sm">graphx admin</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Scope</SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-3 px-2">
            <Field label="Tenant">
              <Combobox
                items={(tenants.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
                value={tenant}
                onChange={(tid) => {
                  if (tid !== tenant) setDesiredTenant(tid)
                }}
                placeholder="Tenant"
              />
            </Field>
            <Field label="Project">
              <Combobox
                items={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                value={project}
                onChange={(pid) => {
                  if (pid !== project) {
                    navigate({
                      to: "/t/$tenant/p/$project",
                      params: { tenant, project: pid },
                      search: { expand: [] },
                    })
                  }
                }}
                placeholder="Project"
              />
            </Field>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="justify-between">
            <span>Filters</span>
            {hasFilters && (
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0 text-muted-foreground"
                onClick={() => onFilterChange({ type: undefined, q: undefined, asOf: undefined })}
              >
                Clear all
              </Button>
            )}
          </SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-3 px-2">
            <Field label="Node type">
              <KindFilter
                value={filters.type}
                types={types}
                onChange={(type) => onFilterChange({ type })}
              />
            </Field>
            <Field label="Search">
              <SearchBox value={filters.q} onChange={(q) => onFilterChange({ q })} />
            </Field>
            <Field label="As of">
              <AsOfPicker value={filters.asOf} onChange={(asOf) => onFilterChange({ asOf })} />
            </Field>

            {hasFilters && (
              <div className="flex flex-wrap gap-1 pt-1">
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
      </SidebarContent>

      <SidebarFooter className="border-t">
        {count !== undefined && (
          <div className="px-2 text-[0.7rem] text-muted-foreground tabular-nums">
            {count} node{count === 1 ? "" : "s"} in view
          </div>
        )}
        <Link to="/admin">
          <Button variant="ghost" size="sm" className="w-full justify-start">
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
            Administration
          </Button>
        </Link>
      </SidebarFooter>
    </Sidebar>
  )
}
