import { useEffect, useRef, useState } from "react"
import { AlertCircleIcon, InboxIcon } from "@hugeicons/core-free-icons"
import { CopyButton } from "@/components/copy-button"
import { EmptyState } from "@/components/empty-state"
import { TypeDot } from "@/components/type-dot"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useNodes, useRetrieval } from "@/hooks/use-graph"
import { colorForType } from "@/lib/graph-style"
import { bestLabel, shortId } from "@/lib/format"
import type { ExplorerFilters } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * One list row, from either source. `type`/`data` are absent for a retrieved node that is not on
 * the loaded page of `GET /nodes`; `body` and `depth` are present only for retrieved rows.
 */
interface Row {
  id: string
  type?: string
  data?: Record<string, unknown>
  body?: string | null
  depth?: number
}

/** Master node list: keyset-paginated, arrow-key navigable, selection drives canvas + detail. */
export function NodeList({
  tenant,
  project,
  filters,
  selectedId,
  onSelect,
  className,
}: {
  tenant: string
  project: string
  filters: ExplorerFilters
  selectedId?: string
  onSelect: (id: string) => void
  className?: string
}) {
  // Two sources, one list. `text` mode paginates `GET /nodes`; the retrieval modes hit
  // /retrieve or /hybrid, which return a bounded subgraph — no paging, and a hop `depth` per row.
  const retrieving = (filters.mode ?? "text") !== "text" && Boolean(filters.q?.trim())
  // While retrieving, the node list is still fetched UNFILTERED: retrieval returns ids and body
  // only, so type and parsed data have to come from here. A retrieved node beyond the first page
  // simply renders without them rather than being dropped.
  const listQuery = useNodes(tenant, project, retrieving ? {} : filters)
  const retrievalQuery = useRetrieval(tenant, project, filters)

  const listed = listQuery.data?.pages.flatMap((p) => p.nodes) ?? []
  const byId = new Map(listed.map((n) => [n.id, n]))
  const rows: Row[] = retrieving
    ? (retrievalQuery.data ?? []).map((r) => ({
        id: r.id,
        type: byId.get(r.id)?.type,
        data: byId.get(r.id)?.data,
        body: r.body,
        depth: r.depth,
      }))
    : listed.map((n) => ({ id: n.id, type: n.type, data: n.data }))

  const isLoading = retrieving
    ? retrievalQuery.isLoading || listQuery.isLoading
    : listQuery.isLoading
  const isError = retrieving ? retrievalQuery.isError || listQuery.isError : listQuery.isError

  // Roving keyboard focus within the listbox (independent of URL selection).
  const [focus, setFocus] = useState(0)
  const activeRef = useRef<HTMLDivElement>(null)

  // Keep focus on the selected row when selection changes externally (canvas/palette click).
  useEffect(() => {
    if (!selectedId) return
    const i = rows.findIndex((n) => n.id === selectedId)
    if (i >= 0) setFocus(i)
    // rows identity changes each render; key on selectedId + length only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rows.length])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [focus])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setFocus((f) => Math.min(f + 1, rows.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setFocus((f) => Math.max(f - 1, 0))
    } else if (e.key === "Home") {
      e.preventDefault()
      setFocus(0)
    } else if (e.key === "End") {
      e.preventDefault()
      setFocus(rows.length - 1)
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const n = rows[focus]
      if (n) onSelect(n.id)
    }
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
          {retrieving ? (filters.mode === "hybrid" ? "Hybrid results" : "Vector results") : "Nodes"}
        </span>
        <span className="text-xs font-medium text-muted-foreground tabular-nums">
          {isLoading ? "Loading…" : rows.length}
        </span>
      </div>

      {isError && (
        <EmptyState
          icon={AlertCircleIcon}
          tone="destructive"
          title={retrieving ? "Retrieval failed" : "Failed to load nodes"}
          hint={retrieving ? "The server may have no embedder configured (501)." : undefined}
        />
      )}

      {isLoading && (
        <div className="flex flex-col gap-1.5 p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title="No nodes match"
          hint="Adjust the NodeType, search, or as-of filters."
        />
      )}

      {rows.length > 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div
            role="listbox"
            aria-label="Nodes"
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="flex flex-col p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            {rows.map((n, i) => {
              const selected = n.id === selectedId
              const label = bestLabel(n.data)
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
                    "group relative flex cursor-pointer items-center gap-2.5 rounded-md py-1.5 pr-1.5 pl-3 text-left transition-colors",
                    "hover:bg-accent/50",
                    selected && "bg-accent",
                    i === focus && !selected && "bg-accent/30",
                  )}
                >
                  {/* type-color accent rail — ties selection back to the node's data identity */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-1.5 left-1 w-0.5 rounded-full transition-opacity",
                      selected ? "opacity-100" : "opacity-0 group-hover:opacity-40",
                    )}
                    style={{ backgroundColor: colorForType(n.type ?? "") }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <TypeDot type={n.type ?? ""} />
                      {label ? (
                        <span className="truncate text-sm leading-tight font-medium">{label}</span>
                      ) : (
                        <span className="truncate font-mono text-xs leading-tight" title={n.id}>
                          {shortId(n.id, 12, 8)}
                        </span>
                      )}
                      {/* Hop distance from the seed. The server orders retrieval results by
                          depth, not by relevance, so the badge makes that ordering legible
                          instead of letting it read as a relevance rank. */}
                      {n.depth !== undefined && n.depth > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-secondary px-1.5 text-[0.6rem] text-muted-foreground">
                          {n.depth} hop
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-[0.9rem] text-[0.7rem] text-muted-foreground">
                      {n.type ? (
                        <span className="lowercase">{n.type}</span>
                      ) : (
                        <span className="truncate italic">{n.body ?? "—"}</span>
                      )}
                      {label && n.type && (
                        <>
                          <span className="opacity-40">·</span>
                          <span className="truncate font-mono" title={n.id}>
                            {shortId(n.id, 8, 6)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
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

      {/* Retrieval returns a bounded subgraph in one shot — there is nothing to page through. */}
      {!retrieving && listQuery.hasNextPage && (
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={listQuery.isFetchingNextPage}
            onClick={() => listQuery.fetchNextPage()}
          >
            {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  )
}
