import { describe, expect, it } from "bun:test"
import {
  exceedsFlowCap,
  FLOW_EDGE_LABEL_MAX,
  FLOW_MAX_NODES,
  layoutFlow,
  NODE_HEIGHT,
  NODE_WIDTH,
  toFlow,
} from "./flow-adapter"
import type { GraphSlice } from "./types"

const slice: GraphSlice = {
  nodes: [
    { id: "n1", type: "person", label: "Ada Lovelace" },
    { id: "n2", type: "person" },
    { id: "n3", type: "device" },
  ],
  links: [
    { id: "e1", source: "n1", target: "n2", rel: "knows", weight: 3 },
    { id: "e2", source: "n2", target: "n3", rel: "uses", weight: 1 },
  ],
  truncated: false,
}

/** A connected chain of `n` nodes — enough structure for both layouts to have work to do. */
function chain(n: number): GraphSlice {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: i % 2 ? "person" : "device" })),
    links: Array.from({ length: n - 1 }, (_, i) => ({
      id: `e${i}`,
      source: `n${i}`,
      target: `n${i + 1}`,
      rel: "next",
      weight: 1,
    })),
    truncated: false,
  }
}

describe("toFlow", () => {
  it("builds one card per node, typed for the custom renderer", () => {
    const { nodes } = toFlow(slice)
    expect(nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"])
    expect(nodes.every((n) => n.type === "graphNode")).toBe(true)
  })

  it("materializes every caption variant, so the label source is a re-render not a rebuild", () => {
    const { nodes } = toFlow({
      ...slice,
      nodes: [{ id: "01HF7YAT0644903PJ2WVXMA9YR", type: "person", label: "Ada Lovelace" }],
    })
    expect(nodes[0]?.data.label).toBe("Ada Lovelace")
    expect(nodes[0]?.data.labelBoth).toBe("Ada Lovelace · person")
    expect(nodes[0]?.data.labelId).toBe("01HF7Y…A9YR")
  })

  it("falls back to the type when the node has no label", () => {
    expect(toFlow(slice).nodes.map((n) => n.data.label)).toEqual([
      "Ada Lovelace",
      "person",
      "device",
    ])
  })

  it("counts degree within the slice", () => {
    const byId = Object.fromEntries(toFlow(slice).nodes.map((n) => [n.id, n.data.degree]))
    expect(byId).toEqual({ n1: 1, n2: 2, n3: 1 })
  })

  it("colors nodes by type (same type → same color)", () => {
    const [n1, n2, n3] = toFlow(slice).nodes
    expect(n1?.data.color).toBe(n2?.data.color as string)
    expect(n1?.data.color).not.toBe(n3?.data.color as string)
  })

  it("drops links whose endpoints are not in the node set", () => {
    const dangling: GraphSlice = {
      nodes: [{ id: "n1", type: "person" }],
      links: [{ id: "e1", source: "n1", target: "missing", rel: "knows", weight: 1 }],
      truncated: false,
    }
    const { edges, nodes } = toFlow(dangling)
    expect(edges).toEqual([])
    // …and the dropped link does not count toward its surviving endpoint's degree.
    expect(nodes[0]?.data.degree).toBe(0)
  })

  it("labels edges only when asked", () => {
    expect(toFlow(slice).edges.map((e) => e.label)).toEqual([undefined, undefined])
    expect(toFlow(slice, { showEdgeLabels: true }).edges.map((e) => e.label)).toEqual([
      "knows",
      "uses",
    ])
  })

  it("drops edge labels once the slice is too dense to read them", () => {
    const dense = chain(FLOW_EDGE_LABEL_MAX + 3)
    expect(dense.links.length).toBeGreaterThan(FLOW_EDGE_LABEL_MAX)
    const { edges } = toFlow(dense, { showEdgeLabels: true })
    expect(edges.every((e) => e.label === undefined)).toBe(true)
  })
})

describe("exceedsFlowCap", () => {
  it("passes a slice at the cap and rejects the one past it", () => {
    expect(exceedsFlowCap(chain(FLOW_MAX_NODES))).toBe(false)
    expect(exceedsFlowCap(chain(FLOW_MAX_NODES + 1))).toBe(true)
  })
})

describe("layoutFlow", () => {
  for (const layout of ["layered", "organic"] as const) {
    describe(layout, () => {
      it("gives every node a finite, distinct position", () => {
        const { nodes } = layoutFlow(toFlow(chain(30)), layout)
        const seen = new Set<string>()
        for (const n of nodes) {
          expect(Number.isFinite(n.position.x)).toBe(true)
          expect(Number.isFinite(n.position.y)).toBe(true)
          seen.add(`${Math.round(n.position.x)},${Math.round(n.position.y)}`)
        }
        expect(seen.size).toBe(nodes.length)
      })

      it("is deterministic — same slice, same coordinates", () => {
        const once = layoutFlow(toFlow(chain(40)), layout).nodes.map((n) => n.position)
        const twice = layoutFlow(toFlow(chain(40)), layout).nodes.map((n) => n.position)
        expect(once).toEqual(twice)
      })

      it("spreads nodes by at least a card's size", () => {
        const { nodes } = layoutFlow(toFlow(chain(12)), layout)
        const xs = nodes.map((n) => n.position.x)
        const ys = nodes.map((n) => n.position.y)
        const spanX = Math.max(...xs) - Math.min(...xs)
        const spanY = Math.max(...ys) - Math.min(...ys)
        expect(Math.max(spanX, spanY)).toBeGreaterThan(NODE_WIDTH + NODE_HEIGHT)
      })
    })
  }

  it("keeps a loose node near the organic cluster instead of flinging it into empty space", () => {
    const withLoner: GraphSlice = {
      ...chain(20),
      nodes: [...chain(20).nodes, { id: "loner", type: "tag" }],
    }
    const placed = layoutFlow(toFlow(withLoner), "organic").nodes
    const cluster = placed.filter((n) => n.id !== "loner")
    const loner = placed.find((n) => n.id === "loner")
    const reach = Math.max(
      ...cluster.map((n) => Math.hypot(n.position.x, n.position.y)),
    )
    expect(Math.hypot(loner?.position.x ?? 0, loner?.position.y ?? 0)).toBeLessThan(reach * 2)
  })

  it("keeps the cards themselves untouched (placement only)", () => {
    const built = toFlow(slice)
    const placed = layoutFlow(built, "layered")
    expect(placed.nodes.map((n) => n.data)).toEqual(built.nodes.map((n) => n.data))
  })

  it("grids edge-less nodes instead of stacking them in one dagre rank", () => {
    const loose: GraphSlice = {
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, type: "team" })),
      links: [],
      truncated: false,
    }
    const { nodes } = layoutFlow(toFlow(loose), "layered")
    const columns = new Set(nodes.map((n) => n.position.x))
    const rows = new Set(nodes.map((n) => n.position.y))
    expect(columns.size).toBeGreaterThan(1)
    expect(rows.size).toBeGreaterThan(1)
    // Roughly square, so a filtered slice reads as a block rather than a mile-long column.
    expect(Math.abs(columns.size - rows.size)).toBeLessThanOrEqual(2)
  })

  it("puts the loose nodes below the ranked ones, never on top of them", () => {
    const mixed: GraphSlice = {
      nodes: [
        { id: "a", type: "person" },
        { id: "b", type: "person" },
        { id: "loose", type: "device" },
      ],
      links: [{ id: "e", source: "a", target: "b", rel: "knows", weight: 1 }],
      truncated: false,
    }
    const placed = Object.fromEntries(
      layoutFlow(toFlow(mixed), "layered").nodes.map((n) => [n.id, n.position]),
    )
    expect(placed.loose.y).toBeGreaterThan(Math.max(placed.a.y, placed.b.y) + NODE_HEIGHT)
  })

  it("places disconnected components too", () => {
    const islands: GraphSlice = {
      nodes: [
        { id: "a", type: "person" },
        { id: "b", type: "person" },
        { id: "c", type: "device" },
      ],
      links: [{ id: "e", source: "a", target: "b", rel: "knows", weight: 1 }],
      truncated: false,
    }
    const { nodes } = layoutFlow(toFlow(islands), "layered")
    expect(nodes.every((n) => Number.isFinite(n.position.x))).toBe(true)
  })

  it("survives a cycle (dagre breaks it internally)", () => {
    const cyclic: GraphSlice = {
      nodes: [
        { id: "a", type: "person" },
        { id: "b", type: "person" },
      ],
      links: [
        { id: "e1", source: "a", target: "b", rel: "knows", weight: 1 },
        { id: "e2", source: "b", target: "a", rel: "knows", weight: 1 },
      ],
      truncated: false,
    }
    const { nodes } = layoutFlow(toFlow(cyclic), "layered")
    expect(nodes).toHaveLength(2)
    expect(nodes[0]?.position).not.toEqual(nodes[1]?.position)
  })

  it("styles edges for the layout it just ran", () => {
    expect(layoutFlow(toFlow(slice), "layered").edges.every((e) => e.type === "default")).toBe(true)
    expect(layoutFlow(toFlow(slice), "organic").edges.every((e) => e.type === "straight")).toBe(true)
  })
})
