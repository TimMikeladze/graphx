import { describe, expect, it } from "bun:test"
import {
  filtersOf,
  parseExplorerSearch,
  withExpanded,
} from "./explorer-search"

describe("parseExplorerSearch", () => {
  it("extracts string filters and node id", () => {
    const s = parseExplorerSearch({ kind: "person", q: "ada", node: "n1" })
    expect(s.kind).toBe("person")
    expect(s.q).toBe("ada")
    expect(s.node).toBe("n1")
  })

  it("drops empty strings to undefined", () => {
    const s = parseExplorerSearch({ kind: "", q: "" })
    expect(s.kind).toBeUndefined()
    expect(s.q).toBeUndefined()
  })

  it("coerces asOf from number or numeric string, else undefined", () => {
    expect(parseExplorerSearch({ asOf: 123 }).asOf).toBe(123)
    expect(parseExplorerSearch({ asOf: "456" }).asOf).toBe(456)
    expect(parseExplorerSearch({ asOf: "soon" }).asOf).toBeUndefined()
    expect(parseExplorerSearch({}).asOf).toBeUndefined()
  })

  it("parses expand from a comma string and an array, de-duped", () => {
    expect(parseExplorerSearch({ expand: "a,b,a" }).expand).toEqual(["a", "b"])
    expect(parseExplorerSearch({ expand: ["x", "x", "y"] }).expand).toEqual(["x", "y"])
    expect(parseExplorerSearch({}).expand).toEqual([])
  })
})

describe("filtersOf", () => {
  it("returns only the filter subset", () => {
    const s = parseExplorerSearch({ kind: "device", q: "router", asOf: 9, node: "n1", expand: "a" })
    expect(filtersOf(s)).toEqual({ kind: "device", q: "router", asOf: 9 })
  })
})

describe("withExpanded", () => {
  it("adds an id without duplicating", () => {
    const s = parseExplorerSearch({ expand: "a" })
    expect(withExpanded(s, "b")).toEqual(["a", "b"])
    expect(withExpanded(s, "a")).toEqual(["a"])
  })
})
