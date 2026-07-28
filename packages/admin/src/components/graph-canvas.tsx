import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Cosmograph, type CosmographRef } from "@cosmograph/react"
import { AlertCircleIcon, ChartRelationshipIcon } from "@hugeicons/core-free-icons"
import { EmptyState } from "@/components/empty-state"
import { GraphToolbar } from "@/components/graph-toolbar"
import { ErrorBoundary } from "@/components/error-boundary"
import {
  colorForType,
  type CosmoNode,
  DEFAULT_LABEL_SETTINGS,
  LABEL_COLUMN,
  type LabelSettings,
  legendOf,
  toCosmograph,
} from "@/lib/cosmograph-adapter"
import { shortId } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { GraphSlice } from "@/lib/types"

/** Deep neutral canvas — a concrete color (WebGL can't read CSS vars), darker than the card. */
const CANVAS_BG = "#0a0a0f"

/**
 * Below this many links, edge labels are drawn for every edge. Above it they are drawn only for
 * the edges touching the focused (selected or hovered) node — 10k rel names would be an
 * unreadable smear, and each one costs a positioned DOM node.
 */
const EDGE_LABEL_ALL_MAX = 150

/** Hard ceiling on edge labels, so a hub with thousands of edges cannot flood the canvas. */
const EDGE_LABEL_MAX = 80

/** How often edge label positions are recomputed while the layout is still moving. */
const EDGE_LABEL_THROTTLE_MS = 200

/**
 * How long the force layout is allowed to run before it is frozen.
 *
 * A big slice never reaches Cosmograph's own end-of-simulation, so without this the nodes drift
 * and jitter forever. The layout is worth watching while it opens up and worthless after that,
 * so it is paused on a budget; the toolbar's play button resumes it.
 */
const SETTLE_MS = 8000

/**
 * Every caption column, declared so Cosmograph keeps them in the point data. Module-level so its
 * identity is stable across renders and cannot look like a config change.
 */
const CAPTION_COLUMNS = Object.values(LABEL_COLUMN)

type Hover = { id: string; type: string; x: number; y: number }

