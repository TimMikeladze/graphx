import { Link } from "@tanstack/react-router"

/** Control-plane management (tenants/projects/users/memberships/keys). Filled in by a later task. */
export function AdminPage() {
  return (
    <div className="mx-auto flex min-h-svh max-w-3xl flex-col gap-4 p-8">
      <Link to="/" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        ← Back
      </Link>
      <h1 className="text-xl font-semibold">Administration</h1>
      <p className="text-sm text-muted-foreground">Registry management — coming together.</p>
    </div>
  )
}
