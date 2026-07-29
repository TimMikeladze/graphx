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
let fireGraphRebuilt: (() => void) | undefined

mock.module("@cosmograph/react", () => ({
  Cosmograph: (props: { points: { id: string }[]; onGraphRebuilt?: () => void }) => {
    handovers.push(props.points.map((p) => p.id))
    fireGraphRebuilt = props.onGraphRebuilt
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
  fireGraphRebuilt = undefined
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

    act(() => fireGraphRebuilt?.())
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
    act(() => fireGraphRebuilt?.())
    expect(handovers.at(-1)).toEqual(["d"])
    expect(handovers.map((h) => h.join())).not.toContain("b")
    expect(handovers.map((h) => h.join())).not.toContain("c")
  })

  it("reports busy while a slice is in flight and idle once it lands", () => {
    const seen: boolean[] = []
    const { rerender } = renderCanvas(slice("a"), (b) => seen.push(b))
    act(() => fireGraphRebuilt?.())
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

    act(() => fireGraphRebuilt?.())
    expect(seen.at(-1)).toBe(false)
  })
})
