import { useCallback, useEffect, useRef, useState } from "react"
import { nearestTick, stepTick, timeToX, xToTime } from "@/lib/timeline"
import { cn } from "@/lib/utils"

/**
 * The scrub track: a change-density histogram with a draggable handle over it.
 *
 * Dragging is continuous — the handle follows the pointer and `onPreview` reports where it is —
 * but the committed value snaps to the nearest real change point on release, so you never land in
 * a gap where the graph did not change.
 */
export function TimelineTrack({
  buckets,
  ticks,
  from,
  to,
  value,
  onChange,
  onPreview,
  disabled,
}: {
  buckets: number[]
  ticks: number[]
  from: number
  to: number
  /** The committed time, or `undefined` when live (the handle parks at the right edge). */
  value?: number
  onChange: (t: number) => void
  /** Fires continuously while dragging so the readout can track the pointer. */
  onPreview?: (t: number | undefined) => void
  disabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState<number | undefined>(undefined)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return from
      return xToTime(clientX - rect.left, from, to, rect.width)
    },
    [from, to],
  )

  // Pointer capture keeps the drag alive when the pointer leaves the track, which it will —
  // the track is 32px tall and people drag horizontally past it.
  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = timeAt(e.clientX)
    setDragging(t)
    onPreview?.(t)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging === undefined) return
    const t = timeAt(e.clientX)
    setDragging(t)
    onPreview?.(t)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragging === undefined) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    const snapped = nearestTick(ticks, dragging)
    setDragging(undefined)
    onPreview?.(undefined)
    if (snapped !== undefined) onChange(snapped)
  }

  // Keyboard steps are already tick-aligned, so they commit straight through — no re-snap.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    const current = value ?? to
    let next: number | undefined
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = stepTick(ticks, current, -1)
        break
      case "ArrowRight":
      case "ArrowUp":
        next = stepTick(ticks, current, 1)
        break
      case "Home":
        // Commit the true extent start, not ticks[0] — when the tick list is truncated to the
        // most recent window, ticks[0] is only the start of that window, not of history.
        next = from
        break
      case "End":
        // Same reasoning: `to` is the true extent end, not the possibly-truncated ticks[-1].
        next = to
        break
      default:
        return
    }
    e.preventDefault()
    if (next !== undefined) onChange(next)
  }

  const peak = Math.max(1, ...buckets)
  const handleAt = dragging ?? value
  const handleX = handleAt === undefined ? width : timeToX(handleAt, from, to, width)

  return (
    <div
      ref={ref}
      className={cn(
        "relative h-8 flex-1 touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        disabled ? "cursor-default opacity-50" : "cursor-pointer",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      role="slider"
      aria-label="As-of time"
      aria-valuemin={from}
      aria-valuemax={to}
      aria-valuenow={handleAt ?? to}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
    >
      {/* density */}
      <div className="absolute inset-x-0 bottom-2 flex h-6 items-end gap-px">
        {buckets.map((n, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-[1px] bg-muted-foreground/25"
            style={{ height: `${(n / peak) * 100}%` }}
          />
        ))}
      </div>
      {/* baseline */}
      <div className="absolute inset-x-0 bottom-2 h-px bg-border" />
      {/* handle */}
      {width > 0 && (
        <div
          className="pointer-events-none absolute bottom-0 w-px bg-primary"
          style={{ left: handleX, height: "100%" }}
        >
          <span className="absolute -top-0.5 -left-[3px] size-[7px] rounded-full bg-primary ring-2 ring-background" />
        </div>
      )}
    </div>
  )
}
