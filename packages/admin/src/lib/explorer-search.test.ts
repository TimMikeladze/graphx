import { describe, expect, it } from "bun:test"
import {
  filtersOf,
  parseExplorerSearch,
  withExpanded,
} from "./explorer-search"

describe("parseExplorerSearch", () => {
  it("extracts string filters and node id", () => {
    const s = parseExplorerSearch({ type: "person", q: "ada", node: "n1" })
    expect(s.type).toBe("person")
    expect(s.q).toBe("ada")
    expect(s.node).toBe("n1")
  })

  it("drops empty strings to undefined", () => {
    const s = parseExplorerSearch({ type: "", q: "" })
    expect(s.type).toBeUndefined()
    expect(s.q).toBeUndefined()
  })

  it("coerces asOf from number or numeric string, else undefined", () => {
    expect(parseExplorerSearch({ asOf: 123 }).asOf).toBe(123)
    expect(parseExplorerSearch({ asOf: "456" }).asOf).toBe(456)
    expect(parseExplorerSearch({ asOf: "soon" }).asOf).toBeUndefined()
    expect(parseExplorerSearch({}).asOf).toBeUndefined()
  })

  it("accepts the known search modes and rejects anything else", () => {
    expect(parseExplorerSearch({ mode: "semantic" }).mode).toBe("semantic")
    expect(parseExplorerSearch({ mode: "hybrid" }).mode).toBe("hybrid")
    expect(parseExplorerSearch({ mode: "sql" }).mode).toBeUndefined()
    expect(parseExplorerSearch({ mode: 7 }).mode).toBeUndefined()
  })

  it("normalises the default mode to undefined so it stays out of the URL", () => {
    expect(parseExplorerSearch({ mode: "text" }).mode).toBeUndefined()
    expect(parseExplorerSearch({}).mode).toBeUndefined()
  })

  it("parses expand from a comma string and an array, de-duped", () => {
    expect(parseExplorerSearch({ expand: "a,b,a" }).expand).toEqual(["a", "b"])
    expect(parseExplorerSearch({ expand: ["x", "x", "y"] }).expand).toEqual(["x", "y"])
    expect(parseExplorerSearch({}).expand).toEqual([])
  })
})

describe("filtersOf", () => {
  it("returns only the filter subset", () => {
    const s = parseExplorerSearch({ type: "device", q: "router", asOf: 9, node: "n1", expand: "a" })
    expect(filtersOf(s)).toEqual({ type: "device", q: "router", asOf: 9, mode: undefined })
  })

  it("carries the search mode, since it changes which endpoint runs the query", () => {
    const s = parseExplorerSearch({ q: "enigma", mode: "hybrid" })
    expect(filtersOf(s).mode).toBe("hybrid")
  })
})

describe("withExpanded", () => {
  it("adds an id without duplicating", () => {
    const s = parseExplorerSearch({ expand: "a" })
    expect(withExpanded(s, "b")).toEqual(["a", "b"])
    expect(withExpanded(s, "a")).toEqual(["a"])
  })
})
