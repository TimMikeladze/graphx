import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AlertCircleIcon,
  Cancel01Icon,
  GitBranchIcon,
  InboxIcon,
} from "@hugeicons/core-free-icons"
import { ContentTab } from "@/components/content-tab"
import { CopyButton } from "@/components/copy-button"
import { EmptyState } from "@/components/empty-state"
import { NodeTypeBadge, TypeDot } from "@/components/type-dot"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useHistory, useNeighbors, useNode } from "@/hooks/use-graph"
import { bestLabel, FOREVER, fmtTime, shortId } from "@/lib/format"
import type { GraphNode } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Render one property value: primitives inline, objects/arrays as compact JSON. */
function valueText(v: unknown): string {
  if (v === null) return "null"
  if (typeof v === "string") return v
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

function PropertyGrid({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data)
  if (entries.length === 0)
    return <p className="px-1 py-2 text-xs text-muted-foreground">No properties.</p>
  return (
    <dl className="flex flex-col">
      {entries.map(([k, v]) => {
        const text = valueText(v)
        return (
          <div
            key={k}
            className="group grid grid-cols-[minmax(0,7rem)_1fr_auto] items-start gap-2 border-b border-border/50 py-1.5 last:border-0"
          >
            <dt className="truncate pt-px font-mono text-xs text-muted-foreground" title={k}>
              {k}
            </dt>
            <dd className="min-w-0 text-xs break-words whitespace-pre-wrap">{text}</dd>
            <CopyButton
              value={text}
              label={`Copy ${k}`}
              className="opacity-0 group-hover:opacity-100"
            />
          </div>
        )
      })}
    </dl>
  )
}

function Properties({ node }: { node?: GraphNode }) {
  const [raw, setRaw] = useState(false)
  if (!node)
    return (
      <div className="flex flex-col gap-2 p-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    )
  const data = (node.data ?? {}) as Record<string, unknown>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button variant="ghost" size="xs" onClick={() => setRaw((r) => !r)}>
          {raw ? "Table" : "Raw JSON"}
        </Button>
      </div>
      {raw ? (
        <pre className="rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : (
        <PropertyGrid data={data} />
      )}
    </div>
  )
}

function Neighbors({
  neighbors,
  isLoading,
  isError,
  onSelect,
}: {
  neighbors?: GraphNode[]
  isLoading: boolean
  isError: boolean
  onSelect: (id: string) => void
}) {
  if (isLoading)
    return (
      <div className="flex flex-col gap-2 p-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    )
  if (isError)
    return (
      <EmptyState icon={AlertCircleIcon} tone="destructive" title="Failed to load neighbors" />
    )
  if (!neighbors || neighbors.length === 0)
    return <EmptyState icon={GitBranchIcon} title="No neighbors" hint="This node has no edges in view." />

  // Group by type — the neighbors endpoint carries id + type only (no rel/direction).
  const groups = new Map<string, GraphNode[]>()
  for (const n of neighbors) {
    const g = groups.get(n.type) ?? []
    g.push(n)
    groups.set(n.type, g)
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  return (
    <div className="flex flex-col gap-3">
      {sorted.map(([type, items]) => (
        <div key={type}>
          <div className="mb-1 flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <TypeDot type={type} />
            <span className="font-medium text-foreground">{type}</span>
            <span className="tabular-nums">· {items.length}</span>
          </div>
          <ul className="flex flex-col">
            {items.map((n) => (
              <li key={n.id} className="group">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(n.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onSelect(n.id)
                    }
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30"
                >
                  <span className="truncate font-mono text-xs" title={n.id}>
                    {shortId(n.id, 10, 6)}
                  </span>
                  <CopyButton
                    value={n.id}
                    label="Copy id"
                    className="ml-auto opacity-0 group-hover:opacity-100"
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function History({
  versions,
  isLoading,
  isError,
}: {
  versions?: { ver: number; type: string; valid_from: number; valid_to: number }[]
  isLoading: boolean
  isError: boolean
}) {
  if (isLoading)
    return (
      <div className="flex flex-col gap-2 p-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  if (isError)
    return <EmptyState icon={AlertCircleIcon} tone="destructive" title="Failed to load history" />
  if (!versions || versions.length === 0)
    return <EmptyState icon={InboxIcon} title="No history" />

  const ordered = [...versions].sort((a, b) => b.ver - a.ver)
  return (
    <ol className="relative ml-2 flex flex-col gap-4 border-l border-border pl-4">
      {ordered.map((v) => {
        const live = v.valid_to >= FOREVER
        return (
          <li key={v.ver} className="relative">
            <span
              className={cn(
                "absolute top-1 -left-[1.3rem] size-2.5 rounded-full ring-4 ring-background",
                live ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="tabular-nums">
                v{v.ver}
              </Badge>
              {live && (
                <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  live
                </Badge>
              )}
            </div>
            <div className="mt-1 text-xs text-muted-foreground tabular-nums">
              {fmtTime(v.valid_from)} → {fmtTime(v.valid_to)}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The selected node inspector body — Properties · Neighbors · History. Shared verbatim by the
 * docked explorer panel (desktop) and the slide-over Sheet (mobile), so both stay in lockstep.
 */
export function NodeDetail({
  tenant,
  project,
  nodeId,
  onSelect,
  onClose,
}: {
  tenant: string
  project: string
  nodeId: string
  onSelect: (id: string) => void
  onClose?: () => void
}) {
  // Controlled so the Content tab knows when it is on screen (it gates its own fetch on that).
  const [tab, setTab] = useState("data")
  const node = useNode(tenant, project, nodeId)
  const neighbors = useNeighbors(tenant, project, nodeId)
  const history = useHistory(tenant, project, nodeId)

  const label = node.data ? bestLabel(node.data.data) : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b px-3 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {node.data ? (
            <>
              {label && (
                <h2 className="truncate text-base leading-tight font-semibold" title={label}>
                  {label}
                </h2>
              )}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <NodeTypeBadge type={node.data.type} />
                <span className="inline-flex items-center gap-1">
                  <span
                    className="truncate font-mono text-[0.7rem] text-muted-foreground"
                    title={nodeId}
                  >
                    {shortId(nodeId, 10, 8)}
                  </span>
                  <CopyButton value={nodeId} label="Copy id" />
                </span>
              </div>
            </>
          ) : (
            <>
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-4 w-24" />
            </>
          )}
        </div>
        {onClose && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        )}
      </div>

      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col gap-2 p-3"
      >
        <TabsList className="w-full">
          <TabsTrigger value="data">Properties</TabsTrigger>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="neighbors">
            Neighbors
            {neighbors.data && neighbors.data.length > 0 && (
              <Badge variant="secondary" className="ml-1 tabular-nums">
                {neighbors.data.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="data" className="min-h-0 flex-1">
          <ScrollArea className="h-full pr-2">
            <Properties node={node.data} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="content" className="min-h-0 flex-1">
          <ContentTab
            tenant={tenant}
            project={project}
            nodeId={nodeId}
            active={tab === "content"}
          />
        </TabsContent>
        <TabsContent value="neighbors" className="min-h-0 flex-1">
          <ScrollArea className="h-full pr-2">
            <Neighbors
              neighbors={neighbors.data}
              isLoading={neighbors.isLoading}
              isError={neighbors.isError}
              onSelect={onSelect}
            />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="history" className="min-h-0 flex-1">
          <ScrollArea className="h-full pr-2">
            <History
              versions={history.data}
              isLoading={history.isLoading}
              isError={history.isError}
            />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}
