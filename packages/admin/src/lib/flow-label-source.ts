import { createContext } from "react"
import type { LabelSource } from "./graph-style"

/**
 * Which caption the flow cards render. Carried by context rather than baked into each node's
 * data: changing the label source then re-renders the cards without rebuilding — and re-laying
 * out — the graph. Kept out of the card module so that file only exports its component.
 */
export const FlowLabelSourceContext = createContext<LabelSource>("name")

/**
 * Whether the cards draw each node's avatar. Carried by context for the same reason as the
 * caption source: toggling pictures must re-render the cards, not rebuild and re-lay-out the graph.
 */
export const FlowShowImagesContext = createContext<boolean>(true)
