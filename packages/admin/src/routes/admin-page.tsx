import { useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  AddMembershipDialog,
  CreateApiKeyDialog,
  CreateProjectDialog,
  CreateTenantDialog,
  CreateUserDialog,
} from "@/components/admin/admin-dialogs"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { useProjects, useTenants, useUsers } from "@/hooks/use-graph"

function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="flex gap-2">{children}</div>
    </div>
  )
}

/** Control-plane management: tenants, projects, users, memberships, API keys. */
export function AdminPage() {
  const tenants = useTenants()
  const users = useUsers()
  const [selectedTenant, setSelectedTenant] = useState<string | undefined>()
  const projects = useProjects(selectedTenant)

  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Administration</h1>
        <Link to="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Explorer
        </Link>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <SectionHeader title="Tenants">
          <CreateTenantDialog />
        </SectionHeader>
        {tenants.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        <ul className="flex flex-col gap-1">
          {tenants.data?.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setSelectedTenant(t.id)}
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-accent ${
                  selectedTenant === t.id ? "bg-accent" : ""
                }`}
              >
                <span>{t.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{t.id}</span>
              </button>
            </li>
          ))}
          {tenants.data?.length === 0 && (
            <li className="text-sm text-muted-foreground">No tenants yet.</li>
          )}
        </ul>
      </Card>

      {selectedTenant && (
        <Card className="flex flex-col gap-3 p-4">
          <SectionHeader
            title={`Projects · ${tenants.data?.find((t) => t.id === selectedTenant)?.name ?? ""}`}
          >
            <CreateProjectDialog tenantId={selectedTenant} />
          </SectionHeader>
          {projects.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          <ul className="flex flex-col gap-1">
            {projects.data?.map((p) => (
              <li key={p.id} className="flex items-center justify-between px-2 py-1 text-sm">
                <Link
                  to="/t/$tenant/p/$project"
                  params={{ tenant: selectedTenant, project: p.id }}
                  search={{ expand: [] }}
                  className="underline-offset-4 hover:underline"
                >
                  {p.name}
                </Link>
                <span className="font-mono text-xs text-muted-foreground">{p.dbNamespace}</span>
              </li>
            ))}
            {projects.data?.length === 0 && (
              <li className="text-sm text-muted-foreground">No projects yet.</li>
            )}
          </ul>
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-4">
        <SectionHeader title="Users">
          <CreateUserDialog />
          <AddMembershipDialog />
        </SectionHeader>
        {users.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        <ul className="flex flex-col gap-1">
          {users.data?.map((u) => (
            <li key={u.id} className="flex items-center justify-between px-2 py-1 text-sm">
              <span>{u.email}</span>
              <span className="font-mono text-xs text-muted-foreground">{u.id}</span>
            </li>
          ))}
          {users.data?.length === 0 && <li className="text-sm text-muted-foreground">No users yet.</li>}
        </ul>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <SectionHeader title="API keys">
          <CreateApiKeyDialog />
        </SectionHeader>
        <p className="text-sm text-muted-foreground">
          Keys are stored hashed; the plaintext is shown once at creation.
        </p>
      </Card>

      <Badge variant="outline" className="self-start">
        operator
      </Badge>
    </div>
  )
}
