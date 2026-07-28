import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useDeleteEdge } from "@/hooks/use-graph"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The edge a confirmation is about. */
export interface PendingEdgeDeletion {
  id: string
  source: string
  target: string
  rel: string
}

/**
 * Confirm removing an edge. Like a node retraction this closes the live version only — an as-of
 * query from before now still traverses it.
 */
export function DeleteEdgeDialog({
  tenant,
  project,
  edge,
  onOpenChange,
}: {
  tenant: string
  project: string
  /** The edge being removed; absent ⇒ closed. */
  edge?: PendingEdgeDeletion
  onOpenChange: (open: boolean) => void
}) {
  const remove = useDeleteEdge(tenant, project)
  const [error, setError] = useState<string>()

  function confirm() {
    if (!edge || remove.isPending) return
    remove.mutate(edge, {
      onSuccess: () => {
        toast.success("Edge removed")
        onOpenChange(false)
      },
      onError: (e) => setError(errMsg(e)),
    })
  }

  return (
    <Dialog
      open={edge !== undefined}
      onOpenChange={(next) => {
        if (!next) setError(undefined)
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this edge?</DialogTitle>
          <DialogDescription>
            The <span className="font-mono text-foreground">{edge?.rel}</span> relation ends. Both
            nodes stay, and history keeps the edge as it was.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={remove.isPending}>
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
