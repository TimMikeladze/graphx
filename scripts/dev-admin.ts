/**
 * Run the admin stack concurrently: the seeded dev API (scripts/admin-api.ts) + the Vite UI
 * dev server (packages/admin). One Ctrl-C tears BOTH down. `bun run dev:admin` from the repo root.
 *
 * Teardown is robust: vite is spawned as a single process (its binary directly, NOT via a
 * `bun run dev` wrapper that would orphan it), and every shutdown signal SIGTERMs both children
 * then SIGKILLs any survivor — so no server is left holding a port after Ctrl-C.
 */
import process from "node:process"

const root = process.cwd()
const procs: Bun.Subprocess[] = []

function run(cmd: string[], cwd: string): Bun.Subprocess {
  const p = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit", env: process.env })
  procs.push(p)
  return p
}

let shuttingDown = false
function shutdown(code = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const p of procs) {
    try {
      p.kill("SIGTERM")
    } catch {
      // already gone
    }
  }
  // Escalate: SIGKILL anything that ignored SIGTERM (e.g. a dev server mid-startup).
  setTimeout(() => {
    for (const p of procs) {
      try {
        p.kill("SIGKILL")
      } catch {
        // already gone
      }
    }
    process.exit(code)
  }, 1200)
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => shutdown(0))
}

const api = run(["bun", "scripts/admin-api.ts"], root)
// Spawn vite's binary directly (not `bun run dev`) so killing this pid frees port 5173.
const ui = run([`${root}/node_modules/.bin/vite`], `${root}/packages/admin`)

// If either process exits on its own, bring the whole stack down.
void Promise.race([api.exited, ui.exited]).then(() => shutdown(0))
