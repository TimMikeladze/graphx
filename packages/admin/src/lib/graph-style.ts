import type { GraphSlice } from "./types"

/**
 * Styling and caption rules shared by every graph renderer (Cosmograph, xyflow). Kept out of the
 * per-renderer adapters so the two canvases cannot drift into different colors or legends.
 */

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

/** What a node's caption shows. `off` hides node captions entirely. */
export type LabelSource = "off" | "name" | "type" | "id" | "both"

/** The canvas label settings the toolbar edits. */
export interface LabelSettings {
  source: LabelSource
  /** Show the rel name on edges (all of them when the slice is small, else the focused node's). */
  edges: boolean
  /**
   * How many captions to show at once — the knob for how crowded the canvas reads. Cosmograph
   * only; xyflow draws the caption inside every card, so there is nothing to ration.
   */
  limit: number
  /**
   * Draw each node's avatar (when its data carries one) instead of a plain colored dot. A node
   * without a picture is unaffected either way.
   */
  images: boolean
}

export const DEFAULT_LABEL_SETTINGS: LabelSettings = {
  source: "name",
  edges: false,
  limit: 40,
  images: true,
}

/** Distinct types present in a slice, for the canvas legend. */
export function legendOf(
  slice: GraphSlice,
  palette: readonly string[] = KIND_PALETTE,
): Array<{ type: string; color: string }> {
  const types = [...new Set(slice.nodes.map((n) => n.type))].sort()
  return types.map((type) => ({ type, color: colorForType(type, palette) }))
}