/** One edge caption: the rel name, placed at the midpoint of its two endpoints (space coords). */
type EdgeLabel = { text: string; position: [number, number]; weight: number; style: string }

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
  const [labelSettings, setLabelSettings] = useState<LabelSettings>(DEFAULT_LABEL_SETTINGS)
  const [edgeLabels, setEdgeLabels] = useState<EdgeLabel[]>([])
  const showNodeLabels = labelSettings.source !== "off"
  const showEdgeLabels = labelSettings.edges

  // Read inside Cosmograph's callbacks, which are invoked at simulation-tick rate: reading refs
  // keeps them correct without re-subscribing (and without a stale closure) on every render.
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const hoverIdRef = useRef<string | undefined>(undefined)
  hoverIdRef.current = hover?.id

  /**
   * Whether the canvas may still auto-fit as the layout settles.
   *
   * The force layout is only worth framing automatically until the user takes over. It is
   * re-armed for each new slice and disarmed by the first zoom/pan — without that, a graph big
   * enough that the simulation never settles (10k nodes) re-fits on every tick and snaps the
   * view back the instant you zoom in.
   */
  const autoFitRef = useRef(true)
  useEffect(() => {
    autoFitRef.current = true
  }, [data])
  const releaseAutoFit = useCallback(() => {
    autoFitRef.current = false
  }, [])

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

  /**
   * Rebuild the edge captions from the live point positions. Cosmograph has no link labels, so
   * these are custom labels placed at edge midpoints in space coordinates — which means the
   * library transforms them on zoom for free, and only a moving layout forces a recompute.
   */
  const lastEdgeLabelAt = useRef(0)
  const rebuildEdgeLabels = useCallback(() => {
    if (!showEdgeLabels) {
      setEdgeLabels((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const g = cosmoRef.current
    if (!g) return

    const focus = selectedRef.current ?? hoverIdRef.current
    const links = data.links
    const chosen = (
      links.length <= EDGE_LABEL_ALL_MAX
        ? links
        : focus === undefined
          ? []
          : links.filter((l) => l.source === focus || l.target === focus)
    ).slice(0, EDGE_LABEL_MAX)

    if (chosen.length === 0) {
      setEdgeLabels((prev) => (prev.length === 0 ? prev : []))
      return
    }

    // Endpoint coordinates come from the renderer's *tracked* set, which has to be registered
    // before it can be read — and the registration only lands on the next frame. Reading
    // `getPointPositions()` instead returns an empty array, which silently collapsed every
    // midpoint onto the origin rather than failing.
    const endpoints = [...new Set(chosen.flatMap((l) => [l.sourceIndex, l.targetIndex]))]
    g.trackPointPositionsByIndices(endpoints)
    // Stamp the attempt, not the success, so a frame that reads nothing back cannot make the
    // tick handler retry at full tick rate.
    lastEdgeLabelAt.current = Date.now()
    requestAnimationFrame(() => {
      const positions = g.getTrackedPointPositionsMap()
      if (!positions || positions.size === 0) return
      const labels: EdgeLabel[] = []
      for (const l of chosen) {
        const a = positions.get(l.sourceIndex)
        const b = positions.get(l.targetIndex)
        if (!a || !b) continue
        labels.push({
          text: l.rel,
          position: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
          weight: 0.55, // below the point labels', so a crowded area drops rels before names
          style: "background: #1a1a24cc; color: #d4d4e4; font-size: 10px;",
        })
      }
      setEdgeLabels(labels)
    })
  }, [data.links, showEdgeLabels])

  // Selection/hover changes the focused edge set; toggling recomputes from scratch. The delayed
  // second pass is not redundant: selecting a node also starts a 400ms zoom-to-node, and
  // Cosmograph's label pipeline short-circuits while it is zooming, so the immediate rebuild can
  // land in a window where it is ignored — and the midpoints it computed are pre-zoom anyway.
  useEffect(() => {
    rebuildEdgeLabels()
    const settled = setTimeout(rebuildEdgeLabels, 600)
    return () => clearTimeout(settled)
  }, [rebuildEdgeLabels, selectedId, hover?.id])

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

  /** Stop the layout where it stands (one last fit + edge-label pass, then freeze). */
  const freeze = useCallback(() => {
    const g = cosmoRef.current
    if (!g || pausedRef.current) return
    if (autoFitRef.current && selectedRef.current === undefined) g.fitView(400)
    g.pause()
    setPaused(true)
    rebuildEdgeLabels()
  }, [rebuildEdgeLabels])

  /**
   * Arm the freeze budget. Anchored to `onGraphRebuilt`, NOT to the data arriving: Cosmograph
   * uploads the slice into duckdb and lays it out before it draws anything, which takes tens of
   * seconds at 10k points. A timer started when the fetch resolves would fire mid-build and
   * pause a graph that has no positions yet — a blank canvas.
   */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const armSettle = useCallback(() => {
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(freeze, SETTLE_MS)
  }, [freeze])
  useEffect(() => () => clearTimeout(settleTimer.current), [])

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
      // Any zoom or drag on the canvas hands the view to the user; capture so it registers even
      // though the WebGL canvas handles the event itself.
      onWheelCapture={releaseAutoFit}
      onPointerDownCapture={releaseAutoFit}
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
          // Cool down fast and damp hard (defaults: 5000 decay, 0.85 friction). A slice this size
          // is readable long before a leisurely simulation would settle, and the slow default
          // reads as nodes jittering in place.
          simulationDecay={1000}
          simulationFriction={0.72}
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
          // Switching between materialized caption columns is a label-only update; pointing at
          // a column that does not exist would blank every label, so `off` keeps the last real
          // column and relies on `showLabels` instead.
          pointLabelBy={
            labelSettings.source === "off"
              ? LABEL_COLUMN.name
              : LABEL_COLUMN[labelSettings.source]
          }
          // Columns Cosmograph does not consume itself are dropped from the point data unless
          // they are declared here — without this, pointing `pointLabelBy` at one of the other
          // caption columns finds nothing and the captions never change.
          pointIncludeColumns={CAPTION_COLUMNS}
          // `showLabels` is the master switch for every non-hovered label, custom ones included,
          // so it is on whenever either kind is wanted; the rest scope it to point labels.
          showLabels={showNodeLabels || showEdgeLabels}
          showDynamicLabels={showNodeLabels}
          showTopLabels={showNodeLabels}
          showTopLabelsLimit={labelSettings.limit}
          showDynamicLabelsLimit={labelSettings.limit}
          showHoveredPointLabel={showNodeLabels}
          pointLabelFontSize={12}
          customLabels={showEdgeLabels ? edgeLabels : undefined}
          onMount={(g) => {
            cosmoRef.current = g
          }}
          onGraphRebuilt={() => {
            // A rebuilt graph starts its own simulation, so clear a freeze left over from the
            // previous slice — otherwise the toolbar says paused and the new layout never fits.
            pausedRef.current = false
            setPaused(false)
            cosmoRef.current?.fitView(300)
            armSettle()
          }}
          // Frame the layout as it blooms open (instant fit each tick), then one smooth fit when
          // it settles. Skipped once the user has taken over the view (see `autoFitRef`) or while
          // a node is selected, so neither a manual zoom nor the selection's zoom-to-node is
          // fought. This is also what makes a 5-node slice land centered rather than zoomed into
          // a single point.
          onSimulationTick={() => {
            if (autoFitRef.current && selectedRef.current === undefined && !pausedRef.current) {
              cosmoRef.current?.fitView(0)
            }
            // Edge captions follow the moving points, but at a fraction of the tick rate.
            if (showEdgeLabels && Date.now() - lastEdgeLabelAt.current > EDGE_LABEL_THROTTLE_MS) {
              rebuildEdgeLabels()
            }
          }}
          // Cosmograph reached its own end before the budget did — freeze there instead.
          onSimulationEnd={freeze}
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
        labels={labelSettings}
        onLabelsChange={setLabelSettings}
        onFit={() => {
          // An explicit fit is still the user driving — do not resume auto-fitting after it.
          releaseAutoFit()
          cosmoRef.current?.fitView(400)
        }}
        onZoomIn={() => {
          releaseAutoFit()
          cosmoRef.current?.setZoomLevel((cosmoRef.current?.getZoomLevel() ?? 1) * 1.4, 300)
        }}
        onZoomOut={() => {
          releaseAutoFit()
          cosmoRef.current?.setZoomLevel((cosmoRef.current?.getZoomLevel() ?? 1) / 1.4, 300)
        }}
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
