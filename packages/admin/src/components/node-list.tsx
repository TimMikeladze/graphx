import { useEffect, useRef, useState } from "react"
import { AlertCircleIcon, InboxIcon } from "@hugeicons/core-free-icons"
import { CopyButton } from "@/components/copy-button"
import { EmptyState } from "@/components/empty-state"
import { NodeTypeBadge } from "@/components/type-dot"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useNodes } from "@/hooks/use-graph"
import { shortId } from "@/lib/format"
import type { ExplorerFilters } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Master node list: keyset-paginated, arrow-key navigable, selection drives canvas + detail. */
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

  // Roving keyboard focus within the listbox (independent of URL selection).
  const [focus, setFocus] = useState(0)
  const activeRef = useRef<HTMLDivElement>(null)

  // Keep focus on the selected row when selection changes externally (canvas/palette click).
  useEffect(() => {
    if (!selectedId) return
    const i = nodes.findIndex((n) => n.id === selectedId)
    if (i >= 0) setFocus(i)
    // nodes identity changes each render; key on selectedId + length only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, nodes.length])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [focus])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (nodes.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setFocus((f) => Math.min(f + 1, nodes.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setFocus((f) => Math.max(f - 1, 0))
    } else if (e.key === "Home") {
      e.preventDefault()
      setFocus(0)
    } else if (e.key === "End") {
      e.preventDefault()
      setFocus(nodes.length - 1)
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const n = nodes[focus]
      if (n) onSelect(n.id)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground tabular-nums">
          {q.isLoading ? "Loading…" : `${nodes.length} node${nodes.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {q.isError && (
        <EmptyState icon={AlertCircleIcon} tone="destructive" title="Failed to load nodes" />
      )}

      {q.isLoading && (
        <div className="flex flex-col gap-1.5 p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}

      {!q.isLoading && !q.isError && nodes.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="No nodes match"
          hint="Adjust the NodeType, search, or as-of filters."
        />
      )}

      {nodes.length > 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div
            role="listbox"
            aria-label="Nodes"
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="flex flex-col p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            {nodes.map((n, i) => {
              const selected = n.id === selectedId
              return (
                <div
                  key={n.id}
                  ref={i === focus ? activeRef : undefined}
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    setFocus(i)
                    onSelect(n.id)
                  }}
                  className={cn(
                    "group grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    "hover:bg-accent/60",
                    selected && "bg-accent",
                    i === focus && !selected && "bg-accent/40",
                  )}
                >
                  <NodeTypeBadge type={n.type} />
                  <span className="truncate font-mono text-xs" title={n.id}>
                    {shortId(n.id, 10, 6)}
                  </span>
                  <CopyButton
                    value={n.id}
                    label="Copy id"
                    className="opacity-0 group-hover:opacity-100"
                  />
                </div>
              )
            })}
          </div>
        </ScrollArea>
      )}

      {q.hasNextPage && (
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={q.isFetchingNextPage}
            onClick={() => q.fetchNextPage()}
          >
            {q.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  )
}
