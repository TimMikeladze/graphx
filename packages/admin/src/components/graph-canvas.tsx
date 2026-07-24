import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Cosmograph, type CosmographRef } from "@cosmograph/react"
import { AlertCircleIcon, ChartRelationshipIcon } from "@hugeicons/core-free-icons"
import { EmptyState } from "@/components/empty-state"
import { GraphToolbar } from "@/components/graph-toolbar"
import { ErrorBoundary } from "@/components/error-boundary"
import { colorForType, type CosmoNode, legendOf, toCosmograph } from "@/lib/cosmograph-adapter"
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
  // Selection is applied imperatively (selectPoint below), so it must NOT change the points
  // identity — otherwise every click rebuilds the graph and re-fits, fighting the zoom-to-node.
  const data = useMemo(
    () => (slice ? toCosmograph(slice) : { nodes: [], links: [] }),
    [slice],
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
      <div className="dark canvas-atmos h-full w-full text-foreground">
        <EmptyState
          icon={ChartRelationshipIcon}
          title="Loading graph…"
          className="animate-pulse"
        />
      </div>
    )
  }
  if (!slice || slice.nodes.length === 0) {
    return (
      <div className="dark canvas-atmos h-full w-full text-foreground">
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
    <div
      ref={containerRef}
      className="dark relative h-full w-full text-foreground"
      style={{ background: CANVAS_BG }}
    >
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
          pointColorByFn={(value: unknown) => String(value)}
          pointSizeStrategy="degree"
          pointSizeRange={[11, 34]}
          pointDefaultSize={13}
          simulationGravity={0.4}
          simulationCenter={0.5}
          links={data.links}
          linkWidthBy="weight"
          linkWidthRange={[1, 3]}
          linkSourceBy="source"
          linkSourceIndexBy="sourceIndex"
          linkTargetBy="target"
          linkTargetIndexBy="targetIndex"
          backgroundColor={CANVAS_BG}
          hoveredPointCursor="pointer"
          selectPointOnClick={false}
          fitViewOnInit
          fitViewPadding={0.3}
          onMount={(g) => {
            cosmoRef.current = g
          }}
          onGraphRebuilt={() => cosmoRef.current?.fitView(300)}
          // Keep every node in frame while the force layout blooms open (instant fit each tick),
          // then one smooth fit when it settles. Both are skipped while a node is selected, so the
          // selection's own zoom-to-node isn't fought. This is what makes even a 5-node slice land
          // centered instead of zoomed into a single point.
          onSimulationTick={() => {
            if (selectedId === undefined && !paused) cosmoRef.current?.fitView(0)
          }}
          onSimulationEnd={() => {
            if (selectedId === undefined) cosmoRef.current?.fitView(400)
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

      {/* edge falloff that frames the composition (never covers the centered nodes) */}
      <div className="canvas-vignette pointer-events-none absolute inset-0" />

      {/* stats */}
      <div className="hud pointer-events-none absolute top-3 left-3 flex items-center gap-2 px-2.5 py-1.5 text-xs tabular-nums">
        <span className="font-semibold text-foreground">{slice.nodes.length}</span>
        <span className="text-muted-foreground">nodes</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="font-semibold text-foreground">{slice.links.length}</span>
        <span className="text-muted-foreground">edges</span>
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
          className="hud pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] px-2.5 py-1.5 text-xs"
          style={{ left: hover.x, top: hover.y }}
        >
          <div className="flex items-center gap-1.5 font-medium">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: colorForType(hover.type) }}
            />
            {hover.type}
          </div>
          <div className="mt-0.5 font-mono text-[0.65rem] text-muted-foreground">
            {shortId(hover.id, 8, 6)}
          </div>
        </div>
      )}

      {/* legend / quick type filter */}
      {legend.length > 0 && (
        <div className="hud absolute bottom-3 left-3 flex max-w-[60%] flex-wrap items-center gap-0.5 p-1.5 text-xs">
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
