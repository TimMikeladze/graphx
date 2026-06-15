import { getRouteApi } from "@tanstack/react-router"
import { useMemo } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { GraphCanvas } from "@/components/graph-canvas"
import { NodeDetailSheet } from "@/components/node-detail-sheet"
import { NodeList } from "@/components/node-list"
import { ResultsBanner } from "@/components/results-banner"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { useGraphSlice } from "@/hooks/use-graph"
import { filtersOf } from "@/lib/explorer-search"
import type { ExplorerFilters } from "@/lib/types"

/** Typed access to the explorer route's params + search (registered in router.tsx). */
export const explorerRoute = getRouteApi("/t/$tenant/p/$project")

/** The master-detail explorer: sidebar filters | node list | Cosmograph canvas + detail Sheet. */
export function ExplorerPage() {
  const { tenant, project } = explorerRoute.useParams()
  const search = explorerRoute.useSearch()
  const navigate = explorerRoute.useNavigate()
  const filters = filtersOf(search)

  const setSearch = (patch: Partial<ExplorerFilters> & { node?: string }) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }) })

  const slice = useGraphSlice(tenant, project, filters)
  const kinds = useMemo(
    () => [...new Set((slice.data?.nodes ?? []).map((n) => n.kind))].sort(),
    [slice.data],
  )

  return (
    <SidebarProvider>
      <AppSidebar
        tenant={tenant}
        project={project}
        filters={filters}
        kinds={kinds}
        onFilterChange={(patch) => setSearch(patch)}
      />
      <SidebarInset className="flex h-svh min-w-0 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <SidebarTrigger />
          <span className="text-sm text-muted-foreground">Explorer</span>
        </div>
        {slice.data?.truncated && <ResultsBanner />}
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={38} minSize={20}>
            <NodeList
              tenant={tenant}
              project={project}
              filters={filters}
              selectedId={search.node}
              onSelect={(id) => setSearch({ node: id })}
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={62} minSize={30}>
            <GraphCanvas
              slice={slice.data}
              isLoading={slice.isLoading}
              selectedId={search.node}
              onSelect={(id) => setSearch({ node: id })}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>

      <NodeDetailSheet
        tenant={tenant}
        project={project}
        nodeId={search.node}
        onClose={() => setSearch({ node: undefined })}
        onSelect={(id) => setSearch({ node: id })}
      />
    </SidebarProvider>
  )
}
