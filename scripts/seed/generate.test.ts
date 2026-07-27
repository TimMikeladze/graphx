import { expect, test } from "bun:test"
import { generate } from "./generate.ts"
import { demoSchema } from "./schema.ts"

// The generator is pure, so every property here is checked without a database.

const NOW = 1_780_000_000_000
const cfg = { nodes: 2000, seed: 7, now: NOW }

/** `from`/`to` on a rel is a string, an array, or absent (= any type). */
function allowed(spec: unknown): Set<string> | null {
  if (spec === undefined) return null
  return new Set(typeof spec === "string" ? [spec] : (spec as string[]))
}

test("generate: the same seed yields an identical plan", () => {
  const a = generate(cfg)
  const b = generate(cfg)
  expect(a.nodes).toEqual(b.nodes)
  expect(a.edges).toEqual(b.edges)
})

test("generate: a different seed yields a different plan", () => {
  const a = generate(cfg)
  const b = generate({ ...cfg, seed: 8 })
  expect(a.nodes).not.toEqual(b.nodes)
})

test("generate: produces exactly the requested node count, ids unique, every type present", () => {
  const { nodes, types } = generate(cfg)
  expect(nodes.length).toBe(2000)
  expect(new Set(nodes.map((n) => n.id)).size).toBe(2000)
  expect(types.size).toBe(2000)
  const present = new Set(nodes.map((n) => n.type))
  for (const type of Object.keys(demoSchema.nodes)) expect(present.has(type as never)).toBe(true)
})

test("generate: an empty graph is legal", () => {
  const plan = generate({ ...cfg, nodes: 0 })
  expect(plan.nodes).toEqual([])
  expect(plan.edges).toEqual([])
})

test("generate: a tiny graph still produces nodes and edges", () => {
  const plan = generate({ ...cfg, nodes: 40 })
  expect(plan.nodes.length).toBe(40)
  expect(plan.edges.length).toBeGreaterThan(0)
})

test("generate: every edge endpoint refers to a node in the plan, with no self-loops", () => {
  const { nodes, edges } = generate(cfg)
  const ids = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    expect(ids.has(e.src)).toBe(true)
    expect(ids.has(e.dst)).toBe(true)
    expect(e.src).not.toBe(e.dst)
  }
})

test("generate: every edge satisfies its rel's from/to constraint", () => {
  const { edges, types } = generate(cfg)
  const defs = demoSchema.edges as Record<string, { from?: unknown; to?: unknown }>
  for (const e of edges) {
    const def = defs[e.rel]
    expect(def).toBeDefined()
    const from = allowed(def?.from)
    const to = allowed(def?.to)
    if (from) expect(from.has(types.get(e.src) as string)).toBe(true)
    if (to) expect(to.has(types.get(e.dst) as string)).toBe(true)
  }
})

test("generate: no duplicate (rel, src, dst) triples", () => {
  const { edges } = generate(cfg)
  const keys = new Set(edges.map((e) => `${e.rel}|${e.src}|${e.dst}`))
  expect(keys.size).toBe(edges.length)
})

test("generate: degree is skewed, not uniform", () => {
  const { nodes, edges } = generate(cfg)
  const degree = new Map<string, number>()
  for (const n of nodes) degree.set(n.id, 0)
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1)
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1)
  }
  const sorted = [...degree.values()].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] as number
  const max = sorted[sorted.length - 1] as number
  // Preferential attachment should leave the busiest node far above the middle of the pack.
  expect(max).toBeGreaterThan(median * 5)
})

test("generate: node creation times fall inside the window and skew recent", () => {
  const { nodes } = generate(cfg)
  const windowStart = NOW - 90 * 86_400_000
  for (const n of nodes) {
    expect(n.validFrom).toBeGreaterThanOrEqual(windowStart)
    expect(n.validFrom).toBeLessThanOrEqual(NOW)
  }
  // rand² skew: more than half the nodes land in the newest third of the window.
  const recent = nodes.filter((n) => n.validFrom > NOW - 30 * 86_400_000).length
  expect(recent / nodes.length).toBeGreaterThan(0.5)
})

test("generate: no edge predates either of its endpoints", () => {
  const { nodes, edges } = generate(cfg)
  const created = new Map(nodes.map((n) => [n.id, n.validFrom]))
  for (const e of edges) {
    expect(e.validFrom).toBeGreaterThanOrEqual(created.get(e.src) as number)
    expect(e.validFrom).toBeGreaterThanOrEqual(created.get(e.dst) as number)
    expect(e.validFrom).toBeLessThanOrEqual(NOW)
  }
})

test("generate: every node carries a body with real lexical variety", () => {
  const { nodes } = generate(cfg)
  const vocabulary = new Set<string>()
  for (const n of nodes) {
    expect(n.body).toBeTruthy()
    for (const word of (n.body as string).toLowerCase().split(/\W+/)) {
      if (word) vocabulary.add(word)
    }
  }
  expect(vocabulary.size).toBeGreaterThan(100)
})

test("generate: edge count scales roughly with node count", () => {
  const small = generate({ ...cfg, nodes: 1000 })
  const big = generate({ ...cfg, nodes: 4000 })
  const ratio = big.edges.length / small.edges.length
  expect(ratio).toBeGreaterThan(3)
  expect(ratio).toBeLessThan(5)
})
