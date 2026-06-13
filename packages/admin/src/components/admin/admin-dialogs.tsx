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
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  useAddMembership,
  useCreateApiKey,
  useCreateProject,
  useCreateTenant,
  useCreateUser,
} from "@/hooks/use-admin"
import { useTenants, useUsers } from "@/hooks/use-graph"
import type { Role } from "@/lib/types"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Generate a fresh, editable sqld namespace suggestion. */
function suggestNamespace(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2)
  return `ns_${rand}`
}

export function CreateTenantDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const m = useCreateTenant()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New tenant</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New tenant</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="tenant-name">Name</Label>
          <Input id="tenant-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || m.isPending}
            onClick={() =>
              m.mutate(name.trim(), {
                onSuccess: () => {
                  toast.success("Tenant created")
                  setOpen(false)
                  setName("")
                },
                onError: (e) => toast.error(errMsg(e)),
              })
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CreateProjectDialog({ tenantId }: { tenantId: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [ns, setNs] = useState(suggestNamespace())
  const m = useCreateProject(tenantId)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setNs(suggestNamespace())
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Each project is its own libSQL namespace.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-ns">DB namespace</Label>
            <Input
              id="project-ns"
              value={ns}
              onChange={(e) => setNs(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || !ns.trim() || m.isPending}
            onClick={() =>
              m.mutate(
                { name: name.trim(), dbNamespace: ns.trim() },
                {
                  onSuccess: () => {
                    toast.success("Project created")
                    setOpen(false)
                    setName("")
                  },
                  onError: (e) => toast.error(errMsg(e)),
                },
              )
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CreateUserDialog() {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const m = useCreateUser()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New user</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New user</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="user-email">Email</Label>
          <Input
            id="user-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={!email.trim() || m.isPending}
            onClick={() =>
              m.mutate(email.trim(), {
                onSuccess: () => {
                  toast.success("User created")
                  setOpen(false)
                  setEmail("")
                },
                onError: (e) => toast.error(errMsg(e)),
              })
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AddMembershipDialog() {
  const [open, setOpen] = useState(false)
  const [userId, setUserId] = useState<string | undefined>()
  const [tenantId, setTenantId] = useState<string | undefined>()
  const [role, setRole] = useState<Role>("viewer")
  const users = useUsers()
  const tenants = useTenants()
  const m = useAddMembership()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Add membership
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add membership</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label>User</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger>
                <SelectValue placeholder="Select user" />
              </SelectTrigger>
              <SelectContent>
                {users.data?.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Tenant</Label>
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger>
                <SelectValue placeholder="Select tenant" />
              </SelectTrigger>
              <SelectContent>
                {tenants.data?.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="editor">editor</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={!userId || !tenantId || m.isPending}
            onClick={() =>
              m.mutate(
                { userId: userId as string, tenantId: tenantId as string, role },
                {
                  onSuccess: () => {
                    toast.success("Membership added")
                    setOpen(false)
                  },
                  onError: (e) => toast.error(errMsg(e)),
                },
              )
            }
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false)
  const [tenantId, setTenantId] = useState<string | undefined>()
  const [scopes, setScopes] = useState("read")
  const [issued, setIssued] = useState<string | null>(null)
  const tenants = useTenants()
  const m = useCreateApiKey()
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setIssued(null)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Mint API key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mint API key</DialogTitle>
          <DialogDescription>The key is shown once — copy it now.</DialogDescription>
        </DialogHeader>
        {issued ? (
          <div className="grid gap-2">
            <Label>Your key</Label>
            <Input readOnly value={issued} className="font-mono text-xs" />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                navigator.clipboard?.writeText(issued)
                toast.success("Copied")
              }}
            >
              Copy
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label>Tenant</Label>
              <Select value={tenantId} onValueChange={setTenantId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select tenant" />
                </SelectTrigger>
                <SelectContent>
                  {tenants.data?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="scopes">Scopes (comma-separated)</Label>
              <Input id="scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} />
            </div>
          </div>
        )}
        {!issued && (
          <DialogFooter>
            <Button
              disabled={!tenantId || m.isPending}
              onClick={() =>
                m.mutate(
                  {
                    tenantId: tenantId as string,
                    scopes: scopes
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                  {
                    onSuccess: (r) => setIssued(r.key),
                    onError: (e) => toast.error(errMsg(e)),
                  },
                )
              }
            >
              Mint
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
