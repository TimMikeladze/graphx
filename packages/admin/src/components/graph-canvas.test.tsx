import "@/hooks/dom-setup.ts"
import { afterEach, describe, expect, it, mock } from "bun:test"
import { act, cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import type { GraphSlice } from "@/lib/types"

/**
 * Records every `points` array handed to Cosmograph, and hands the test the callbacks Cosmograph
 * would normally invoke itself.
 *
 * `@cosmograph/react` is mocked rather than driven for real because the defect under test is
 * about *when* a slice is handed over, not about what Cosmograph draws: the library's
 * `ConfigManager.setConfig` overwrites its single in-flight update promise instead of queueing,
 * so a slice arriving mid-ingest interleaves its DuckDB table swap with the previous run's reads
 * and the graph dies with `Catalog Error: Table with name cosmograph_points does not exist!`.
 * What this file pins is that we never issue that second handover while the first is in flight.
 */
const handovers: string[][] = []
/**
 * Signature of the data Cosmograph last actually ingested. The real library deep-compares the
 * `points`/`links` it is handed against its current config and skips the entire ingest when they
 * match — no upload, no rebuild, and no `onGraphRebuilt`. `rebuild()` below reproduces that, so a
 * canvas that waits on the callback for a no-op handover fails here rather than in the browser.
 */
let ingested: string | undefined
let mounted = false
let currentProps: { points: { id: string }[]; onGraphRebuilt?: () => void } | undefined

/** Drive the callback the way the library would: only when the data really changed. */
function rebuild() {
  if (!currentProps) return
  const signature = JSON.stringify(currentProps.points.map((p) => p.id))
  if (signature === ingested) return
  ingested = signature
  currentProps.onGraphRebuilt?.()
}

mock.module("@cosmograph/react", () => ({
  Cosmograph: (props: {
    points: { id: string }[]
    onGraphRebuilt?: () => void
    onMount?: (ref: unknown) => void
  }) => {
    handovers.push(props.points.map((p) => p.id))
    currentProps = props
    // The real wrapper constructs the graph once and hands the instance back on first mount only.
    if (!mounted) {
      mounted = true
      props.onMount?.({
        pause: () => {},
        start: () => {},
        fitView: () => {},
        selectPoint: () => {},
        selectPoints: () => {},
        zoomToPoint: () => {},
      })
    }
    return createElement("div", { "data-testid": "cosmograph" })
  },
}))

const { GraphCanvas } = await import("./graph-canvas")

function slice(...ids: string[]): GraphSlice {
  return {
    nodes: ids.map((id) => ({ id, type: "person", data: {} })),
    links: [],
    truncated: false,
  } as unknown as GraphSlice
}

function renderCanvas(s: GraphSlice, onBusyChange?: (busy: boolean) => void) {
  return render(
    createElement(GraphCanvas, {
      slice: s,
      onSelect: () => {},
      labels: { source: "off", edges: false, images: false, limit: 20 },
      paused: false,
      onPausedChange: () => {},
      onBusyChange,
      handleRef: { current: null },
    } as never),
  )
}

afterEach(() => {
  cleanup()
  handovers.length = 0
  ingested = undefined
  mounted = false
  currentProps = undefined
})

describe("GraphCanvas slice handover", () => {
  it("holds a new slice back until Cosmograph reports the previous one absorbed", () => {
    const { rerender } = renderCanvas(slice("a"))
    expect(handovers.at(-1)).toEqual(["a"])

    // A second slice arrives while the first is still being ingested. Handing it over here is
    // exactly what corrupts Cosmograph's DuckDB catalog, so it must be withheld.
    act(() => {
      rerender(
        createElement(GraphCanvas, {
          slice: slice("b"),
          onSelect: () => {},
          labels: { source: "off", edges: false, images: false, limit: 20 },
          paused: false,
          onPausedChange: () => {},
          handleRef: { current: null },
        } as never),
      )
    })
    expect(handovers.at(-1)).toEqual(["a"])

    act(() => rebuild())
    expect(handovers.at(-1)).toEqual(["b"])
  })

  it("drops superseded slices — the newest pending one wins", () => {
    const props = (s: GraphSlice) =>
      createElement(GraphCanvas, {
        slice: s,
        onSelect: () => {},
        labels: { source: "off", edges: false, images: false, limit: 20 },
        paused: false,
        onPausedChange: () => {},
        handleRef: { current: null },
      } as never)

    const { rerender } = renderCanvas(slice("a"))
    act(() => rerender(props(slice("b"))))
    act(() => rerender(props(slice("c"))))
    act(() => rerender(props(slice("d"))))
    expect(handovers.at(-1)).toEqual(["a"])

    // Only the last slice is worth drawing; b and c were never on screen and are skipped.
    act(() => rebuild())
    expect(handovers.at(-1)).toEqual(["d"])
    expect(handovers.map((h) => h.join())).not.toContain("b")
    expect(handovers.map((h) => h.join())).not.toContain("c")
  })

  it("reports busy while a slice is in flight and idle once it lands", () => {
    const seen: boolean[] = []
    const { rerender } = renderCanvas(slice("a"), (b) => seen.push(b))
    act(() => rebuild())
    expect(seen.at(-1)).toBe(false)

    act(() =>
      rerender(
        createElement(GraphCanvas, {
          slice: slice("b"),
          onSelect: () => {},
          labels: { source: "off", edges: false, images: false, limit: 20 },
          paused: false,
          onPausedChange: () => {},
          onBusyChange: (b: boolean) => seen.push(b),
          handleRef: { current: null },
        } as never),
      ),
    )
    expect(seen.at(-1)).toBe(true)

    act(() => rebuild())
    expect(seen.at(-1)).toBe(false)
  })

  /**
   * Every as-of step re-fetches under a new query key, so an unchanged graph still arrives as a
   * fresh array. Cosmograph deep-compares and skips such an update entirely — it never reports a
   * rebuild — so a canvas that armed its gate on one would wait for a callback that never comes,
   * and the next real slice would sit undrawn behind it.
   */
  it("does not wait on a slice that draws the same graph", () => {
    const seen: boolean[] = []
    const props = (s: GraphSlice) =>
      createElement(GraphCanvas, {
        slice: s,
        onSelect: () => {},
        labels: { source: "off", edges: false, images: false, limit: 20 },
        paused: false,
        onPausedChange: () => {},
        onBusyChange: (b: boolean) => seen.push(b),
        handleRef: { current: null },
      } as never)

    const { rerender } = renderCanvas(slice("a", "b"), (b) => seen.push(b))
    act(() => rebuild())
    expect(seen.at(-1)).toBe(false)

    // Same graph, new arrays. Nothing to draw and nothing to wait for.
    act(() => rerender(props(slice("a", "b"))))
    expect(seen.at(-1)).toBe(false)

    // The gate is still open, so a genuinely different slice goes over at once.
    act(() => rerender(props(slice("a", "b", "c"))))
    expect(handovers.at(-1)).toEqual(["a", "b", "c"])
    expect(seen.at(-1)).toBe(true)
  })
})
