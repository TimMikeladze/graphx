import type { GraphSlice } from "./types"

/** A Cosmograph point (node) with a precomputed color + selection flag. */
export interface CosmoNode {
  id: string
  /** Sequential 0-based row index — Cosmograph v2 requires `pointIndexBy`. */
  index: number
  type: string
  color: string
  selected: boolean
  /** Caption for `pointLabelBy`. Always a string: the server label, else the type. */
  label: string
  // Cosmograph's `CosmographInputData` row type is `Record<string, unknown>`.
  [key: string]: unknown
}

/** A Cosmograph link. Cosmograph keys edges on `source`/`target` point ids + numeric indices. */
export interface CosmoLink {
  source: string
  target: string
  /** Endpoint row indices — Cosmograph v2 requires `linkSourceIndexBy`/`linkTargetIndexBy`. */
  sourceIndex: number
  targetIndex: number
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
 *
 * Cosmograph v2 requires index columns alongside ids: every point carries a sequential `index`,
 * and every link carries `sourceIndex`/`targetIndex` resolved from the id→index map. Links whose
 * endpoints are not in the node set are dropped (a governed slice should be consistent, but the
 * renderer throws on unresolved endpoints, so we stay defensive).
 */
export function toCosmograph(slice: GraphSlice, opts: ToCosmographOpts = {}): CosmoData {
  const palette = opts.palette ?? KIND_PALETTE
  const indexById = new Map<string, number>()

  const nodes: CosmoNode[] = slice.nodes.map((n, index) => {
    indexById.set(n.id, index)
    return {
      id: n.id,
      index,
      type: n.type,
      color: colorForType(n.type, palette),
      selected: n.id === opts.selectedId,
      // Cosmograph skips points whose label column is empty, so fall back to the type rather
      // than leave an untyped hole in the canvas.
      label: n.label ?? n.type,
    }
  })

  const links: CosmoLink[] = []
  for (const l of slice.links) {
    const sourceIndex = indexById.get(l.source)
    const targetIndex = indexById.get(l.target)
    if (sourceIndex === undefined || targetIndex === undefined) continue
    links.push({
      source: l.source,
      target: l.target,
      sourceIndex,
      targetIndex,
      rel: l.rel,
      weight: l.weight,
    })
  }

  return { nodes, links }
}

/** Distinct types present in a slice, for the canvas legend. */
export function legendOf(slice: GraphSlice, palette: readonly string[] = KIND_PALETTE): Array<{ type: string; color: string }> {
  const types = [...new Set(slice.nodes.map((n) => n.type))].sort()
  return types.map((type) => ({ type, color: colorForType(type, palette) }))
}
