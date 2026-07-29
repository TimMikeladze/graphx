import { describe, expect, it } from "bun:test"
import {
  dataHasImages,
  LABEL_COLUMN,
  sameGraph,
  sliceHasImages,
  toCosmograph,
} from "./cosmograph-adapter"
import { colorForType, legendOf } from "./graph-style"
import type { GraphSlice } from "./types"

const slice: GraphSlice = {
  nodes: [
    { id: "n1", type: "person" },
    { id: "n2", type: "person" },
    { id: "n3", type: "device" },
  ],
  links: [{ id: "e1", source: "n1", target: "n2", rel: "knows", weight: 3 }],
  truncated: false,
}

describe("colorForType", () => {
  it("is deterministic and stable for the same type", () => {
    expect(colorForType("person")).toBe(colorForType("person"))
  })
  it("returns a palette color", () => {
    expect(["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#22d3ee", "#fb7185", "#a3e635"]).toContain(
      colorForType("device"),
    )
  })
})

describe("toCosmograph labels", () => {
  it("uses the server label when present", () => {
    const { nodes } = toCosmograph({
      ...slice,
      nodes: [{ id: "n1", type: "person", label: "Ada Lovelace" }],
    })
    expect(nodes[0]?.label).toBe("Ada Lovelace")
  })
  it("falls back to the type when the node has no label", () => {
    const { nodes } = toCosmograph(slice)
    expect(nodes.map((n) => n.label)).toEqual(["person", "person", "device"])
  })

  it("materializes every caption column, so switching source needs no rebuild", () => {
    const { nodes } = toCosmograph({
      ...slice,
      nodes: [{ id: "01HF7YAT0644903PJ2WVXMA9YR", type: "person", label: "Ada Lovelace" }],
    })
    const n = nodes[0]
    expect(n?.label).toBe("Ada Lovelace")
    expect(n?.type).toBe("person")
    expect(n?.labelBoth).toBe("Ada Lovelace · person")
    expect(n?.labelId).toBe("01HF7Y…A9YR")
    // Every column LABEL_COLUMN can point at must exist on the row.
    for (const column of Object.values(LABEL_COLUMN)) {
      expect(typeof (n as Record<string, unknown>)[column]).toBe("string")
    }
  })
})

describe("toCosmograph", () => {
  it("maps links to source/target/indices/rel/weight", () => {
    const { links } = toCosmograph(slice)
    expect(links).toEqual([
      { source: "n1", target: "n2", sourceIndex: 0, targetIndex: 1, rel: "knows", weight: 3 },
    ])
  })

  it("assigns each node a sequential 0-based index (Cosmograph pointIndexBy)", () => {
    const { nodes } = toCosmograph(slice)
    expect(nodes.map((n) => n.index)).toEqual([0, 1, 2])
  })

  it("drops links whose endpoints are not in the node set", () => {
    const dangling: GraphSlice = {
      nodes: [{ id: "n1", type: "person" }],
      links: [{ id: "e1", source: "n1", target: "missing", rel: "knows", weight: 1 }],
      truncated: false,
    }
    expect(toCosmograph(dangling).links).toEqual([])
  })

  it("colors nodes by type (same type → same color)", () => {
    const { nodes } = toCosmograph(slice)
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
    expect(byId.n1.color).toBe(byId.n2.color) // both person
    expect(byId.n1.type).toBe("person")
  })

  it("flags the selected node only", () => {
    const { nodes } = toCosmograph(slice, { selectedId: "n3" })
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["n3"])
  })
})

describe("toCosmograph images", () => {
  it("carries the server image URL on its own column", () => {
    const { nodes } = toCosmograph({
      ...slice,
      nodes: [{ id: "n1", type: "person", image: "https://cdn.example/ada.png" }],
    })
    expect(nodes[0]?.image).toBe("https://cdn.example/ada.png")
  })

  it("uses an empty cell for a node with no image, so Cosmograph loads nothing", () => {
    const { nodes } = toCosmograph(slice)
    expect(nodes.map((n) => n.image)).toEqual(["", "", ""])
  })
})

describe("sliceHasImages", () => {
  it("is false when no node carries a picture", () => {
    expect(sliceHasImages(slice)).toBe(false)
  })
  it("is true when any node does", () => {
    expect(
      sliceHasImages({
        ...slice,
        nodes: [{ id: "n1", type: "person" }, { id: "n2", type: "person", image: "https://x/a.png" }],
      }),
    ).toBe(true)
  })
})

describe("dataHasImages", () => {
  it("is false when every point has an empty image cell", () => {
    expect(dataHasImages(toCosmograph(slice))).toBe(false)
  })
  it("is true when any point carries one", () => {
    const withPicture = {
      ...slice,
      nodes: [{ id: "n1", type: "person", image: "https://x/a.png" }],
    }
    expect(dataHasImages(toCosmograph(withPicture))).toBe(true)
  })
})

/**
 * The canvas waits on Cosmograph's `onGraphRebuilt` before handing over the next slice, and the
 * library only rebuilds when the data actually differs — so "same graph, new array" has to be
 * recognised here or the canvas waits for a callback that never comes.
 */
describe("sameGraph", () => {
  it("is true for a re-adapted identical slice, despite fresh array identity", () => {
    const a = toCosmograph(slice)
    const b = toCosmograph({ ...slice, nodes: [...slice.nodes], links: [...slice.links] })
    expect(a.nodes).not.toBe(b.nodes)
    expect(sameGraph(a, b)).toBe(true)
  })

  it("is false when a node is added or removed", () => {
    const a = toCosmograph(slice)
    const b = toCosmograph({ ...slice, nodes: slice.nodes.slice(0, 2), links: [] })
    expect(sameGraph(a, b)).toBe(false)
  })

  it("is false when only the links differ", () => {
    const a = toCosmograph(slice)
    const b = toCosmograph({ ...slice, links: [] })
    expect(sameGraph(a, b)).toBe(false)
  })

  it("is false when a node's label changes but its id does not", () => {
    const a = toCosmograph(slice)
    const b = toCosmograph({
      ...slice,
      nodes: [{ id: "n1", type: "person", label: "Ada" }, ...slice.nodes.slice(1)],
    })
    expect(sameGraph(a, b)).toBe(false)
  })

  it("is false when only the selection flag differs", () => {
    const a = toCosmograph(slice)
    const b = toCosmograph(slice, { selectedId: "n1" })
    expect(sameGraph(a, b)).toBe(false)
  })
})

describe("legendOf", () => {
  it("returns distinct types with their colors, sorted", () => {
    expect(legendOf(slice).map((l) => l.type)).toEqual(["device", "person"])
  })
})
