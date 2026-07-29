import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { Cosmograph, type CosmographRef } from "@cosmograph/react"
import {
  type CosmoNode,
  IMAGE_COLUMN,
  LABEL_COLUMN,
  sliceHasImages,
  toCosmograph,
} from "@/lib/cosmograph-adapter"
import { colorForType, type LabelSettings } from "@/lib/graph-style"
import { shortId } from "@/lib/format"
import type { GraphSlice, RendererHandle } from "@/lib/types"

/** Deep neutral canvas — a concrete color (WebGL can't read CSS vars), darker than the card. */
export const CANVAS_BG = "#0a0a0f"

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
 * Every caption column plus the avatar URL, declared so Cosmograph keeps them in the point data.
 * The image column is declared even while pictures are off: a column Cosmograph does not consume
 * at upload time is dropped, and turning the toggle on later would then find nothing.
 * Module-level so its identity is stable across renders and cannot look like a config change.
 */
const EXTRA_COLUMNS = [...Object.values(LABEL_COLUMN), IMAGE_COLUMN]

/**
 * On-canvas size of a node's avatar, in pixels. Sits between the smallest and largest degree-sized
 * point (11–34) so a picture neither vanishes on a leaf nor swamps a hub.
 */
const IMAGE_SIZE = 26

type Hover = { id: string; type: string; x: number; y: number }

/** One edge caption: the rel name, placed at the midpoint of its two endpoints (space coords). */
type EdgeLabel = { text: string; position: [number, number]; weight: number; style: string }

/**
 * Cosmograph renderer: a WebGL force canvas fed by the governed graph slice (via the pure
 * adapter). Mounted by `GraphShell`, which owns the chrome around it (toolbar, legend, stats).
 */
