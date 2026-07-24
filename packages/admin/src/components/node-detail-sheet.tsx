import { NodeDetail } from "@/components/node-detail"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"

/**
 * Mobile detail: the same {@link NodeDetail} body inside a slide-over Sheet. On desktop the
 * explorer docks that body as a resizable pane instead (see `explorer-page.tsx`).
 */
export function NodeDetailSheet({
  tenant,
  project,
  nodeId,
  onClose,
  onSelect,
}: {
  tenant: string
  project: string
  nodeId?: string
  onClose: () => void
  onSelect: (id: string) => void
}) {
  return (
    <Sheet
      open={Boolean(nodeId)}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <SheetContent className="flex w-[90vw] max-w-[440px] flex-col gap-0 p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Node detail</SheetTitle>
        </SheetHeader>
        {nodeId && (
          <NodeDetail tenant={tenant} project={project} nodeId={nodeId} onSelect={onSelect} />
        )}
      </SheetContent>
    </Sheet>
  )
}
