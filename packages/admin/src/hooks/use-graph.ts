import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import type { ExplorerFilters } from "@/lib/types"

/** All tenants (control plane). */
export function useTenants() {
  return useQuery({ queryKey: qk.tenants(), queryFn: () => api.listTenants() })
}

/** Projects in a tenant; disabled until a tenant is selected. */
export function useProjects(tenantId?: string) {
  return useQuery({
    queryKey: qk.projects(tenantId ?? ""),
    queryFn: () => api.listProjects(tenantId as string),
    enabled: Boolean(tenantId),
  })
}

/** All users (control plane). */
export function useUsers() {
  return useQuery({ queryKey: qk.users(), queryFn: () => api.listUsers() })
}

const PAGE_SIZE = 50

/** Keyset-paginated node list (master), keyed on the active filters. */
export function useNodes(tenant?: string, project?: string, filters: ExplorerFilters = {}) {
  return useInfiniteQuery({
    queryKey: qk.nodes(tenant ?? "", project ?? "", filters),
    enabled: Boolean(tenant && project),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listNodes(tenant as string, project as string, {
        ...filters,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
}

/** Governed graph slice for the canvas, keyed on the active filters. */
export function useGraphSlice(tenant?: string, project?: string, filters: ExplorerFilters = {}) {
  return useQuery({
    queryKey: qk.graph(tenant ?? "", project ?? "", filters),
    enabled: Boolean(tenant && project),
    queryFn: () => api.graphSlice(tenant as string, project as string, filters),
  })
}

/** A single node (detail Sheet). */
export function useNode(tenant?: string, project?: string, id?: string) {
  return useQuery({
    queryKey: qk.node(tenant ?? "", project ?? "", id ?? ""),
    queryFn: () => api.getNode(tenant as string, project as string, id as string),
    enabled: Boolean(tenant && project && id),
  })
}

/** A node's neighbors (detail Sheet · Neighbors tab). */
export function useNeighbors(tenant?: string, project?: string, id?: string) {
  return useQuery({
    queryKey: qk.neighbors(tenant ?? "", project ?? "", id ?? ""),
    queryFn: () => api.neighbors(tenant as string, project as string, id as string),
    enabled: Boolean(tenant && project && id),
  })
}

/** A node's version history (detail Sheet · History tab). */
export function useHistory(tenant?: string, project?: string, id?: string) {
  return useQuery({
    queryKey: qk.history(tenant ?? "", project ?? "", id ?? ""),
    queryFn: () => api.history(tenant as string, project as string, id as string),
    enabled: Boolean(tenant && project && id),
  })
}
