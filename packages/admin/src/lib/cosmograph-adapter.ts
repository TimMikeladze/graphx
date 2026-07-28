import { shortId } from "./format"
import { colorForType, KIND_PALETTE, type LabelSource } from "./graph-style"
import type { GraphSlice } from "./types"

/** A Cosmograph point (node) with a precomputed color + selection flag. */
export interface CosmoNode {
  id: string
  /** Sequential 0-based row index — Cosmograph v2 requires `pointIndexBy`. */
  index: number
  type: string
  color: string
  selected: boolean
  /**
   * The caption columns `pointLabelBy` can be pointed at. All four are materialized up front
   * because switching the label source must not rebuild the graph — changing `pointLabelBy` to
   * another existing column is a cheap label-only update, whereas changing the point rows is a
   * full duckdb re-upload.
   */
  /** The node's name/title, falling back to its type when its data carries neither. */
  label: string
  /** Abbreviated id, for when the name is ambiguous and the identity is what matters. */
  labelId: string
  /** Name and type together. */
  labelBoth: string
  /**
   * Avatar/thumbnail URL for `pointImageUrlBy`, or `""` when the node has none (Cosmograph
   * loads nothing for an empty cell, leaving the colored dot).
   */
  image: string
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
    // Cosmograph skips points whose label column is empty, so fall back to the type rather
    // than leave an untyped hole in the canvas.
    const label = n.label ?? n.type
    return {
      id: n.id,
      index,
      type: n.type,
      color: colorForType(n.type, palette),
      selected: n.id === opts.selectedId,
      label,
      labelId: shortId(n.id, 6, 4),
      labelBoth: `${label} · ${n.type}`,
      image: n.image ?? "",
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

/** The {@link CosmoNode} column each source reads, for Cosmograph's `pointLabelBy`. */
export const LABEL_COLUMN: Record<Exclude<LabelSource, "off">, string> = {
  name: "label",
  type: "type",
  id: "labelId",
  both: "labelBoth",
}

/** The {@link CosmoNode} column holding the avatar URL, for Cosmograph's `pointImageUrlBy`. */
export const IMAGE_COLUMN = "image"

/** True when any node in the slice has a picture — the toggle is pointless otherwise. */
export function sliceHasImages(slice: GraphSlice): boolean {
  return slice.nodes.some((n) => n.image)
}
