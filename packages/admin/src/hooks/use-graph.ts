import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type NodeInput, type NodePatch } from "@/lib/api"
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

/**
 * The project's declared schema. It changes when the server is redeployed, not when the graph is
 * written to, so it is fetched once and kept — every node editor reads it.
 */
export function useSchema(tenant?: string, project?: string) {
  return useQuery({
    queryKey: qk.schema(tenant ?? "", project ?? ""),
    queryFn: () => api.getSchema(tenant as string, project as string),
    enabled: Boolean(tenant && project),
    staleTime: Number.POSITIVE_INFINITY,
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

/**
 * A node's markdown body + provenance (detail Sheet · Content tab). Lazy — pass `enabled: false`
 * until the tab is open so selecting a node in the graph doesn't pull every body over the wire.
 */
export function useNodeContent(
  tenant?: string,
  project?: string,
  id?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: qk.nodeContent(tenant ?? "", project ?? "", id ?? ""),
    queryFn: () => api.getNodeContent(tenant as string, project as string, id as string),
    enabled: Boolean(enabled && tenant && project && id),
  })
}

/**
 * Save a node's markdown body. The write is bitemporal (a successor version), so the version
 * trail is invalidated alongside the content itself. `data`/`type` are untouched by the PATCH,
 * and body is in neither the node list nor the graph slice — so neither is invalidated.
 */
export function useUpdateNodeBody(tenant?: string, project?: string, id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: string) =>
      api.updateNodeBody(tenant as string, project as string, id as string, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.nodeContent(tenant ?? "", project ?? "", id ?? "") })
      qc.invalidateQueries({ queryKey: qk.history(tenant ?? "", project ?? "", id ?? "") })
    },
  })
}

/**
 * Every cached view a write can change: the node list and the canvas slice are both filtered, and
 * a new/edited/retracted node can enter or leave any of those filters — so both are invalidated by
 * prefix rather than for the filters that happen to be active.
 */
function invalidateGraphViews(
  qc: ReturnType<typeof useQueryClient>,
  tenant?: string,
  project?: string,
): void {
  qc.invalidateQueries({ queryKey: qk.allNodes(tenant ?? "", project ?? "") })
  qc.invalidateQueries({ queryKey: qk.allGraph(tenant ?? "", project ?? "") })
}

/** Create a node. The server applies the type's schema defaults and returns the parsed node. */
export function useCreateNode(tenant?: string, project?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: NodeInput) => api.createNode(tenant as string, project as string, input),
    onSuccess: () => invalidateGraphViews(qc, tenant, project),
  })
}

/**
 * Edit a node's data (and optionally its body). Bitemporal: the write opens a successor version,
 * so the detail, its content and its version trail are all refetched alongside the graph views.
 */
export function useUpdateNode(tenant?: string, project?: string, id?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: NodePatch) =>
      api.updateNode(tenant as string, project as string, id as string, patch),
    onSuccess: () => {
      invalidateGraphViews(qc, tenant, project)
      qc.invalidateQueries({ queryKey: qk.node(tenant ?? "", project ?? "", id ?? "") })
      qc.invalidateQueries({ queryKey: qk.nodeContent(tenant ?? "", project ?? "", id ?? "") })
      qc.invalidateQueries({ queryKey: qk.history(tenant ?? "", project ?? "", id ?? "") })
    },
  })
}

/**
 * Retract a node: its live version closes, its history survives.
 *
 * Only the graph views are touched. The node's own cached detail is deliberately left alone —
 * evicting a query that a mounted inspector is still observing makes that inspector refetch a
 * node the server no longer serves, which answers 404. The caller clears its selection instead,
 * and the unobserved entry is garbage-collected.
 */
export function useDeleteNode(tenant?: string, project?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteNode(tenant as string, project as string, id),
    onSuccess: () => invalidateGraphViews(qc, tenant, project),
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

/** Seeds fed into the walk, and hops expanded from each. */
const RETRIEVE_K = 10
const RETRIEVE_DEPTH = 1

/**
 * Semantic / hybrid retrieval for the `q` filter. Idle unless the mode needs it and there is a
 * query — the endpoints 501 when the server has no embedder, so nothing fires by default.
 *
 * Results come back ordered by DEPTH, not relevance: the server walks outward from its seeds and
 * groups by hop. The list surfaces that ordering instead of pretending it is a relevance rank.
 */
export function useRetrieval(
  tenant?: string,
  project?: string,
  filters: ExplorerFilters = {},
) {
  const mode = filters.mode ?? "text"
  const query = filters.q?.trim() ?? ""
  const enabled = Boolean(tenant && project && query && mode !== "text")
  return useQuery({
    queryKey: qk.retrieval(tenant ?? "", project ?? "", mode, filters),
    enabled,
    queryFn: () => {
      const opts = { query, k: RETRIEVE_K, maxDepth: RETRIEVE_DEPTH, asOf: filters.asOf }
      return mode === "hybrid"
        ? api.hybrid(tenant as string, project as string, opts)
        : api.retrieve(tenant as string, project as string, opts)
    },
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
