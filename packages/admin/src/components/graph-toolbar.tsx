import { HugeiconsIcon } from "@hugeicons/react"
import {
  PauseIcon,
  PlayIcon,
  ShareKnowledgeIcon,
  SquareArrowExpand01Icon,
  Target02Icon,
  TextFontIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { IconSvgElement } from "@hugeicons/react"

function ToolButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: IconSvgElement
  label: string
  onClick: () => void
  /** Renders the button as a pressed toggle (and exposes it as one to assistive tech). */
  active?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(active && "bg-accent text-accent-foreground")}
        >
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
  nodeLabels,
  edgeLabels,
  onFit,
  onZoomIn,
  onZoomOut,
  onToggleNodeLabels,
  onToggleEdgeLabels,
  onTogglePause,
  onToggleFullscreen,
}: {
  paused: boolean
  nodeLabels: boolean
  edgeLabels: boolean
  onFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onToggleNodeLabels: () => void
  onToggleEdgeLabels: () => void
  onTogglePause: () => void
  onToggleFullscreen: () => void
}) {
  return (
    <div className="hud absolute top-3 right-3 flex flex-col gap-0.5 p-1">
      <ToolButton icon={Target02Icon} label="Fit to view" onClick={onFit} />
      <ToolButton icon={ZoomInAreaIcon} label="Zoom in" onClick={onZoomIn} />
      <ToolButton icon={ZoomOutAreaIcon} label="Zoom out" onClick={onZoomOut} />
      <Separator className="my-0.5" />
      <ToolButton
        icon={TextFontIcon}
        label={nodeLabels ? "Hide node labels" : "Show node labels"}
        active={nodeLabels}
        onClick={onToggleNodeLabels}
      />
      <ToolButton
        icon={ShareKnowledgeIcon}
        label={edgeLabels ? "Hide edge labels" : "Show edge labels"}
        active={edgeLabels}
        onClick={onToggleEdgeLabels}
      />
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
