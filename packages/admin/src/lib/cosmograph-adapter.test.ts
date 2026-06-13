import { describe, expect, it } from "vitest"
import { colorForKind, legendOf, toCosmograph } from "./cosmograph-adapter"
import type { GraphSlice } from "./types"

const slice: GraphSlice = {
  nodes: [
    { id: "n1", kind: "person" },
    { id: "n2", kind: "person" },
    { id: "n3", kind: "device" },
  ],
  links: [{ id: "e1", source: "n1", target: "n2", rel: "knows", weight: 3 }],
  truncated: false,
}

describe("colorForKind", () => {
  it("is deterministic and stable for the same kind", () => {
    expect(colorForKind("person")).toBe(colorForKind("person"))
  })
  it("returns a palette color", () => {
    expect(["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#22d3ee", "#fb7185", "#a3e635"]).toContain(
      colorForKind("device"),
    )
  })
})

describe("toCosmograph", () => {
  it("maps links to source/target/rel/weight", () => {
    const { links } = toCosmograph(slice)
    expect(links).toEqual([{ source: "n1", target: "n2", rel: "knows", weight: 3 }])
  })

  it("colors nodes by kind (same kind → same color)", () => {
    const { nodes } = toCosmograph(slice)
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
    expect(byId.n1.color).toBe(byId.n2.color) // both person
    expect(byId.n1.kind).toBe("person")
  })

  it("flags the selected node only", () => {
    const { nodes } = toCosmograph(slice, { selectedId: "n3" })
    expect(nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["n3"])
  })
})

describe("legendOf", () => {
  it("returns distinct kinds with their colors, sorted", () => {
    expect(legendOf(slice).map((l) => l.kind)).toEqual(["device", "person"])
  })
})
