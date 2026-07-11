import type { GraphSlice } from "./types"

/** A Cosmograph point (node) with a precomputed color + selection flag. */
export interface CosmoNode {
  id: string
  type: string
  color: string
  selected: boolean
  // Cosmograph's `CosmographInputData` row type is `Record<string, unknown>`.
  [key: string]: unknown
}

/** A Cosmograph link. Cosmograph keys edges on `source`/`target` point ids. */
export interface CosmoLink {
  source: string
  target: string
  rel: string
  weight: number
  [key: string]: unknown
}

/** The shape `<Cosmograph points={..} links={..} />` consumes. */
export interface CosmoData {
  nodes: CosmoNode[]
  links: CosmoLink[]
}

/** Categorical palette for color-by-type (kept small + legible on a dark canvas). */
export const KIND_PALETTE = [
  "#60a5fa", // blue
  "#f472b6", // pink
  "#34d399", // green
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#22d3ee", // cyan
  "#fb7185", // rose
  "#a3e635", // lime
] as const

/**
 * Deterministic type→color: a stable string hash into {@link KIND_PALETTE}, so the same type
 * always gets the same color across renders and slices (the legend stays consistent).
 */
export function colorForType(type: string, palette: readonly string[] = KIND_PALETTE): string {
  let h = 0
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) | 0
  return palette[Math.abs(h) % palette.length]
}

/** Options for {@link toCosmograph}. */
export interface ToCosmographOpts {
  /** The currently selected/inspected node id (flagged on its point). */
  selectedId?: string
  palette?: readonly string[]
}

/**
 * Pure adapter: a server {@link GraphSlice} → the `{nodes, links}` Cosmograph renders. This is
 * the only place the API shape meets the viz library, so it is unit-tested in isolation (the
 * canvas itself is WebGL and not unit-tested — spec §9).
 */
export function toCosmograph(slice: GraphSlice, opts: ToCosmographOpts = {}): CosmoData {
  const palette = opts.palette ?? KIND_PALETTE
  return {
    nodes: slice.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      color: colorForType(n.type, palette),
      selected: n.id === opts.selectedId,
    })),
    links: slice.links.map((l) => ({
      source: l.source,
      target: l.target,
      rel: l.rel,
      weight: l.weight,
    })),
  }
}

/** Distinct types present in a slice, for the canvas legend. */
export function legendOf(slice: GraphSlice, palette: readonly string[] = KIND_PALETTE): Array<{ type: string; color: string }> {
  const types = [...new Set(slice.nodes.map((n) => n.type))].sort()
  return types.map((type) => ({ type, color: colorForType(type, palette) }))
}
