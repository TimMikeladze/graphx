import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useNodes } from "@/hooks/use-graph"
import type { ExplorerFilters } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Master node list: keyset-paginated, selection drives the canvas + detail Sheet. */
export function NodeList({
  tenant,
  project,
  filters,
  selectedId,
  onSelect,
}: {
  tenant: string
  project: string
  filters: ExplorerFilters
  selectedId?: string
  onSelect: (id: string) => void
}) {
  const q = useNodes(tenant, project, filters)
  const nodes = q.data?.pages.flatMap((p) => p.nodes) ?? []

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2 text-xs text-muted-foreground">
        {q.isLoading ? "Loading…" : `${nodes.length} node${nodes.length === 1 ? "" : "s"}`}
      </div>

      {q.isError && <p className="p-3 text-sm text-destructive">Failed to load nodes.</p>}

      {q.isLoading && (
        <div className="flex flex-col gap-2 p-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      )}

      {!q.isLoading && nodes.length === 0 && !q.isError && (
        <p className="p-3 text-sm text-muted-foreground">No nodes match these filters.</p>
      )}

      {nodes.length > 0 && (
        <ScrollArea className="flex-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Kind</TableHead>
                <TableHead>Id</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((n) => (
                <TableRow
                  key={n.id}
                  onClick={() => onSelect(n.id)}
                  className={cn("cursor-pointer", n.id === selectedId && "bg-accent")}
                >
                  <TableCell>
                    <Badge variant="secondary">{n.kind}</Badge>
                  </TableCell>
                  <TableCell className="truncate font-mono text-xs">{n.id}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}

      {q.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="m-2"
          disabled={q.isFetchingNextPage}
          onClick={() => q.fetchNextPage()}
        >
          {q.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  )
}
