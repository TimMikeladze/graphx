import { useEffect, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { Combobox } from "@/components/combobox"
import { AsOfPicker } from "@/components/filters/as-of-picker"
import { KindFilter } from "@/components/filters/kind-filter"
import { SearchBox } from "@/components/filters/search-box"
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
import type { ExplorerFilters } from "@/lib/types"

export function AppSidebar({
  tenant,
  project,
  filters,
  types,
  onFilterChange,
}: {
  tenant: string
  project: string
  filters: ExplorerFilters
  types: string[]
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

  return (
    <Sidebar>
      <SidebarHeader>
        <Link to="/" className="px-2 text-sm font-semibold">
          graphx admin
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Scope</SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-2 px-2">
            <Combobox
              items={(tenants.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
              value={tenant}
              onChange={(tid) => {
                if (tid !== tenant) setDesiredTenant(tid)
              }}
              placeholder="Tenant"
            />
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
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Filters</SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-3 px-2">
            <div>
              <div className="mb-1 text-xs text-muted-foreground">NodeType</div>
              <KindFilter
                value={filters.type}
                types={types}
                onChange={(type) => onFilterChange({ type })}
              />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Search</div>
              <SearchBox value={filters.q} onChange={(q) => onFilterChange({ q })} />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">As of</div>
              <AsOfPicker value={filters.asOf} onChange={(asOf) => onFilterChange({ asOf })} />
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Link
          to="/admin"
          className="px-2 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Administration →
        </Link>
      </SidebarFooter>
    </Sidebar>
  )
}
