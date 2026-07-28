import { describe, expect, it } from "bun:test"
import { noRelReason, relsFor } from "./edge-rels"
import type { SchemaEdgeRel } from "./types"

const rel = (
  name: string,
  from: string[] | null,
  to: string[] | null,
): SchemaEdgeRel => ({ rel: name, from, to, single: false, jsonSchema: null })

const RELS: SchemaEdgeRel[] = [
  rel("knows", ["person"], ["person"]),
  rel("owns", ["team"], ["project", "repo"]),
  rel("linked", null, null),
]

describe("relsFor", () => {
  it("keeps the rels whose endpoint types both match", () => {
    expect(relsFor(RELS, "person", "person").map((r) => r.rel)).toEqual(["knows", "linked"])
  })

  it("matches against a multi-type endpoint list", () => {
    expect(relsFor(RELS, "team", "repo").map((r) => r.rel)).toEqual(["owns", "linked"])
    expect(relsFor(RELS, "team", "person").map((r) => r.rel)).toEqual(["linked"])
  })

  it("always keeps an unconstrained rel", () => {
    expect(relsFor(RELS, "tag", "ticket").map((r) => r.rel)).toEqual(["linked"])
  })

  it("cannot rule anything out for an unknown endpoint type", () => {
    expect(relsFor(RELS, undefined, "person").map((r) => r.rel)).toEqual(["knows", "linked"])
    expect(relsFor(RELS, undefined, undefined)).toHaveLength(3)
  })

  it("respects direction — a rel is not reversible", () => {
    expect(relsFor([rel("owns", ["team"], ["repo"])], "repo", "team")).toEqual([])
  })
})

describe("noRelReason", () => {
  it("is silent when something matches", () => {
    expect(noRelReason(RELS, "person", "person")).toBeUndefined()
  })

  it("names the pair that has no relation", () => {
    const constrained = [rel("knows", ["person"], ["person"])]
    expect(noRelReason(constrained, "team", "repo")).toBe(
      "No declared relation goes from team to repo.",
    )
  })

  it("says so when the project declares none at all", () => {
    expect(noRelReason([], "person", "person")).toBe("This project declares no relations.")
  })
})
