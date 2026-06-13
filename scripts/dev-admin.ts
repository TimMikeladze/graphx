/**
 * Run the admin stack concurrently: the seeded dev API (scripts/admin-api.ts) + the Vite UI
 * dev server (packages/admin). One Ctrl-C tears both down. `bun run dev:admin` from the repo root.
 */
import process from "node:process"

const root = process.cwd()
const procs: Bun.Subprocess[] = []

function run(cmd: string[], cwd: string): Bun.Subprocess {
  const p = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit", env: process.env })
  procs.push(p)
  return p
}

function killAll(): void {
  for (const p of procs) {
    try {
      p.kill()
    } catch {
      // already gone
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killAll()
    process.exit(0)
  })
}

const api = run(["bun", "scripts/admin-api.ts"], root)
const ui = run(["bun", "run", "dev"], `${root}/packages/admin`)

// If either process exits, bring the whole stack down.
await Promise.race([api.exited, ui.exited])
killAll()
process.exit(0)
