import { Badge } from "@/components/ui/badge"
import { colorForType } from "@/lib/cosmograph-adapter"
import { cn } from "@/lib/utils"

/**
 * A filled dot in a node type's color. This is the single visual carrier of "type identity" —
 * the same {@link colorForType} palette that colors the graph points, so the list, detail and
 * legend all read as one system.
 */
export function TypeDot({ type, className }: { type: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: colorForType(type) }}
    />
  )
}

/** A node-type chip: colored dot + type label. Used wherever a node's type is surfaced. */
export function NodeTypeBadge({ type, className }: { type: string; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("gap-1.5 font-normal", className)}>
      <TypeDot type={type} />
      {type}
    </Badge>
  )
}
