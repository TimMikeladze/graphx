import type { ExplorerFilters } from "./types"

/** Query-key factories — one stable shape per server resource (TanStack Query cache + invalidation). */
export const qk = {
  tenants: () => ["tenants"] as const,
  projects: (tenantId: string) => ["projects", tenantId] as const,
  users: () => ["users"] as const,
  nodes: (tenant: string, project: string, filters: ExplorerFilters) =>
    ["nodes", tenant, project, filters] as const,
  graph: (tenant: string, project: string, filters: ExplorerFilters) =>
    ["graph", tenant, project, filters] as const,
  /** Filter-agnostic prefixes — what a write invalidates, since it can affect any filtered view. */
  allNodes: (tenant: string, project: string) => ["nodes", tenant, project] as const,
  allGraph: (tenant: string, project: string) => ["graph", tenant, project] as const,
  schema: (tenant: string, project: string) => ["schema", tenant, project] as const,
  node: (tenant: string, project: string, id: string) => ["node", tenant, project, id] as const,
  nodeContent: (tenant: string, project: string, id: string) =>
    ["node-content", tenant, project, id] as const,
  neighbors: (tenant: string, project: string, id: string) =>
    ["neighbors", tenant, project, id] as const,
  history: (tenant: string, project: string, id: string) =>
    ["history", tenant, project, id] as const,
  retrieval: (tenant: string, project: string, mode: string, filters: ExplorerFilters) =>
    ["retrieval", tenant, project, mode, filters] as const,
}
