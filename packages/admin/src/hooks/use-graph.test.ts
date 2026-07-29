import "./dom-setup.ts"
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { act, cleanup, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import { setToken } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { useCreateEdge, useDeleteEdge, useUpdateNode, useUpdateNodeBody } from "./use-graph"

afterEach(cleanup)

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children)
  }
}

/**
 * The four write mutations must invalidate the as-of-agnostic `all*` prefix, not a live-only leaf
 * key — a leaf-key invalidation evicts only the live cache entry and leaves every as-of entry
 * stale (the bug this whole plan exists to fix; see `qk.allNode`/`allNodeContent`/`allNeighbors`
 * in query-keys.ts). Each case here seeds both a live and an as-of cache entry, fires the mutation
 * against a stubbed transport (no server involved — only which keys get invalidated is under
 * test), and asserts BOTH entries were marked invalidated.
 */
describe("mutation invalidation reaches every asOf cache entry", () => {
  let fetchMock: ReturnType<typeof mock>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    setToken(null)
    fetchMock = mock()
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("useUpdateNodeBody invalidates the live and asOf content cache", async () => {
    fetchMock.mockResolvedValue(ok({ id: "n1", type: "device", data: {} }))
    const qc = freshClient()
    qc.setQueryData(qk.nodeContent("t", "p", "n1"), { body: "old" })
    qc.setQueryData(qk.nodeContent("t", "p", "n1", 5), { body: "old-asof" })

    const { result } = renderHook(() => useUpdateNodeBody("t", "p", "n1"), {
      wrapper: wrapperFor(qc),
    })
    await act(async () => {
      await result.current.mutateAsync("new body")
    })

    expect(qc.getQueryState(qk.nodeContent("t", "p", "n1"))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(qk.nodeContent("t", "p", "n1", 5))?.isInvalidated).toBe(true)
  })

  it("useUpdateNode invalidates the live and asOf node + content cache", async () => {
    fetchMock.mockResolvedValue(ok({ id: "n1", type: "device", data: { crit: 9 } }))
    const qc = freshClient()
    qc.setQueryData(qk.node("t", "p", "n1"), { id: "n1", type: "device", data: {} })
    qc.setQueryData(qk.node("t", "p", "n1", 5), { id: "n1", type: "device", data: {} })
    qc.setQueryData(qk.nodeContent("t", "p", "n1"), { body: "old" })
    qc.setQueryData(qk.nodeContent("t", "p", "n1", 5), { body: "old-asof" })

    const { result } = renderHook(() => useUpdateNode("t", "p", "n1"), { wrapper: wrapperFor(qc) })
    await act(async () => {
      await result.current.mutateAsync({ data: { crit: 9 } })
    })

    expect(qc.getQueryState(qk.node("t", "p", "n1"))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(qk.node("t", "p", "n1", 5))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(qk.nodeContent("t", "p", "n1"))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(qk.nodeContent("t", "p", "n1", 5))?.isInvalidated).toBe(true)
  })

  it("useCreateEdge invalidates the live and asOf neighbors cache for both endpoints", async () => {
    fetchMock.mockResolvedValue(ok({ id: "e1" }))
    const qc = freshClient()
    for (const id of ["src1", "dst1"]) {
      qc.setQueryData(qk.neighbors("t", "p", id), [])
      qc.setQueryData(qk.neighbors("t", "p", id, 5), [])
    }

    const { result } = renderHook(() => useCreateEdge("t", "p"), { wrapper: wrapperFor(qc) })
    await act(async () => {
      await result.current.mutateAsync({ rel: "knows", src: "src1", dst: "dst1" })
    })

    for (const id of ["src1", "dst1"]) {
      expect(qc.getQueryState(qk.neighbors("t", "p", id))?.isInvalidated).toBe(true)
      expect(qc.getQueryState(qk.neighbors("t", "p", id, 5))?.isInvalidated).toBe(true)
    }
  })

  it("useDeleteEdge invalidates the live and asOf neighbors cache for both endpoints", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as Response)
    const qc = freshClient()
    for (const id of ["src1", "dst1"]) {
      qc.setQueryData(qk.neighbors("t", "p", id), [])
      qc.setQueryData(qk.neighbors("t", "p", id, 5), [])
    }

    const { result } = renderHook(() => useDeleteEdge("t", "p"), { wrapper: wrapperFor(qc) })
    await act(async () => {
      await result.current.mutateAsync({ id: "e1", source: "src1", target: "dst1" })
    })

    for (const id of ["src1", "dst1"]) {
      expect(qc.getQueryState(qk.neighbors("t", "p", id))?.isInvalidated).toBe(true)
      expect(qc.getQueryState(qk.neighbors("t", "p", id, 5))?.isInvalidated).toBe(true)
    }
  })
})
