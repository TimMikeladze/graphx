import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Cosmograph, type CosmographRef } from "@cosmograph/react"
import { AlertCircleIcon, ChartRelationshipIcon } from "@hugeicons/core-free-icons"
import { EmptyState } from "@/components/empty-state"
import { GraphToolbar } from "@/components/graph-toolbar"
import { ErrorBoundary } from "@/components/error-boundary"
import { type CosmoNode, legendOf, toCosmograph } from "@/lib/cosmograph-adapter"
import { shortId } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { GraphSlice } from "@/lib/types"

/** Deep neutral canvas — a concrete color (WebGL can't read CSS vars), darker than the card. */
const CANVAS_BG = "#0a0a0f"

type Hover = { id: string; type: string; x: number; y: number }

/** Cosmograph canvas fed by the governed graph slice (via the pure adapter). */
export function GraphCanvas({
  slice,
  isLoading,
  selectedId,
  onSelect,
  activeType,
  onTypeFilter,
}: {
  slice?: GraphSlice
  isLoading?: boolean
  selectedId?: string
  onSelect: (id: string | undefined) => void
  /** The active NodeType filter (for legend highlighting). */
  activeType?: string
  /** Clicking a legend swatch sets/clears the NodeType filter. */
  onTypeFilter?: (type: string | undefined) => void
}) {
  const data = useMemo(
    () => (slice ? toCosmograph(slice, { selectedId }) : { nodes: [], links: [] }),
    [slice, selectedId],
  )
  // Resolve Cosmograph's click/hover index → our node without re-rendering.
  const pointsRef = useRef<CosmoNode[]>(data.nodes)
  pointsRef.current = data.nodes
  const indexById = useMemo(
    () => new Map(data.nodes.map((n) => [n.id, n.index])),
    [data.nodes],
  )

  const cosmoRef = useRef<CosmographRef>(undefined)
  const containerRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)

  // Selecting a node elsewhere (list/detail/palette) highlights it + its neighbors and centers it.
  useEffect(() => {
    const g = cosmoRef.current
    if (!g) return
    try {
      if (selectedId !== undefined && indexById.has(selectedId)) {
        const idx = indexById.get(selectedId) as number
        g.selectPoint(idx, false, true)
        g.zoomToPoint(idx, 400, 5, true)
      } else {
        g.selectPoints(null)
      }
    } catch {
      // Method called before the graph finished (re)building — safe to ignore.
    }
  }, [selectedId, indexById])

  const togglePause = useCallback(() => {
    setPaused((p) => {
      const g = cosmoRef.current
      if (g) {
        if (p) g.start()
        else g.pause()
      }
      return !p
    })
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }, [])

  if (isLoading) {
    return (
      <div className="h-full w-full" style={{ background: CANVAS_BG }}>
        <EmptyState
          icon={ChartRelationshipIcon}
          title="Loading graph…"
          className="text-muted-foreground"
        />
      </div>
    )
  }
  if (!slice || slice.nodes.length === 0) {
    return (
      <div className="h-full w-full" style={{ background: CANVAS_BG }}>
        <EmptyState
          icon={ChartRelationshipIcon}
          title="No graph for these filters"
          hint="Broaden the NodeType or search filters to see connected nodes."
        />
      </div>
    )
  }

  const legend = legendOf(slice)

  return (
    <div ref={containerRef} className="relative h-full w-full" style={{ background: CANVAS_BG }}>
      <ErrorBoundary
        fallback={
          <EmptyState
            icon={AlertCircleIcon}
            tone="destructive"
            title="Graph canvas unavailable"
            hint="This view needs a WebGL-capable browser/GPU."
          />
        }
      >
        <Cosmograph
          points={data.nodes}
          pointIdBy="id"
          pointIndexBy="index"
          pointColorBy="color"
          pointSizeStrategy="degree"
          pointSizeRange={[3, 11]}
          links={data.links}
          linkSourceBy="source"
          linkSourceIndexBy="sourceIndex"
          linkTargetBy="target"
          linkTargetIndexBy="targetIndex"
          backgroundColor={CANVAS_BG}
          hoveredPointCursor="pointer"
          selectPointOnClick={false}
          onMount={(g) => {
            cosmoRef.current = g
          }}
          onClick={(index) =>
            onSelect(index === undefined ? undefined : pointsRef.current[index]?.id)
          }
          onPointMouseOver={(index, pointPosition) => {
            const n = pointsRef.current[index]
            if (n && pointPosition)
              setHover({ id: n.id, type: n.type, x: pointPosition[0], y: pointPosition[1] })
          }}
          onPointMouseOut={() => setHover(null)}
          style={{ width: "100%", height: "100%" }}
        />
      </ErrorBoundary>

      {/* stats */}
      <div className="pointer-events-none absolute top-3 left-3 rounded-md border bg-background/80 px-2 py-1 text-xs text-muted-foreground tabular-nums backdrop-blur-sm">
        {slice.nodes.length} nodes · {slice.links.length} edges
      </div>

      <GraphToolbar
        paused={paused}
        onFit={() => cosmoRef.current?.fitView(400)}
        onZoomIn={() =>
          cosmoRef.current?.setZoomLevel((cosmoRef.current?.getZoomLevel() ?? 1) * 1.4, 300)
        }
        onZoomOut={() =>
          cosmoRef.current?.setZoomLevel((cosmoRef.current?.getZoomLevel() ?? 1) / 1.4, 300)
        }
        onTogglePause={togglePause}
        onToggleFullscreen={toggleFullscreen}
      />

      {/* hover tooltip */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: hover.x, top: hover.y }}
        >
          <div className="font-medium">{hover.type}</div>
          <div className="font-mono text-[0.65rem] text-muted-foreground">{shortId(hover.id, 8, 6)}</div>
        </div>
      )}

      {/* legend / quick type filter */}
      {legend.length > 0 && (
        <div className="absolute bottom-3 left-3 flex max-w-[60%] flex-wrap gap-1 rounded-lg border bg-background/80 p-1.5 text-xs backdrop-blur-sm">
          {legend.map((l) => {
            const active = activeType === l.type
            return (
              <button
                key={l.type}
                type="button"
                disabled={!onTypeFilter}
                onClick={() => onTypeFilter?.(active ? undefined : l.type)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors",
                  onTypeFilter && "hover:bg-accent",
                  active && "bg-accent font-medium",
                  activeType && !active && "opacity-40",
                )}
                title={onTypeFilter ? `Filter to ${l.type}` : l.type}
              >
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                {l.type}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
