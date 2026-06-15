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
  node: (tenant: string, project: string, id: string) => ["node", tenant, project, id] as const,
  neighbors: (tenant: string, project: string, id: string) =>
    ["neighbors", tenant, project, id] as const,
  history: (tenant: string, project: string, id: string) =>
    ["history", tenant, project, id] as const,
}
