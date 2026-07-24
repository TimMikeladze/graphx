import { getRouteApi } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons"
import { AppSidebar } from "@/components/app-sidebar"
import { CommandPalette } from "@/components/command-palette"
import { GraphCanvas } from "@/components/graph-canvas"
import { NodeDetail } from "@/components/node-detail"
import { NodeDetailSheet } from "@/components/node-detail-sheet"
import { ResultsBanner } from "@/components/results-banner"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import { useGraphSlice, useProjects, useTenants } from "@/hooks/use-graph"
import { filtersOf } from "@/lib/explorer-search"
import type { ExplorerFilters } from "@/lib/types"

/** Typed access to the explorer route's params + search (registered in router.tsx). */
export const explorerRoute = getRouteApi("/t/$tenant/p/$project")

/** The master-detail explorer: one sidebar (scope + filters + node list) | canvas | docked detail. */
export function ExplorerPage() {
  const { tenant, project } = explorerRoute.useParams()
  const search = explorerRoute.useSearch()
  const navigate = explorerRoute.useNavigate()
  const filters = filtersOf(search)
  const isMobile = useIsMobile()
  const [paletteOpen, setPaletteOpen] = useState(false)

  const setSearch = (patch: Partial<ExplorerFilters> & { node?: string }) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }) })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // `GET /graph` only knows the substring filter, so in a retrieval mode `q` would shrink the
  // canvas by a rule that has nothing to do with what /retrieve returned — the list and the graph
  // would disagree. Drop `q` there and let the canvas show the whole scope, with the selected
  // result highlighted.
  const sliceFilters = useMemo(
    () => (filters.mode && filters.mode !== "text" ? { ...filters, q: undefined } : filters),
    [filters],
  )
  const slice = useGraphSlice(tenant, project, sliceFilters)
  const types = useMemo(
    () => [...new Set((slice.data?.nodes ?? []).map((n) => n.type))].sort(),
    [slice.data],
  )

  // Breadcrumb names (cached — same query keys the sidebar uses).
  const tenants = useTenants()
  const projects = useProjects(tenant)
  const tenantName = tenants.data?.find((t) => t.id === tenant)?.name ?? tenant
  const projectName = projects.data?.find((p) => p.id === project)?.name ?? project

  const detailOpen = Boolean(search.node) && !isMobile

  return (
    <SidebarProvider style={{ "--sidebar-width": "21rem" } as React.CSSProperties}>
      <AppSidebar
        tenant={tenant}
        project={project}
        filters={filters}
        types={types}
        selectedId={search.node}
        onSelectNode={(id) => setSearch({ node: id })}
        onFilterChange={(patch) => setSearch(patch)}
      />
      <SidebarInset className="flex h-svh min-w-0 flex-col">
        <header className="flex h-11 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <nav className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="truncate text-muted-foreground">{tenantName}</span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="size-3.5 shrink-0 text-muted-foreground/60"
            />
            <span className="truncate font-medium">{projectName}</span>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="w-52 justify-start gap-2 font-normal text-muted-foreground"
              onClick={() => setPaletteOpen(true)}
            >
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-3.5" />
              Search nodes…
              <kbd className="ml-auto inline-flex h-4 items-center rounded border bg-muted px-1 font-sans text-[0.65rem] text-muted-foreground">
                ⌘K
              </kbd>
            </Button>
            <ThemeToggle />
          </div>
        </header>

        {slice.data?.truncated && <ResultsBanner />}

        <div className="flex min-h-0 flex-1">
          {/* detail docks as a fixed pane beside the canvas so the graph never remounts */}
          <div className="min-w-0 flex-1">
            <GraphCanvas
              slice={slice.data}
              isLoading={slice.isLoading}
              selectedId={search.node}
              onSelect={(id) => setSearch({ node: id })}
              activeType={filters.type}
              onTypeFilter={(type) => setSearch({ type })}
            />
          </div>
          {detailOpen && search.node && (
            <aside className="flex w-[400px] shrink-0 animate-in flex-col border-l duration-200 fade-in slide-in-from-right-4">
              <NodeDetail
                tenant={tenant}
                project={project}
                nodeId={search.node}
                onSelect={(id) => setSearch({ node: id })}
                onClose={() => setSearch({ node: undefined })}
              />
            </aside>
          )}
        </div>
      </SidebarInset>

      {/* Mobile: detail as a slide-over instead of a docked pane. */}
      {isMobile && (
        <NodeDetailSheet
          tenant={tenant}
          project={project}
          nodeId={search.node}
          onClose={() => setSearch({ node: undefined })}
          onSelect={(id) => setSearch({ node: id })}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        tenant={tenant}
        project={project}
        onSelectNode={(id) => setSearch({ node: id })}
      />
    </SidebarProvider>
  )
}
