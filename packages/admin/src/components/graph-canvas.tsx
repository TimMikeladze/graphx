import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { Cosmograph, type CosmographRef } from "@cosmograph/react"
import {
  type CosmoData,
  type CosmoNode,
  dataHasImages,
  IMAGE_COLUMN,
  LABEL_COLUMN,
  sameGraph,
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
 * How long a slice may sit un-absorbed before the handover gate is forced open.
 *
 * Cosmograph reports a finished slice through `onGraphRebuilt`, but it raises that callback at the
 * end of a `try` — a rebuild that throws never reports at all. Without this the gate below would
 * latch shut and the canvas would stop following the graph for the rest of the session. It is a
 * wedge-breaker, not a pacing device: it is set far above any real ingest (a 10k-point slice takes
 * seconds, not half a minute) so that it never fires while Cosmograph is merely slow.
 */
const ABSORB_TIMEOUT_MS = 30_000

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

/**
 * Values passed straight through to `<Cosmograph>`, hoisted so their identity never changes.
 *
 * `Cosmograph` is `React.memo`-wrapped and its update effect is keyed on the props object, so a
 * single inline literal or arrow defeats the memo and fires another `setConfig` on *every* render
 * of this component. Those runs are not free and they are not serialized: the library keeps one
 * in-flight update promise and overwrites it, so one landing during an ingest is exactly the
 * re-entrancy that corrupts its DuckDB catalog. Everything below therefore has a stable identity.
 */
const POINT_SIZE_RANGE: [number, number] = [11, 34]
const LINK_WIDTH_RANGE: [number, number] = [1, 3]
const CANVAS_STYLE = { width: "100%", height: "100%" } as const
/** Cosmograph reads a string color column as a categorical scale unless it is told otherwise. */
const directColor = (value: unknown) => String(value)

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
  onBusyChange,
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
  /**
   * Reports whether Cosmograph is still ingesting a slice. Callers that drive `slice` on a clock
   * — playback — use it as back-pressure so they advance in step with what is actually on screen
   * rather than queueing frames the canvas will only skip.
   */
  onBusyChange?: (busy: boolean) => void
  handleRef: React.RefObject<RendererHandle | null>
}) {
  // Selection is applied imperatively (selectPoint below), so it must NOT change the points
  // identity — otherwise every click rebuilds the graph and re-fits, fighting the zoom-to-node.
  const data = useMemo(() => toCosmograph(slice), [slice])

  /**
   * The slice Cosmograph is actually holding. It deliberately lags `data`.
   *
   * `@cosmograph/cosmograph@2.3.2` cannot take a second slice while it is still ingesting the
   * first: `ConfigManager.setConfig` overwrites its single in-flight `_configUpdatePromise`
   * instead of queueing behind it, so two runs interleave over one DuckDB catalog — one swaps the
   * points table out from under the other's read and the graph dies with
   * `Catalog Error: Table with name cosmograph_points does not exist!` (or, on a small slice,
   * `updatePointProperties failed`). The library exposes no way to await or cancel a run, so the
   * only fix available from outside is to hand it one slice at a time.
   *
   * Slices that arrive mid-ingest are coalesced rather than queued: only the newest is worth
   * drawing, and the ones it skipped were never on screen.
   */
  const [shown, setShown] = useState(data)
  // `absorbed` runs from a Cosmograph callback and must keep a stable identity, so it reads the
  // drawn slice through a ref rather than closing over it.
  const shownRef = useRef(shown)
  shownRef.current = shown
  const pendingRef = useRef<CosmoData | undefined>(undefined)
  // Starts busy: Cosmograph is constructed with the first slice and is ingesting it immediately.
  const busyRef = useRef(true)
  const onBusyRef = useRef(onBusyChange)
  onBusyRef.current = onBusyChange
  const absorbTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const setBusy = useCallback((busy: boolean) => {
    if (busyRef.current === busy) return
    busyRef.current = busy
    onBusyRef.current?.(busy)
  }, [])

  // Announce the first build, and never leave a caller stuck waiting on a canvas that has gone.
  useEffect(() => {
    onBusyRef.current?.(true)
    return () => {
      clearTimeout(absorbTimer.current)
      onBusyRef.current?.(false)
    }
  }, [])

  /** Cosmograph is done with what it was given: hand over whatever arrived in the meantime. */
  const absorbed = useCallback(() => {
    clearTimeout(absorbTimer.current)
    const next = pendingRef.current
    pendingRef.current = undefined
    // A slice that draws the same graph is dropped rather than handed over — see the effect
    // below for why waiting on one would hang.
    if (next !== undefined && !sameGraph(next, shownRef.current)) setShown(next)
    // Staying busy across a back-to-back handover is deliberate — the next ingest starts there.
    else setBusy(false)
  }, [setBusy])

  useEffect(() => {
    // A fresh array whose contents match what is already drawn must NOT be handed over.
    // Cosmograph deep-compares `points`/`links` and skips the whole ingest when they are equal,
    // which means it never raises `onGraphRebuilt` — and this canvas waits on that callback, so
    // handing one over would hold the gate shut until the wedge-breaker fires. Query results are
    // re-fetched per as-of key and arrive with a new identity even when nothing about the graph
    // changed, so this is the common case, not the exotic one.
    //
    // Anything queued is superseded either way: leaving an older slice there would draw a graph
    // the user has already scrubbed past, one ingest after the fact.
    if (data === shown || sameGraph(data, shown)) {
      pendingRef.current = undefined
      return
    }
    if (busyRef.current) {
      pendingRef.current = data
      return
    }
    pendingRef.current = undefined
    setBusy(true)
    setShown(data)
  }, [data, shown, setBusy])

  // Arm the wedge-breaker for whichever slice is currently in flight.
  useEffect(() => {
    clearTimeout(absorbTimer.current)
    absorbTimer.current = setTimeout(absorbed, ABSORB_TIMEOUT_MS)
  }, [shown, absorbed])

  // Resolve Cosmograph's click/hover index → our node without re-rendering. Keyed to the slice on
  // screen, not the one waiting: a click must resolve against the points the user actually hit.
  const pointsRef = useRef<CosmoNode[]>(shown.nodes)
  pointsRef.current = shown.nodes
  const indexById = useMemo(
    () => new Map(shown.nodes.map((n) => [n.id, n.index])),
    [shown.nodes],
  )

  const cosmoRef = useRef<CosmographRef>(undefined)
  const [hover, setHover] = useState<Hover | null>(null)
  const [edgeLabels, setEdgeLabels] = useState<EdgeLabel[]>([])
  const showNodeLabels = labels.source !== "off"
  const showEdgeLabels = labels.edges
  // Pointing `pointImageUrlBy` at a column of empty strings costs a pass over every point for
  // nothing, so it is only wired up when the slice actually carries pictures.
  // Derived from the slice on screen, not the incoming one. Every value fed to `<Cosmograph>`
  // must come from `shown`: mixing the two emits a config carrying the new slice's image column
  // against the old slice's points, and Cosmograph's image pass then sizes its buffers to a point
  // count that is about to be replaced.
  const hasImages = useMemo(() => dataHasImages(shown), [shown])
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
  }, [shown])
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
    // Not while a slice is in flight. `customLabels` is one of Cosmograph's label keys, so a new
    // array here is a config update that takes its label-only branch — `labels.update()`, which
    // runs `SELECT … FROM cosmograph_points`. Issued mid-ingest that reads the points table while
    // the upload is dropping and recreating it, which is the catalog error this canvas is built
    // to avoid. `handleGraphRebuilt` refreshes the captions once the slice has landed.
    if (busyRef.current) return

    const focus = selectedRef.current ?? hoverIdRef.current
    const links = shown.links
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
  }, [shown.links, showEdgeLabels])

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
    if (paused || pinned) {
      g.pause()
      return
    }
    g.start()
    // The run that follows an unpin needs its own settle backstop: the rebuilds during playback
    // took the pin branch, which deliberately skips `armSettle`, so nothing else has armed one.
    // Without it a slice large enough never to emit `onSimulationEnd` — exactly what SETTLE_MS
    // exists for — would jitter on until the user reached for Pause.
    armSettle()
  }, [paused, pinned, armSettle])

  // Every callback handed to `<Cosmograph>` below is memoized for the same reason the literals at
  // the top of this file are hoisted: an unstable identity defeats the library's `React.memo` and
  // fires a fresh `setConfig` on each render of this component. They all read mutable state
  // through refs, so a stable identity costs nothing in correctness.
  const handleMount = useCallback((g: CosmographRef) => {
    cosmoRef.current = g
  }, [])

  const handleGraphRebuilt = useCallback(() => {
    // The slice is in and drawn — release the handover gate first, so a slice that arrived while
    // this one was ingesting starts straight away, including on the pinned path below.
    absorbed()
    // Captions were held back for the duration of the ingest; catch them up now. If `absorbed`
    // started another handover this is a no-op and the next rebuild will do it.
    rebuildEdgeLabels()
    if (pinnedRef.current) {
      // Playback pins the layout across every step's rebuilt slice. Cosmograph starts a fresh
      // simulation on each rebuild regardless of props, and no prop changes here (`pinned` was
      // already true and stays true), so the pause/resume effect above never re-fires — the
      // re-pause has to be issued imperatively, right here, instead. Also skip the
      // un-pause/fit/armSettle that follows: they belong to the "new slice, let it settle" path,
      // not to a slice that is supposed to hold still.
      cosmoRef.current?.pause()
      return
    }
    // A rebuilt graph starts its own simulation, so clear a freeze left over from the previous
    // slice — otherwise the toolbar says paused and the new layout never fits.
    pausedRef.current = false
    onPausedChange(false)
    cosmoRef.current?.fitView(300)
    armSettle()
  }, [absorbed, armSettle, onPausedChange, rebuildEdgeLabels])

  const handleSimulationTick = useCallback(() => {
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
  }, [showEdgeLabels, rebuildEdgeLabels])

  // `onSelect` is an inline arrow at the call site and changes identity on every render of the
  // page, so it is read through a ref like the rest of the mutable state here. Depending on it
  // directly would hand `<Cosmograph>` a new callback each render, defeating its `memo` and
  // firing a `setConfig` mid-ingest — the very re-entrancy the handover gate exists to prevent.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const handleClick = useCallback(
    (index?: number) =>
      onSelectRef.current(index === undefined ? undefined : pointsRef.current[index]?.id),
    [],
  )

  const handlePointMouseOver = useCallback((index: number, pointPosition?: [number, number]) => {
    const n = pointsRef.current[index]
    if (n && pointPosition)
      setHover({ id: n.id, type: n.type, x: pointPosition[0], y: pointPosition[1] })
  }, [])

  const handlePointMouseOut = useCallback(() => setHover(null), [])

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
        points={shown.nodes}
        pointIdBy="id"
        pointIndexBy="index"
        pointColorBy="color"
        pointColorByFn={directColor}
        pointSizeStrategy="degree"
        pointSizeRange={POINT_SIZE_RANGE}
        pointDefaultSize={13}
        simulationGravity={0.4}
        simulationCenter={0.5}
        // Cool down fast and damp hard (defaults: 5000 decay, 0.85 friction). A slice this size
        // is readable long before a leisurely simulation would settle, and the slow default
        // reads as nodes jittering in place.
        simulationDecay={1000}
        simulationFriction={0.72}
        links={shown.links}
        linkWidthBy="weight"
        linkWidthRange={LINK_WIDTH_RANGE}
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
        onMount={handleMount}
        onGraphRebuilt={handleGraphRebuilt}
        // Frame the layout as it blooms open (instant fit each tick), then one smooth fit when
        // it settles. Skipped once the user has taken over the view (see `autoFitRef`) or while
        // a node is selected, so neither a manual zoom nor the selection's zoom-to-node is
        // fought. This is also what makes a 5-node slice land centered rather than zoomed into
        // a single point.
        onSimulationTick={handleSimulationTick}
        // Cosmograph reached its own end before the budget did — freeze there instead.
        onSimulationEnd={freeze}
        onClick={handleClick}
        onPointMouseOver={handlePointMouseOver}
        onPointMouseOut={handlePointMouseOut}
        style={CANVAS_STYLE}
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
