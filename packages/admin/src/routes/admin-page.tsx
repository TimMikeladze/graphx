import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  FolderLibraryIcon,
  InboxIcon,
  Key01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons"
import {
  AddMembershipDialog,
  CreateApiKeyDialog,
  CreateProjectDialog,
  CreateTenantDialog,
  CreateUserDialog,
} from "@/components/admin/admin-dialogs"
import { CopyButton } from "@/components/copy-button"
import { EmptyState } from "@/components/empty-state"
import { ThemeToggle } from "@/components/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useProjects, useTenants, useUsers } from "@/hooks/use-graph"
import { cn } from "@/lib/utils"

function LoadingRows() {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-full" />
      ))}
    </div>
  )
}

/** A name + monospace id row with a copy affordance. */
function IdRow({
  name,
  id,
  selected,
  onClick,
}: {
  name: React.ReactNode
  id: string
  selected?: boolean
  onClick?: () => void
}) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm",
        onClick && "cursor-pointer hover:bg-accent/60",
        selected && "bg-accent",
      )}
      onClick={onClick}
    >
      <span className="truncate">{name}</span>
      <div className="flex items-center gap-1">
        <span className="font-mono text-xs text-muted-foreground">{id}</span>
        <CopyButton value={id} label="Copy id" className="opacity-0 group-hover:opacity-100" />
      </div>
    </div>
  )
}

/** Control-plane management: tenants, projects, users, memberships, API keys. */
export function AdminPage() {
  const tenants = useTenants()
  const users = useUsers()
  const [selectedTenant, setSelectedTenant] = useState<string | undefined>()
  const projects = useProjects(selectedTenant)
  const selectedTenantName = tenants.data?.find((t) => t.id === selectedTenant)?.name

  return (
    <div className="mx-auto flex min-h-svh max-w-4xl flex-col gap-6 p-6 sm:p-8">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} className="size-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Administration</h1>
            <p className="text-xs text-muted-foreground">Tenants, projects, users & API keys</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">operator</Badge>
          <ThemeToggle />
          <Button asChild variant="outline" size="sm">
            <Link to="/">
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
              Explorer
            </Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} className="size-4" />
            Tenants
          </CardTitle>
          <CardDescription>Select a tenant to manage its projects.</CardDescription>
          <CardAction>
            <CreateTenantDialog />
          </CardAction>
        </CardHeader>
        <CardContent>
          {tenants.isLoading ? (
            <LoadingRows />
          ) : tenants.data && tenants.data.length > 0 ? (
            <div className="flex flex-col">
              {tenants.data.map((t) => (
                <IdRow
                  key={t.id}
                  name={t.name}
                  id={t.id}
                  selected={selectedTenant === t.id}
                  onClick={() => setSelectedTenant(t.id)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={UserGroupIcon} title="No tenants yet" hint="Create the first one." />
          )}
        </CardContent>
      </Card>

      {selectedTenant && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon icon={FolderLibraryIcon} strokeWidth={2} className="size-4" />
              Projects
              {selectedTenantName && (
                <span className="font-normal text-muted-foreground">· {selectedTenantName}</span>
              )}
            </CardTitle>
            <CardDescription>Each project is its own libSQL namespace.</CardDescription>
            <CardAction>
              <CreateProjectDialog tenantId={selectedTenant} />
            </CardAction>
          </CardHeader>
          <CardContent>
            {projects.isLoading ? (
              <LoadingRows />
            ) : projects.data && projects.data.length > 0 ? (
              <div className="flex flex-col">
                {projects.data.map((p) => (
                  <div
                    key={p.id}
                    className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                  >
                    <Link
                      to="/t/$tenant/p/$project"
                      params={{ tenant: selectedTenant, project: p.id }}
                      search={{ expand: [] }}
                      className="truncate font-medium underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs text-muted-foreground">{p.dbNamespace}</span>
                      <CopyButton
                        value={p.dbNamespace}
                        label="Copy namespace"
                        className="opacity-0 group-hover:opacity-100"
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon={FolderLibraryIcon} title="No projects yet" />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} className="size-4" />
            Users
          </CardTitle>
          <CardDescription>Users and their tenant memberships.</CardDescription>
          <CardAction>
            <div className="flex gap-2">
              <CreateUserDialog />
              <AddMembershipDialog />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {users.isLoading ? (
            <LoadingRows />
          ) : users.data && users.data.length > 0 ? (
            <div className="flex flex-col">
              {users.data.map((u) => (
                <IdRow key={u.id} name={u.email} id={u.id} />
              ))}
            </div>
          ) : (
            <EmptyState icon={InboxIcon} title="No users yet" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} className="size-4" />
            API keys
          </CardTitle>
          <CardDescription>Keys are stored hashed; the plaintext is shown once at creation.</CardDescription>
          <CardAction>
            <CreateApiKeyDialog />
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  )
}