export function GraphCanvas({
  slice,
  selectedId,
  onSelect,
  labels,
  paused,
  onPausedChange,
  pinned,
  handleRef,
}: {
  slice: GraphSlice
  selectedId?: string
  onSelect: (id: string | undefined) => void
  labels: LabelSettings
  /** The simulation's run state, lifted so the shared toolbar can show and toggle it. */
  paused: boolean
  onPausedChange: (paused: boolean) => void
  /**
   * Hold the simulation still independent of `paused`. Kept as its own prop rather than folded
   * into `paused` by the caller: playback re-pins across every rebuilt slice, and if that had to
   * travel back through `paused`/`onPausedChange` it could arrive as a no-op (the state already
   * reads what it is being set to) and silently stop taking effect — see `onGraphRebuilt` below.
   */
  pinned?: boolean
  handleRef: React.RefObject<RendererHandle | null>
}) {
  // Selection is applied imperatively (selectPoint below), so it must NOT change the points
  // identity — otherwise every click rebuilds the graph and re-fits, fighting the zoom-to-node.
  const data = useMemo(() => toCosmograph(slice), [slice])
  // Resolve Cosmograph's click/hover index → our node without re-rendering.
  const pointsRef = useRef<CosmoNode[]>(data.nodes)
  pointsRef.current = data.nodes
  const indexById = useMemo(
    () => new Map(data.nodes.map((n) => [n.id, n.index])),
    [data.nodes],
  )

  const cosmoRef = useRef<CosmographRef>(undefined)
  const [hover, setHover] = useState<Hover | null>(null)
  const [edgeLabels, setEdgeLabels] = useState<EdgeLabel[]>([])
  const showNodeLabels = labels.source !== "off"
  const showEdgeLabels = labels.edges
  // Pointing `pointImageUrlBy` at a column of empty strings costs a pass over every point for
  // nothing, so it is only wired up when the slice actually carries pictures.
  const hasImages = useMemo(() => sliceHasImages(slice), [slice])
  const showImages = labels.images && hasImages

  // Read inside Cosmograph's callbacks, which are invoked at simulation-tick rate: reading refs
  // keeps them correct without re-subscribing (and without a stale closure) on every render.
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const pinnedRef = useRef(Boolean(pinned))
  pinnedRef.current = Boolean(pinned)
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

  /** Stop the layout where it stands (one last fit + edge-label pass, then freeze). */
  const freeze = useCallback(() => {
    const g = cosmoRef.current
    if (!g || pausedRef.current || pinnedRef.current) return
    if (autoFitRef.current && selectedRef.current === undefined) g.fitView(400)
    g.pause()
    pausedRef.current = true
    onPausedChange(true)
    rebuildEdgeLabels()
  }, [onPausedChange, rebuildEdgeLabels])

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

  // The shared toolbar drives the viewport through this handle; an explicit fit or zoom is the
  // user taking over the view, so it also disarms auto-fitting.
  useImperativeHandle(
    handleRef,
    () => ({
      fit: () => {
        releaseAutoFit()
        cosmoRef.current?.fitView(400)
      },
      zoomIn: () => {
        releaseAutoFit()
        cosmoRef.current?.setZoomLevel((cosmoRef.current?.getZoomLevel() ?? 1) * 1.4, 300)
      },
      zoomOut: () => {
        releaseAutoFit()
        cosmoRef.current?.setZoomLevel((cosmoRef.current?.getZoomLevel() ?? 1) / 1.4, 300)
      },
    }),
    [releaseAutoFit],
  )

  // Toolbar pause/resume, plus the playback pin: either one held is enough to stop the
  // simulation. `paused` and `pinned` are tracked as separate dependencies (not pre-merged by
  // the caller), so a transition in either always re-fires this regardless of what the other is
  // doing at the time.
  useEffect(() => {
    const g = cosmoRef.current
    if (!g) return
    if (paused || pinned) g.pause()
    else g.start()
  }, [paused, pinned])

  return (
    <div
      className="relative h-full w-full"
      style={{ background: CANVAS_BG }}
      // Any zoom or drag on the canvas hands the view to the user; capture so it registers even
      // though the WebGL canvas handles the event itself.
      onWheelCapture={releaseAutoFit}
      onPointerDownCapture={releaseAutoFit}
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
        pointLabelBy={labels.source === "off" ? LABEL_COLUMN.name : LABEL_COLUMN[labels.source]}
        // Columns Cosmograph does not consume itself are dropped from the point data unless
        // they are declared here — without this, pointing `pointLabelBy` at one of the other
        // caption columns finds nothing and the captions never change.
        pointIncludeColumns={EXTRA_COLUMNS}
        // Avatars: drawn over the point, replacing its dot once the picture has loaded. Nodes
        // whose image cell is empty — or whose URL is cross-origin without CORS, which is what
        // Cosmograph's canvas read needs — simply keep the colored dot.
        pointImageUrlBy={showImages ? IMAGE_COLUMN : undefined}
        pointImageSize={IMAGE_SIZE}
        hidePointShapesForLoadedImages
        // `showLabels` is the master switch for every non-hovered label, custom ones included,
        // so it is on whenever either kind is wanted; the rest scope it to point labels.
        showLabels={showNodeLabels || showEdgeLabels}
        showDynamicLabels={showNodeLabels}
        showTopLabels={showNodeLabels}
        showTopLabelsLimit={labels.limit}
        showDynamicLabelsLimit={labels.limit}
        showHoveredPointLabel={showNodeLabels}
        pointLabelFontSize={12}
        customLabels={showEdgeLabels ? edgeLabels : undefined}
        onMount={(g) => {
          cosmoRef.current = g
        }}
        onGraphRebuilt={() => {
          if (pinnedRef.current) {
            // Playback pins the layout across every step's rebuilt slice. Cosmograph starts a
            // fresh simulation on each rebuild regardless of props, and no prop changes here (
            // `pinned` was already true and stays true), so the pause/resume effect below never
            // re-fires — the re-pause has to be issued imperatively, right here, instead. Also
            // skip the un-pause/fit/armSettle that follows: they belong to the "new slice, let it
            // settle" path, not to a slice that is supposed to hold still.
            cosmoRef.current?.pause()
            return
          }
          // A rebuilt graph starts its own simulation, so clear a freeze left over from the
          // previous slice — otherwise the toolbar says paused and the new layout never fits.
          pausedRef.current = false
          onPausedChange(false)
          cosmoRef.current?.fitView(300)
          armSettle()
        }}
        // Frame the layout as it blooms open (instant fit each tick), then one smooth fit when
        // it settles. Skipped once the user has taken over the view (see `autoFitRef`) or while
        // a node is selected, so neither a manual zoom nor the selection's zoom-to-node is
        // fought. This is also what makes a 5-node slice land centered rather than zoomed into
        // a single point.
        onSimulationTick={() => {
          if (
            autoFitRef.current &&
            selectedRef.current === undefined &&
            !pausedRef.current &&
            !pinnedRef.current
          ) {
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
    </div>
  )
}
