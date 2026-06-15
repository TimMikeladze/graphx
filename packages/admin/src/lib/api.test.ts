import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, api, qs, setToken } from "./api"

describe("qs", () => {
  it("joins defined params and drops undefined/empty", () => {
    expect(qs({ kind: "person", q: "", asOf: 5, cursor: undefined })).toBe("?kind=person&asOf=5")
  })
  it("returns empty string when nothing is set", () => {
    expect(qs({ kind: undefined, q: "" })).toBe("")
  })
})

describe("api transport", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setToken(null)
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response
  }

  it("builds the nodes URL with filters and unwraps the page", async () => {
    fetchMock.mockResolvedValue(ok({ nodes: [], nextCursor: null }))
    await api.listNodes("tA", "pA", { kind: "device", limit: 2 })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("/t/tA/p/pA/nodes?kind=device&limit=2")
  })

  it("attaches a Bearer header when a token is set", async () => {
    setToken("secret")
    fetchMock.mockResolvedValue(ok({ tenants: [] }))
    await api.listTenants()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/admin/tenants")
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer secret")
  })

  it("omits Authorization when no token", async () => {
    fetchMock.mockResolvedValue(ok({ tenants: [] }))
    await api.listTenants()
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Headers).get("Authorization")).toBeNull()
  })

  it("throws ApiError with the response status on non-ok", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "validation" }),
    } as Response)
    await expect(api.createTenant("")).rejects.toMatchObject({ status: 400, message: "validation" })
    await expect(api.createTenant("")).rejects.toBeInstanceOf(ApiError)
  })

  it("sets JSON content-type on bodied requests", async () => {
    fetchMock.mockResolvedValue(ok({ id: "x" }))
    await api.createTenant("Acme")
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ name: "Acme" }))
  })
})
