import { useCallback, useRef, useState } from "react"
import { AlertCircleIcon, ChartRelationshipIcon } from "@hugeicons/core-free-icons"
import { EmptyState } from "@/components/empty-state"
import { ErrorBoundary } from "@/components/error-boundary"
import { FlowCanvas } from "@/components/flow-canvas"
import { CANVAS_BG, GraphCanvas } from "@/components/graph-canvas"
import { GraphToolbar } from "@/components/graph-toolbar"
import { DEFAULT_LABEL_SETTINGS, type LabelSettings, legendOf } from "@/lib/graph-style"
import { cn } from "@/lib/utils"
import type { FlowLayout, GraphSlice, Renderer, RendererHandle } from "@/lib/types"

/**
 * The canvas frame: everything around the graph that both renderers share — loading and empty
 * states, the stats pill, the legend/type filter, the toolbar, and the fullscreen container.
 * The renderers themselves ({@link GraphCanvas}, {@link FlowCanvas}) only draw the graph and
 * answer the toolbar through a {@link RendererHandle}.
 */
export function GraphShell({
  slice,
  isLoading,
  selectedId,
  onSelect,
  activeType,
  onTypeFilter,
  renderer,
  onRendererChange,
  flowLayout,
  onFlowLayoutChange,
}: {
  slice?: GraphSlice
  isLoading?: boolean
  selectedId?: string
  onSelect: (id: string | undefined) => void
  /** The active NodeType filter (for legend highlighting). */
  activeType?: string
  /** Clicking a legend swatch sets/clears the NodeType filter. */
  onTypeFilter?: (type: string | undefined) => void
  renderer: Renderer
  onRendererChange: (renderer: Renderer) => void
  flowLayout: FlowLayout
  onFlowLayoutChange: (layout: FlowLayout) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Only one renderer is mounted at a time, so one handle is enough — React clears it on unmount.
  const rendererRef = useRef<RendererHandle | null>(null)
  const [labels, setLabels] = useState<LabelSettings>(DEFAULT_LABEL_SETTINGS)
  const [paused, setPaused] = useState(false)

  const isCosmograph = renderer === "cosmograph"

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }, [])

  // The WebGL canvas is a fixed dark scene; the DOM renderer follows the app theme.
  const backdrop = isCosmograph ? "dark canvas-atmos text-foreground" : "bg-background"

  if (isLoading) {
    return (
      <div className={cn("h-full w-full", backdrop)}>
        <EmptyState icon={ChartRelationshipIcon} title="Loading graph…" className="animate-pulse" />
      </div>
    )
  }
  if (!slice || slice.nodes.length === 0) {
    return (
      <div className={cn("h-full w-full", backdrop)}>
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
      className={cn("relative h-full w-full", isCosmograph && "dark text-foreground")}
      style={isCosmograph ? { background: CANVAS_BG } : undefined}
    >
      <ErrorBoundary
        // Remount the boundary with the renderer, so switching away from a crashed canvas
        // shows the other one rather than the fallback.
        key={renderer}
        fallback={
          <EmptyState
            icon={AlertCircleIcon}
            tone="destructive"
            title="Graph canvas unavailable"
            hint={
              isCosmograph
                ? "This view needs a WebGL-capable browser/GPU. The flow renderer draws plain DOM and may work here."
                : "The flow renderer failed to draw this slice."
            }
          />
        }
      >
        {isCosmograph ? (
          <GraphCanvas
            slice={slice}
            selectedId={selectedId}
            onSelect={onSelect}
            labels={labels}
            paused={paused}
            onPausedChange={setPaused}
            handleRef={rendererRef}
          />
        ) : (
          <FlowCanvas
            slice={slice}
            selectedId={selectedId}
            onSelect={onSelect}
            labels={labels}
            layout={flowLayout}
            onSwitchToCosmograph={() => onRendererChange("cosmograph")}
            handleRef={rendererRef}
          />
        )}
      </ErrorBoundary>

      {/* edge falloff that frames the composition (never covers the centered nodes) */}
      {isCosmograph && <div className="canvas-vignette pointer-events-none absolute inset-0" />}

      {/* stats */}
      <div className="hud pointer-events-none absolute top-3 left-3 flex items-center gap-2 px-2.5 py-1.5 text-xs tabular-nums">
        <span className="font-semibold text-foreground">{slice.nodes.length}</span>
        <span className="text-muted-foreground">nodes</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="font-semibold text-foreground">{slice.links.length}</span>
        <span className="text-muted-foreground">edges</span>
      </div>

      <GraphToolbar
        renderer={renderer}
        onRendererChange={onRendererChange}
        flowLayout={flowLayout}
        onFlowLayoutChange={onFlowLayoutChange}
        paused={paused}
        labels={labels}
        onLabelsChange={setLabels}
        onFit={() => rendererRef.current?.fit()}
        onZoomIn={() => rendererRef.current?.zoomIn()}
        onZoomOut={() => rendererRef.current?.zoomOut()}
        onTogglePause={() => setPaused((p) => !p)}
        onToggleFullscreen={toggleFullscreen}
      />

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
