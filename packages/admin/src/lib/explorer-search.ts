import type { ExplorerFilters, SearchMode } from "./types"

const MODES: SearchMode[] = ["text", "semantic", "hybrid"]

/** Coerce a raw search param into a {@link SearchMode}; `text` is the default so it stays absent. */
function parseMode(raw: unknown): SearchMode | undefined {
  return typeof raw === "string" && MODES.includes(raw as SearchMode) && raw !== "text"
    ? (raw as SearchMode)
    : undefined
}

/**
 * The explorer URL search params — the single source of truth for filter + selection state
 * (spec §6). Validated/parsed here so the router and every consumer agree on the shape.
 */
export interface ExplorerSearch extends ExplorerFilters {
  /** Currently inspected node id (opens the detail Sheet). */
  node?: string
  /** Node ids the user has lazily expanded into the canvas. */
  expand: string[]
}

/** Coerce an unknown router search object into a validated {@link ExplorerSearch}. */
export function parseExplorerSearch(raw: Record<string, unknown>): ExplorerSearch {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined
  const asOfRaw = raw.asOf
  const asOf =
    typeof asOfRaw === "number"
      ? asOfRaw
      : typeof asOfRaw === "string" && asOfRaw.trim() !== "" && Number.isFinite(Number(asOfRaw))
        ? Number(asOfRaw)
        : undefined
  return {
    type: str(raw.type),
    q: str(raw.q),
    asOf,
    mode: parseMode(raw.mode),
    node: str(raw.node),
    expand: parseExpand(raw.expand),
  }
}

/** `expand` is carried as a comma-joined id list; parse to a de-duped array. */
function parseExpand(raw: unknown): string[] {
  if (Array.isArray(raw)) return [...new Set(raw.filter((v): v is string => typeof v === "string"))]
  if (typeof raw === "string" && raw.length > 0) return [...new Set(raw.split(","))]
  return []
}

/** The filter subset of the search (what the data hooks key on). */
export function filtersOf(search: ExplorerSearch): ExplorerFilters {
  return { type: search.type, q: search.q, asOf: search.asOf, mode: search.mode }
}

/** Add an id to the expand set (immutably). */
export function withExpanded(search: ExplorerSearch, id: string): string[] {
  return [...new Set([...search.expand, id])]
}
