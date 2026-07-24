import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { ApiError, api, qs, setToken } from "./api"

describe("qs", () => {
  it("joins defined params and drops undefined/empty", () => {
    expect(qs({ type: "person", q: "", asOf: 5, cursor: undefined })).toBe("?type=person&asOf=5")
  })
  it("returns empty string when nothing is set", () => {
    expect(qs({ type: undefined, q: "" })).toBe("")
  })
})

describe("api transport", () => {
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

  function ok(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as Response
  }

  it("builds the nodes URL with filters and unwraps the page", async () => {
    fetchMock.mockResolvedValue(ok({ nodes: [], nextCursor: null }))
    await api.listNodes("tA", "pA", { type: "device", limit: 2 })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("/t/tA/p/pA/nodes?type=device&limit=2")
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

  it("reads a node's content payload from the /content sub-resource", async () => {
    fetchMock.mockResolvedValue(ok({ body: "# hi", uri: null, contentType: null, contentHash: null }))
    const content = await api.getNodeContent("tA", "pA", "n1")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/t/tA/p/pA/nodes/n1/content")
    expect(init?.method).toBeUndefined() // GET
    expect(content.body).toBe("# hi")
  })

  it("PATCHes only the body when saving node content", async () => {
    fetchMock.mockResolvedValue(ok({ id: "n1", type: "person", data: {} }))
    await api.updateNodeBody("tA", "pA", "n1", "# new")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/t/tA/p/pA/nodes/n1")
    expect(init.method).toBe("PATCH")
    expect(init.body).toBe(JSON.stringify({ body: "# new" }))
  })

  it("sets JSON content-type on bodied requests", async () => {
    fetchMock.mockResolvedValue(ok({ id: "x" }))
    await api.createTenant("Acme")
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json")
    expect(init.body).toBe(JSON.stringify({ name: "Acme" }))
  })
})
