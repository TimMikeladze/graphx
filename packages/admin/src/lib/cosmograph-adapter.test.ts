import { describe, expect, it } from "bun:test"
import { colorForType, legendOf, toCosmograph } from "./cosmograph-adapter"
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

describe("toCosmograph", () => {
  it("maps links to source/target/rel/weight", () => {
    const { links } = toCosmograph(slice)
    expect(links).toEqual([{ source: "n1", target: "n2", rel: "knows", weight: 3 }])
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

describe("legendOf", () => {
  it("returns distinct types with their colors, sorted", () => {
    expect(legendOf(slice).map((l) => l.type)).toEqual(["device", "person"])
  })
})
