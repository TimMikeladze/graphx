/**
 * Zoom arithmetic for the timeline bar's scrub window — pure and DOM-free, mirroring
 * `lib/timeline.ts`.
 */

/** A scrub window. `undefined` bounds mean "the full extent". */
export interface TimeWindow {
  from?: number
  to?: number
}

/**
 * Narrow or widen the window by `factor` around `centre`, clamped to the extent. Zooming out past
 * the extent returns `{}` — the full range — so there is exactly one representation of "all of it"
 * and the Full range button and a zoom-out converge on the same state.
 */
export function zoomWindow(
  win: TimeWindow,
  centre: number,
  factor: number,
  extentMin: number,
  extentMax: number,
): TimeWindow {
  const extentSpan = extentMax - extentMin
  // Nothing to zoom into — the extent itself has no width, so any window over it is degenerate.
  if (extentSpan <= 0) return win

  const currFrom = win.from ?? extentMin
  const currTo = win.to ?? extentMax
  const newSpan = (currTo - currFrom) * factor

  // A span at or past the full extent has nowhere left to grow — collapse to the one canonical
  // "full range" representation rather than a window that merely happens to match its bounds.
  if (newSpan >= extentSpan) return {}

  let newFrom = centre - newSpan / 2
  let newTo = centre + newSpan / 2

  // Clamp by shifting the window back into bounds, not by truncating an out-of-range edge — a
  // truncation would shrink the span the caller just asked for.
  if (newFrom < extentMin) {
    newFrom = extentMin
    newTo = extentMin + newSpan
  }
  if (newTo > extentMax) {
    newTo = extentMax
    newFrom = extentMax - newSpan
  }

  // Epoch milliseconds are integers, and these bounds travel to the server as query parameters —
  // a fractional `from` would round-trip differently than it was computed.
  //
  // Round OUTWARD, never to nearest. Rounding to nearest shaves up to half a millisecond off each
  // edge, and that loss compounds as you zoom: widening a twice-narrowed window by the same factor
  // lands a few milliseconds short of the extent, so it never satisfies the full-range test above
  // and the Full range affordance sticks around forever. Widening outward can only ever reach or
  // overshoot the extent, which is exactly what that test needs.
  return { from: Math.floor(newFrom), to: Math.ceil(newTo) }
}
