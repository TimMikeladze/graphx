import { getRouteApi } from "@tanstack/react-router"

/** Typed access to the explorer route's params + search (registered in router.tsx). */
export const explorerRoute = getRouteApi("/t/$tenant/p/$project")

/** The master-detail explorer (sidebar | node list | canvas). Filled in by later tasks. */
export function ExplorerPage() {
  const { tenant, project } = explorerRoute.useParams()
  return (
    <div className="flex min-h-svh items-center justify-center p-8 text-sm text-muted-foreground">
      Explorer for {tenant} / {project} — coming together.
    </div>
  )
}
