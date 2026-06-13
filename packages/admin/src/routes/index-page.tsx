import { Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useProjects, useTenants } from "@/hooks/use-graph"
import { requestToken } from "@/lib/api"
import { useState } from "react"

/**
 * Landing page: choose a tenant, then a project, to enter the explorer. A lightweight picker —
 * the real scoping selectors live in the explorer sidebar.
 */
export function IndexPage() {
  const tenants = useTenants()
  const [tenantId, setTenantId] = useState<string | undefined>(undefined)
  const projects = useProjects(tenantId)

  return (
    <div className="mx-auto flex min-h-svh max-w-2xl flex-col gap-6 p-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">graphx admin</h1>
          <p className="text-sm text-muted-foreground">Pick a tenant and project to explore.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => requestToken()}>
          Set token
        </Button>
      </div>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-medium">Tenants</h2>
        {tenants.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {tenants.isError && <p className="text-sm text-destructive">Failed to load tenants.</p>}
        <ul className="flex flex-col gap-1">
          {tenants.data?.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setTenantId(t.id)}
                className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-accent ${
                  tenantId === t.id ? "bg-accent" : ""
                }`}
              >
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {tenantId && (
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-medium">Projects</h2>
          {projects.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          <ul className="flex flex-col gap-1">
            {projects.data?.map((p) => (
              <li key={p.id}>
                <Link
                  to="/t/$tenant/p/$project"
                  params={{ tenant: tenantId, project: p.id }}
                  search={{ expand: [] }}
                  className="block rounded px-2 py-1 text-sm hover:bg-accent"
                >
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Link to="/admin" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        Manage tenants, projects & users →
      </Link>
    </div>
  )
}
