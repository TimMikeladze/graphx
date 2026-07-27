import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { CACHE_FILE, fingerprint, isCached, wipe, writeCache } from "./cache.ts"

// The cache reads and writes relative to the working directory (the dev server runs from the
// repo root), so each test gets its own directory to work in.

const KEY = {
  schemaVersion: 1,
  seed: 42,
  dim: 128,
  embedded: 5000,
  fixtures: [{ namespace: "ns_a", nodes: 100 }],
}

let dir: string
let previous: string

beforeEach(() => {
  previous = process.cwd()
  dir = mkdtempSync(join(tmpdir(), "graphx-seed-cache-"))
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(previous)
  rmSync(dir, { recursive: true, force: true })
})

/** Stand in for a built database. */
function touchDb(namespace: string): void {
  writeFileSync(`${namespace}.db`, "")
}

test("fingerprint: stable for the same key, different for any change", () => {
  expect(fingerprint(KEY)).toBe(fingerprint({ ...KEY }))
  expect(fingerprint({ ...KEY, seed: 43 })).not.toBe(fingerprint(KEY))
  expect(fingerprint({ ...KEY, schemaVersion: 2 })).not.toBe(fingerprint(KEY))
  expect(fingerprint({ ...KEY, embedded: 0 })).not.toBe(fingerprint(KEY))
  // The emb column width is immutable, so a dim change must force a rebuild.
  expect(fingerprint({ ...KEY, dim: 256 })).not.toBe(fingerprint(KEY))
  expect(fingerprint({ ...KEY, fixtures: [{ namespace: "ns_a", nodes: 101 }] })).not.toBe(
    fingerprint(KEY),
  )
})

test("isCached: false with no cache file", () => {
  expect(isCached(fingerprint(KEY), ["ns_a"])).toBe(false)
})

test("isCached: true once written and the databases exist", () => {
  const fp = fingerprint(KEY)
  touchDb("ns_a")
  writeCache(fp, ["ns_a"])
  expect(isCached(fp, ["ns_a"])).toBe(true)
})

test("isCached: false when the fingerprint changed", () => {
  touchDb("ns_a")
  writeCache(fingerprint(KEY), ["ns_a"])
  expect(isCached(fingerprint({ ...KEY, seed: 43 }), ["ns_a"])).toBe(false)
})

test("isCached: false when a database file is missing", () => {
  const fp = fingerprint(KEY)
  touchDb("ns_a")
  writeCache(fp, ["ns_a", "ns_b"])
  expect(isCached(fp, ["ns_a", "ns_b"])).toBe(false)
})

test("isCached: false when the namespace set changed", () => {
  const fp = fingerprint(KEY)
  touchDb("ns_a")
  writeCache(fp, ["ns_a"])
  expect(isCached(fp, ["ns_a", "ns_b"])).toBe(false)
})

test("isCached: false on an unparseable cache file", () => {
  touchDb("ns_a")
  writeFileSync(CACHE_FILE, "{ not json")
  expect(isCached(fingerprint(KEY), ["ns_a"])).toBe(false)
})

test("wipe: removes the databases and the cache file", () => {
  const fp = fingerprint(KEY)
  touchDb("ns_a")
  writeFileSync("ns_a.db-wal", "")
  writeCache(fp, ["ns_a"])
  wipe(["ns_a"])
  expect(isCached(fp, ["ns_a"])).toBe(false)
})
