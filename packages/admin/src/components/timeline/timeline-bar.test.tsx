import "@/hooks/dom-setup.ts"
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode, useState } from "react"
import { setToken } from "@/lib/api"
import { TimelineBar } from "./timeline-bar"

afterEach(cleanup)

/** Three change points, so playback has somewhere to go. */
const TICKS = [1000, 2000, 3000]

const TIMELINE = {
  min: 1000,
  max: 3000,
  from: 1000,
  to: 3000,
  ticks: TICKS,
  buckets: [1, 1, 1],
  bucketMs: 1000,
  total: 3,
  ticksTruncated: false,
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client: qc }, children)
}

beforeEach(() => {
  setToken("t")
  globalThis.fetch = mock(
    async () => ({ ok: true, status: 200, json: async () => TIMELINE }) as Response,
  ) as unknown as typeof fetch
})

/**
 * Playback used to advance on a bare 700ms interval. That is faster than Cosmograph can ingest a
 * slice, and feeding it one mid-ingest corrupts its DuckDB catalog
 * (`Catalog Error: Table with name cosmograph_points does not exist!`). The interval is now a
 * *minimum* dwell: a step is skipped while the renderer says it is still busy.
 */
describe("TimelineBar playback back-pressure", () => {
  it("holds the step while the renderer is busy, and advances once it is idle", async () => {
    const seen: (number | undefined)[] = []
    const props = (rendererBusy: boolean) => ({
      tenant: "t",
      project: "p",
      asOf: 1000,
      onChange: (v: number | undefined) => seen.push(v),
      rendererBusy,
    })

    const { rerender } = render(createElement(TimelineBar, props(true)), { wrapper })
    // Wait for the timeline query so `ticks` is populated before playback starts.
    await waitFor(() => expect(document.querySelector('[role="slider"]')).toBeTruthy())

    const play = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Play through changes"]',
    )
    expect(play).toBeTruthy()
    act(() => play?.click())

    // Two full intervals pass while the canvas is still ingesting: nothing may be emitted.
    await new Promise((r) => setTimeout(r, 1600))
    expect(seen).toEqual([])

    act(() => rerender(createElement(TimelineBar, props(false))))
    await waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2000 })
    expect(seen[0]).toBe(2000)
  })

  it("stops at the end of the timeline even while the renderer is busy", async () => {
    // The bar reads `asOf` from its parent, so the end of the run is only reachable through a
    // parent that actually follows `onChange` — a fixed `asOf` prop never moves off its tick and
    // leaves the play button disabled, which tests nothing.
    let setBusyOutside: ((busy: boolean) => void) | undefined
    function Harness() {
      const [asOf, setAsOf] = useState<number | undefined>(2000)
      const [busy, setBusy] = useState(false)
      setBusyOutside = setBusy
      return createElement(TimelineBar, {
        tenant: "t",
        project: "p",
        asOf,
        onChange: setAsOf,
        rendererBusy: busy,
      })
    }

    render(createElement(Harness), { wrapper })
    await waitFor(() => expect(document.querySelector('[role="slider"]')).toBeTruthy())

    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Play through changes"]')
        ?.click(),
    )
    // Runs to the last tick, where there is nowhere left to advance to…
    await waitFor(
      () => expect(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("3000"),
      { timeout: 2000 },
    )
    expect(document.querySelector('button[aria-label="Pause playback"]')).toBeTruthy()

    // …and a renderer that is still busy must not keep that finished run showing Pause forever.
    act(() => setBusyOutside?.(true))
    await waitFor(
      () => expect(document.querySelector('button[aria-label="Pause playback"]')).toBeNull(),
      { timeout: 2000 },
    )
  })

  it("advances without a renderer that reports business at all", async () => {
    const seen: (number | undefined)[] = []
    render(
      createElement(TimelineBar, {
        tenant: "t",
        project: "p",
        asOf: 1000,
        onChange: (v: number | undefined) => seen.push(v),
      }),
      { wrapper },
    )
    await waitFor(() => expect(document.querySelector('[role="slider"]')).toBeTruthy())

    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Play through changes"]')
        ?.click(),
    )
    // The flow renderer never reports busy; playback must not depend on the signal existing.
    await waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 2000 })
    expect(seen[0]).toBe(2000)
  })
})
