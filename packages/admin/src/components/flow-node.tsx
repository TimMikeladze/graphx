import { memo, useContext } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { NODE_HEIGHT, NODE_WIDTH, type FlowNodeData, type GraphFlowNode } from "@/lib/flow-adapter"
import { FlowLabelSourceContext } from "@/lib/flow-label-source"
import type { LabelSource } from "@/lib/graph-style"
import { cn } from "@/lib/utils"

/**
 * Handles anchor the edges, and are also what an edge is drawn from — big enough to grab, faint
 * enough not to read as content.
 */
const HANDLE_STYLE = { width: 8, height: 8, border: "none", background: "currentColor", opacity: 0.5 }

function captionOf(data: FlowNodeData, source: LabelSource): string {
  switch (source) {
    case "off":
      return ""
    case "type":
      return data.type
    case "id":
      return data.labelId
    case "both":
      return data.labelBoth
    default:
      return data.label
  }
}

/** One graph node as a card: type dot + type name, the caption, and its degree within the slice. */
export const FlowNode = memo(function FlowNode({ data, selected }: NodeProps<GraphFlowNode>) {
  const source = useContext(FlowLabelSourceContext)
  const caption = captionOf(data, source)

  return (
    <div
      className={cn(
        "flex flex-col justify-center gap-0.5 rounded-lg border bg-card px-2.5 text-card-foreground shadow-sm transition-shadow",
        selected ? "border-primary/60 ring-2 ring-primary/50" : "hover:shadow-md",
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />

      <div className="flex items-center gap-1.5 overflow-hidden">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: data.color }}
        />
        <span className="truncate text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
          {data.type}
        </span>
        {data.degree > 0 && (
          <span className="ml-auto shrink-0 text-[0.625rem] tabular-nums text-muted-foreground/70">
            {data.degree}
          </span>
        )}
      </div>

      {caption && <div className="truncate text-xs font-medium">{caption}</div>}

      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
    </div>
  )
})
