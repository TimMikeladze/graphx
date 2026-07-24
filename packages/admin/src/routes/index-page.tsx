import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ChartRelationshipIcon,
  FolderLibraryIcon,
  Key01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import { EmptyState } from "@/components/empty-state"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjects, useTenants } from "@/hooks/use-graph"
import { requestToken } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * Landing page: choose a tenant, then a project, to enter the explorer. When there is exactly one
 * tenant with exactly one project, the picker is pointless — jump straight in (once).
 */
export function IndexPage() {
  const navigate = useNavigate()
  const tenants = useTenants()
  const soleTenant = tenants.data?.length === 1 ? tenants.data[0].id : undefined
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const tenantId = picked ?? soleTenant
  const projects = useProjects(tenantId)

  // Auto-enter once when the scope is unambiguous.
  const jumped = useRef(false)
  useEffect(() => {
    if (jumped.current) return
    if (soleTenant && picked === undefined && projects.data?.length === 1) {
      jumped.current = true
      navigate({
        to: "/t/$tenant/p/$project",
        params: { tenant: soleTenant, project: projects.data[0].id },
        search: { expand: [] },
      })
    }
  }, [soleTenant, picked, projects.data, navigate])

  return (
    <div className="mx-auto flex min-h-svh max-w-2xl flex-col gap-6 p-6 sm:p-8">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HugeiconsIcon icon={ChartRelationshipIcon} strokeWidth={2} className="size-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">graphx admin</h1>
            <p className="text-xs text-muted-foreground">Pick a tenant and project to explore.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="outline" size="sm" onClick={() => requestToken()}>
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
            Set token
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} className="size-4" />
            Tenants
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tenants.isLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : tenants.isError ? (
            <EmptyState
              title="Failed to load tenants"
              tone="destructive"
              hint="Set an operator token, then retry."
              action={
                <Button size="sm" variant="outline" onClick={() => requestToken()}>
                  Set token
                </Button>
              }
            />
          ) : tenants.data && tenants.data.length > 0 ? (
            <div className="flex flex-col">
              {tenants.data.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setPicked(t.id)}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60",
                    tenantId === t.id && "bg-accent",
                  )}
                >
                  <span>{t.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{t.id}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState icon={UserGroupIcon} title="No tenants" hint="Create one in Administration." />
          )}
        </CardContent>
      </Card>

      {tenantId && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} className="size-4" />
              Projects
            </CardTitle>
          </CardHeader>
          <CardContent>
            {projects.isLoading ? (
              <Skeleton className="h-8 w-full" />
            ) : projects.data && projects.data.length > 0 ? (
              <div className="flex flex-col">
                {projects.data.map((p) => (
                  <Link
                    key={p.id}
                    to="/t/$tenant/p/$project"
                    params={{ tenant: tenantId, project: p.id }}
                    search={{ expand: [] }}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{p.dbNamespace}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState icon={FolderLibraryIcon} title="No projects in this tenant" />
            )}
          </CardContent>
        </Card>
      )}

      <Link
        to="/admin"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        Manage tenants, projects & users →
      </Link>
    </div>
  )
}
