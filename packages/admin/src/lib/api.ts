import type {
  ExplorerFilters,
  GraphNode,
  GraphSlice,
  NodeContent,
  NodeListPage,
  NodeVersion,
  Project,
  RetrievedNode,
  Role,
  Tenant,
  User,
} from "./types"

/**
 * Thin typed transport over the graphx Hono API. Two realms: `/admin/*` (operator registry CRUD)
 * and `/t/:tenant/p/:project/*` (tenant-scoped graph reads). Paths are relative — the Vite dev
 * server proxies them to the Hono process (no CORS). The operator token rides as a Bearer header;
 * a `401` invokes the registered handler (the UI opens the token dialog) before throwing.
 */

const TOKEN_KEY = "graphx.adminToken"

let memToken: string | null = null
let onUnauthorized: (() => void) | undefined

/** Read the operator token (in-memory first, then `localStorage` when usable). */
export function getToken(): string | null {
  if (memToken !== null) return memToken
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null
  } catch {
    return null // localStorage present but non-functional (some non-browser runtimes)
  }
}

/** Set (or clear with `null`) the operator token; persists to `localStorage` when usable. */
export function setToken(token: string | null): void {
  memToken = token
  try {
    if (typeof localStorage === "undefined") return
    if (token === null) localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // localStorage unavailable (test/SSR runtime) — in-memory token is the source of truth.
  }
}

/** Register the 401 handler (the UI's token dialog opener). */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

/** Programmatically open the token prompt (same path as a 401) — e.g. a "Set token" button. */
export function requestToken(): void {
  onUnauthorized?.()
}

/** An HTTP error carrying the response status (mapped from the server's error envelopes). */
export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** Build a query string from defined, non-empty params (drops `undefined`/`""`). */
export function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.set(k, String(v))
  }
  const s = u.toString()
  return s ? `?${s}` : ""
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const token = getToken()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  if (init?.body) headers.set("Content-Type", "application/json")

  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    onUnauthorized?.()
    throw new ApiError(401, "unauthenticated")
  }
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { error?: string }) => b?.error)
      .catch(() => undefined)
    throw new ApiError(res.status, detail ?? `request failed (${res.status})`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Filters + keyset pagination for `GET /nodes`. */
export interface ListNodesOpts extends ExplorerFilters {
  limit?: number
  cursor?: string
}

/** Arguments shared by `GET /retrieve` and `POST /hybrid`. */
export interface RetrieveOpts {
  query: string
  /** Number of seeds fed into the walk. */
  k?: number
  /** Hops expanded from each seed. `0` ⇒ seeds only (a pure ranked list). */
  maxDepth?: number
  asOf?: number
}

const tp = (tenant: string, project: string) => `/t/${tenant}/p/${project}`

export const api = {
  // --- admin realm (operator) ---
  listTenants: () => request<{ tenants: Tenant[] }>("/admin/tenants").then((r) => r.tenants),
  createTenant: (name: string) =>
    request<{ id: string }>("/admin/tenants", { method: "POST", body: JSON.stringify({ name }) }),
  listProjects: (tenantId: string) =>
    request<{ projects: Project[] }>(`/admin/tenants/${tenantId}/projects`).then((r) => r.projects),
  createProject: (tenantId: string, body: { name: string; dbNamespace: string }) =>
    request<{ id: string }>(`/admin/tenants/${tenantId}/projects`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listUsers: () => request<{ users: User[] }>("/admin/users").then((r) => r.users),
  createUser: (email: string) =>
    request<{ id: string }>("/admin/users", { method: "POST", body: JSON.stringify({ email }) }),
  addMembership: (body: { userId: string; tenantId: string; role: Role }) =>
    request<void>("/admin/memberships", { method: "POST", body: JSON.stringify(body) }),
  createApiKey: (body: { tenantId: string; scopes: string[] }) =>
    request<{ key: string }>("/admin/api-keys", { method: "POST", body: JSON.stringify(body) }),

  // --- tenant realm (graph reads) ---
  listNodes: (tenant: string, project: string, opts: ListNodesOpts = {}) =>
    request<NodeListPage>(
      `${tp(tenant, project)}/nodes${qs({
        type: opts.type,
        q: opts.q,
        asOf: opts.asOf,
        limit: opts.limit,
        cursor: opts.cursor,
      })}`,
    ),
  graphSlice: (tenant: string, project: string, filters: ExplorerFilters = {}) =>
    request<GraphSlice>(
      `${tp(tenant, project)}/graph${qs({ type: filters.type, q: filters.q, asOf: filters.asOf })}`,
    ),
  getNode: (tenant: string, project: string, id: string) =>
    request<GraphNode>(`${tp(tenant, project)}/nodes/${id}`),
  getNodeContent: (tenant: string, project: string, id: string) =>
    request<NodeContent>(`${tp(tenant, project)}/nodes/${id}/content`),
  /** Replace a node's markdown body. Bitemporal — the server opens a successor version. */
  updateNodeBody: (tenant: string, project: string, id: string, body: string) =>
    request<GraphNode>(`${tp(tenant, project)}/nodes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),
  neighbors: (tenant: string, project: string, id: string) =>
    request<GraphNode[]>(`${tp(tenant, project)}/nodes/${id}/neighbors`),
  history: (tenant: string, project: string, id: string) =>
    request<{ versions: NodeVersion[] }>(`${tp(tenant, project)}/nodes/${id}/history`).then(
      (r) => r.versions,
    ),

  // --- retrieval (needs a server-side embedder; both 501 without one) ---
  retrieve: (tenant: string, project: string, opts: RetrieveOpts) =>
    request<RetrievedNode[]>(
      `${tp(tenant, project)}/retrieve${qs({
        query: opts.query,
        k: opts.k,
        maxDepth: opts.maxDepth,
        asOf: opts.asOf,
      })}`,
    ),
  hybrid: (tenant: string, project: string, opts: RetrieveOpts) =>
    request<RetrievedNode[]>(`${tp(tenant, project)}/hybrid`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),
}
