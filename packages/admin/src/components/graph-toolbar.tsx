import { HugeiconsIcon } from "@hugeicons/react"
import {
  PauseIcon,
  PlayIcon,
  SquareArrowExpand01Icon,
  Target02Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons"
import { GraphLabelsMenu } from "@/components/graph-labels-menu"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { LabelSettings } from "@/lib/cosmograph-adapter"
import type { IconSvgElement } from "@hugeicons/react"

function ToolButton({
  icon,
  label,
  onClick,
}: {
  icon: IconSvgElement
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={label}>
          <HugeiconsIcon icon={icon} strokeWidth={2} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}

/** Floating canvas controls: fit, zoom, labels, pause/resume simulation, fullscreen. */
export function GraphToolbar({
  paused,
  labels,
  onLabelsChange,
  onFit,
  onZoomIn,
  onZoomOut,
  onTogglePause,
  onToggleFullscreen,
}: {
  paused: boolean
  labels: LabelSettings
  onLabelsChange: (next: LabelSettings) => void
  onFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onTogglePause: () => void
  onToggleFullscreen: () => void
}) {
  return (
    <div className="hud absolute top-3 right-3 flex flex-col gap-0.5 p-1">
      <ToolButton icon={Target02Icon} label="Fit to view" onClick={onFit} />
      <ToolButton icon={ZoomInAreaIcon} label="Zoom in" onClick={onZoomIn} />
      <ToolButton icon={ZoomOutAreaIcon} label="Zoom out" onClick={onZoomOut} />
      <Separator className="my-0.5" />
      <GraphLabelsMenu settings={labels} onChange={onLabelsChange} />
      <Separator className="my-0.5" />
      <ToolButton
        icon={paused ? PlayIcon : PauseIcon}
        label={paused ? "Resume layout" : "Pause layout"}
        onClick={onTogglePause}
      />
      <ToolButton
        icon={SquareArrowExpand01Icon}
        label="Toggle fullscreen"
        onClick={onToggleFullscreen}
      />
    </div>
  )
}
