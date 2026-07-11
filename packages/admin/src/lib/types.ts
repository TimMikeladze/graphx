/**
 * Wire DTOs for the graphx HTTP API — local mirrors of the shapes returned by
 * `packages/core` (`serve.ts` + `admin.ts`). Defined here rather than imported from `core`
 * because `core` ships no `dist/` build for the Vite app to resolve types against (see Plan 2,
 * deviation D-UI-4). Keep these in sync with the server's response shapes.
 */

/** A tenant membership role (control plane). */
export type Role = "owner" | "editor" | "viewer"

/** Control-plane tenant. */
export interface Tenant {
  id: string
  name: string
}

/** Control-plane project (one libSQL namespace per project). */
export interface Project {
  id: string
  name: string
  dbNamespace: string
}

/** Control-plane user. */
export interface User {
  id: string
  email: string
}

/** A live node as returned by `getNode`/`listNodes` ({ id, type, parsed data }). */
export interface GraphNode {
  id: string
  type: string
  data: Record<string, unknown>
}

/** One keyset page of `GET /nodes`. */
export interface NodeListPage {
  nodes: GraphNode[]
  nextCursor: string | null
}

/** A canvas node in a graph slice. */
export interface GraphSliceNode {
  id: string
  type: string
}

/** A canvas link in a graph slice (Cosmograph `source`/`target` naming). */
export interface GraphSliceLink {
  id: string
  source: string
  target: string
  rel: string
  weight: number
}

/** `GET /graph` — the filtered node set + edges among them. */
export interface GraphSlice {
  nodes: GraphSliceNode[]
  links: GraphSliceLink[]
  /** True when the node set hit the server row cap. */
  truncated: boolean
}

/** One row of `GET /nodes/:id/history` (raw stored version; `data` is JSON text). */
export interface NodeVersion {
  ver: number
  id: string
  type: string
  body: string | null
  uri: string | null
  content_hash: string | null
  content_type: string | null
  data: string
  valid_from: number
  valid_to: number
}

/** Filters that scope the explorer (also the URL search params). */
export interface ExplorerFilters {
  type?: string
  q?: string
  /** As-of epoch ms; absent ⇒ current (live). */
  asOf?: number
}
