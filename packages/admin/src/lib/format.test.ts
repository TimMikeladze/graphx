import { describe, expect, it } from "bun:test"
import { bestLabel, fmtTime, FOREVER, shortId } from "./format"

describe("shortId", () => {
  it("elides the middle of a long id", () => {
    expect(shortId("01KY96AJ6ZKAK2G7AA9999", 6, 4)).toBe("01KY96…9999")
  })
  it("passes short ids through untouched", () => {
    expect(shortId("abc", 6, 4)).toBe("abc")
  })
})

describe("fmtTime", () => {
  it("renders the FOREVER sentinel as live", () => {
    expect(fmtTime(FOREVER)).toBe("live")
  })
})

describe("bestLabel", () => {
  it("prefers name over other keys", () => {
    expect(bestLabel({ title: "T", name: "Bletchley Park" })).toBe("Bletchley Park")
  })
  it("falls back through the priority list", () => {
    expect(bestLabel({ label: "L" })).toBe("L")
  })
  it("ignores blank and non-string values", () => {
    expect(bestLabel({ name: "   ", title: 42, slug: "s" })).toBe("s")
  })
  it("returns undefined when nothing is labelled", () => {
    expect(bestLabel({ age: 1 })).toBeUndefined()
    expect(bestLabel(null)).toBeUndefined()
    expect(bestLabel(undefined)).toBeUndefined()
  })
})
