/**
 * Turns a flat plan into one with history: some nodes gain a chain of versions, some edges end.
 * Pure and deterministic, like the generator — it rewrites a plan and touches no database.
 *
 * Versions are written through the bulk loaders' `id` + `validFrom`/`validTo` fields rather than
 * live `updateNode` calls, because `Graph.now()` is `Math.max(Date.now(), lastTs + 1)` with no
 * injection seam: a live write cannot be backdated, so a live pass would stamp every "historical"
 * version with the load time and the as-of picker would still have nothing to scrub through.
 */
import type { Plan, PlanNode } from "./generate.ts"

export interface HistoryConfig {
  seed: number
  now: number
  /** Fraction of nodes that gain extra versions (default 0.05). */
  nodeFraction?: number
  /** Fraction of edges that get closed (default 0.02). */
  edgeFraction?: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TICKET_STATES = ["open", "in progress", "blocked", "closed"]
const PROJECT_STATES = ["planned", "active", "paused", "shipped"]
const TITLES = ["engineer", "staff engineer", "product manager", "SRE", "engineering manager"]
const CITIES = ["Lisbon", "Berlin", "Toronto", "Austin", "Nairobi", "Osaka"]

/**
 * The state of a node at revision `rev`, counting back from the live version. Each type mutates
 * the field a reader would actually expect to change over time, so the history tab reads as a
 * plausible story rather than noise.
 */
function revise(node: PlanNode, rev: number, rand: () => number): Record<string, unknown> {
  const data = { ...node.data }
  switch (node.type) {
    case "ticket":
      data.state = TICKET_STATES[Math.floor(rand() * TICKET_STATES.length)] as string
      data.priority = Math.floor(rand() * 4)
      break
    case "project":
      data.status = PROJECT_STATES[Math.floor(rand() * PROJECT_STATES.length)] as string
      break
    case "person":
      data.title = TITLES[Math.floor(rand() * TITLES.length)] as string
      if (rand() < 0.3) data.location = CITIES[Math.floor(rand() * CITIES.length)] as string
      break
    case "document":
      data.title = `${String(data.title)} (draft ${rev})`
      break
    default:
      break
  }
  return data
}

/** `count` timestamps strictly inside `(from, to)`, ascending and distinct. */
function breakpoints(from: number, to: number, count: number, rand: () => number): number[] {
  const span = to - from
  if (span <= count + 1) return []
  const picks = new Set<number>()
  let guard = 0
  while (picks.size < count && guard++ < count * 20) {
    const t = Math.round(from + 1 + rand() * (span - 2))
    if (t > from && t < to) picks.add(t)
  }
  return [...picks].sort((a, b) => a - b)
}

/**
 * Expand a slice of the plan into version chains and close a slice of its edges.
 *
 * Node chains keep the original `validFrom` as the first version's start and leave the last
 * version open, so the live view is unchanged in content — only the history behind it grows.
 * Closed edges get a `validTo` inside the window and no successor: the relationship ended.
 */
export function withHistory(plan: Plan, config: HistoryConfig): Plan {
  const rand = mulberry32(config.seed)
  const nodeFraction = config.nodeFraction ?? 0.05
  const edgeFraction = config.edgeFraction ?? 0.02
  const now = config.now

  const nodes: PlanNode[] = []
  for (const node of plan.nodes) {
    if (rand() >= nodeFraction) {
      nodes.push(node)
      continue
    }
    const revisions = 1 + Math.floor(rand() * 4) // 2-5 versions total
    const cuts = breakpoints(node.validFrom, now, revisions, rand)
    if (cuts.length === 0) {
      nodes.push(node)
      continue
    }
    // Segment starts: the node's creation, then each cut. Segment i ends where i+1 begins,
    // and the last one stays open — so the live view keeps the node's original content.
    const starts = [node.validFrom, ...cuts]
    starts.forEach((from, i) => {
      const last = i === starts.length - 1
      nodes.push({
        ...node,
        data: last ? node.data : revise(node, i + 1, rand),
        body: last ? node.body : `${node.body} Superseded revision ${i + 1}.`,
        validFrom: from,
        ...(last ? {} : { validTo: starts[i + 1] as number }),
      })
    })
  }

  const edges = plan.edges.map((edge) => {
    if (rand() >= edgeFraction) return edge
    const span = now - edge.validFrom
    if (span <= 1) return edge
    return { ...edge, validTo: Math.round(edge.validFrom + 1 + rand() * (span - 1)) }
  })

  return { nodes, edges, types: plan.types }
}
