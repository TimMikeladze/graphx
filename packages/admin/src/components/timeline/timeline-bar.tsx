import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { NextIcon, PreviousIcon } from "@hugeicons/core-free-icons"
import { TimelineTrack } from "@/components/timeline/timeline-track"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { useTimeline } from "@/hooks/use-graph"
import { fmtTime } from "@/lib/format"
import { PRESETS, presetTime, stepTick } from "@/lib/timeline"

/**
 * The docked time-travel control. It owns no time state — `asOf` lives in the URL, so a
 * time-travelled view is shareable and the Back button walks the scrub history.
 */
export function TimelineBar({
  tenant,
  project,
  asOf,
  onChange,
}: {
  tenant: string
  project: string
  /** The current as-of instant; `undefined` ⇒ live. */
  asOf?: number
  onChange: (asOf: number | undefined) => void
}) {
  const timeline = useTimeline(tenant, project)
  const isMobile = useIsMobile()
  const [preview, setPreview] = useState<number | undefined>(undefined)

  const data = timeline.data
  const empty = !data || data.min === null || data.max === null
  const from = data?.from ?? 0
  const to = data?.to ?? 0
  const ticks = data?.ticks ?? []
  const current = asOf ?? to
  const shown = preview ?? asOf

  const go = (t: number | undefined) => onChange(t)
  const step = (dir: -1 | 1) => {
    const next = stepTick(ticks, current, dir)
    if (next !== undefined) go(next)
  }

  // A 32px scrub track on a phone is not usable and the canvas needs the height more, so the bar
  // collapses to what it is showing plus the way back to live.
  if (isMobile) {
    return (
      <div className="flex items-center gap-2 border-t bg-background px-3 py-1.5 text-xs">
        <span className="tabular-nums text-muted-foreground">
          {empty ? "No history" : asOf === undefined ? "Now" : fmtTime(asOf)}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={asOf === undefined}
          onClick={() => go(undefined)}
        >
          Now
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 border-t bg-background px-3 py-1.5">
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous change"
          disabled={empty || stepTick(ticks, current, -1) === undefined}
          onClick={() => step(-1)}
        >
          <HugeiconsIcon icon={PreviousIcon} strokeWidth={2} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next change"
          disabled={empty || stepTick(ticks, current, 1) === undefined}
          onClick={() => step(1)}
        >
          <HugeiconsIcon icon={NextIcon} strokeWidth={2} />
        </Button>
      </div>

      <TimelineTrack
        buckets={data?.buckets ?? []}
        ticks={ticks}
        from={from}
        to={to}
        value={asOf}
        onChange={go}
        onPreview={setPreview}
        disabled={empty}
      />

      <span className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {empty ? "No history" : shown === undefined ? "Now" : fmtTime(shown)}
      </span>

      <div className="flex shrink-0 items-center gap-0.5">
        {PRESETS.map((p) => (
          <Button
            key={p}
            variant="ghost"
            size="xs"
            disabled={empty}
            onClick={() => go(presetTime(p, Date.now()))}
          >
            {p}
          </Button>
        ))}
        <Button variant="ghost" size="xs" disabled={asOf === undefined} onClick={() => go(undefined)}>
          Now
        </Button>
      </div>
    </div>
  )
}
