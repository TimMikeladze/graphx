import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useHistory, useNeighbors, useNode } from "@/hooks/use-graph"

/** libSQL FOREVER sentinel — an open (live) version's `valid_to`. */
const FOREVER = 8640000000000000

function fmt(epoch: number): string {
  return epoch >= FOREVER ? "live" : new Date(epoch).toLocaleString()
}

/** Right slide-over inspector for the selected node: Properties · Neighbors · History. */
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
  const open = Boolean(nodeId)
  const node = useNode(tenant, project, nodeId)
  const neighbors = useNeighbors(tenant, project, nodeId)
  const history = useHistory(tenant, project, nodeId)

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <SheetContent className="flex w-[480px] flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle className="truncate font-mono text-sm">{nodeId}</SheetTitle>
          <SheetDescription>
            {node.data ? <Badge variant="secondary">{node.data.type}</Badge> : "Loading…"}
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="data" className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <TabsList className="w-full">
            <TabsTrigger value="data">Properties</TabsTrigger>
            <TabsTrigger value="neighbors">Neighbors</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="data" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <pre className="rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                {node.data ? JSON.stringify(node.data.data, null, 2) : "…"}
              </pre>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="neighbors" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              {neighbors.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              {neighbors.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">No neighbors.</p>
              )}
              <ul className="flex flex-col gap-1">
                {neighbors.data?.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(n.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
                    >
                      <Badge variant="secondary">{n.type}</Badge>
                      <span className="truncate font-mono text-xs">{n.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="history" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              {history.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              <ol className="flex flex-col gap-2">
                {history.data?.map((v) => (
                  <li key={v.ver} className="rounded-md border p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">v{v.ver}</Badge>
                      <span className="text-muted-foreground">
                        {fmt(v.valid_from)} → {fmt(v.valid_to)}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-muted-foreground">{v.type}</div>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
