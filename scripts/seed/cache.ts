/**
 * Rebuild-or-reuse for the demo databases. Generating and loading tens of thousands of nodes
 * takes seconds, which is fine once and tedious on every `bun run dev:admin` — so the seed
 * fingerprints what it built and skips the work when nothing that shapes the data has changed.
 *
 * libSQL only, like the dev server itself: staleness is decided by the presence of the
 * `<namespace>.db` files in the working directory.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"

export const CACHE_FILE = ".seed-cache.json"

/** Everything that changes the generated data. Any difference invalidates every database. */
export interface CacheKey {
  /** `DEMO_SCHEMA_VERSION` — bumped by hand when the schema or generator output changes. */
  schemaVersion: number
  seed: number
  /**
   * Embedding width. Must be part of the key: the `emb` column's width is baked at first init
   * and immutable, so reusing a database built at another width fails on start rather than
   * degrading quietly.
   */
  dim: number
  /** Cap on embedded nodes per project — it decides which rows carry a vector. */
  embedded: number
  fixtures: Array<{ namespace: string; nodes: number }>
}

interface CacheFile {
  fingerprint: string
  namespaces: string[]
}

export function fingerprint(key: CacheKey): string {
  return createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 16)
}

/** The three files libSQL keeps per database. */
function filesFor(namespace: string): string[] {
  return ["", "-wal", "-shm"].map((suffix) => `${namespace}.db${suffix}`)
}

/**
 * True when a previous run built exactly this data and its databases are all still on disk.
 * A missing or unparseable cache file, a changed fingerprint, or one deleted database all
 * mean rebuild — there is no partial reuse.
 */
export function isCached(fp: string, namespaces: string[]): boolean {
  if (!existsSync(CACHE_FILE)) return false
  let parsed: CacheFile
  try {
    parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CacheFile
  } catch {
    return false
  }
  if (parsed.fingerprint !== fp) return false
  if (parsed.namespaces.length !== namespaces.length) return false
  if (!namespaces.every((ns) => parsed.namespaces.includes(ns))) return false
  return namespaces.every((ns) => existsSync(`${ns}.db`))
}

/** Remove the databases (and the cache file) so the next build starts from nothing. */
export function wipe(namespaces: string[]): void {
  for (const ns of namespaces) {
    for (const file of filesFor(ns)) rmSync(file, { force: true })
  }
  rmSync(CACHE_FILE, { force: true })
}

export function writeCache(fp: string, namespaces: string[]): void {
  const contents: CacheFile = { fingerprint: fp, namespaces }
  writeFileSync(CACHE_FILE, `${JSON.stringify(contents, null, 2)}\n`)
}
