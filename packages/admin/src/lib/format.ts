/** Presentation helpers for graph ids + timestamps (kept pure + trivially testable). */

/** libSQL FOREVER sentinel — an open (live) version's `valid_to`. */
export const FOREVER = 8640000000000000

/**
 * Abbreviate a ULID/opaque id for dense display: keep the leading chars (timestamp prefix) and
 * the trailing chars (the distinguishing random tail), eliding the middle. Short ids pass through.
 */
export function shortId(id: string, head = 6, tail = 4): string {
  if (id.length <= head + tail + 1) return id
  return `${id.slice(0, head)}…${id.slice(-tail)}`
}

/** Format an as-of/version epoch; the FOREVER sentinel reads as `live`. */
export function fmtTime(epoch: number): string {
  return epoch >= FOREVER ? "live" : new Date(epoch).toLocaleString()
}
