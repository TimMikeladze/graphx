/**
 * Dev API server for @graphx/admin — seeds an in-memory control plane + one demo project,
 * mounts the tenant-scoped graph routes (createApp) and the operator sub-app (createAdminApp),
 * and serves on :8787. Auth is a single dev bearer token (ADMIN_TOKEN, default "dev") that the
 * operator presents; the `authenticate` impl turns it into an operator principal so it can browse
 * any tenant. NOT for production — control plane is :memory:, the demo project DB is a local file.
 */
import { rmSync } from "node:fs"
import process from "node:process"
import { createClient } from "@libsql/client"
import { z } from "zod"
import {
  addMembership,
  createAdminApp,
  createApp,
  createProject,
  createTenant,
  createUser,
  defineGraphSchema,
  graphForProject,
  hashEmbed,
  initControl,
  type Principal,
} from "../packages/core/src/index.ts"

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev"
const PORT = Number(process.env.PORT ?? 8787)
const DEMO_NS = "dev_admin"

// Fresh demo data each start: drop the local project DB files (cwd = repo root).
for (const sfx of ["", "-wal", "-shm"]) rmSync(`${DEMO_NS}.db${sfx}`, { force: true })

const schema = defineGraphSchema({
  nodes: {
    person: z.object({ name: z.string() }),
    document: z.object({ title: z.string() }),
    org: z.object({ name: z.string() }),
  },
  edges: {
    knows: { from: "person", to: "person" },
    authored: { from: "person", to: "document" },
    works_at: { from: "person", to: "org" },
  },
})

function bearer(c: { req: { header: (n: string) => string | undefined } }): string | undefined {
  const h = c.req.header("authorization") ?? ""
  return h.startsWith("Bearer ") ? h.slice(7) : undefined
}

/** Tenant-scoped authn: the dev token ⇒ an operator principal scoped to the route tenant. */
function authenticate(c: {
  req: { header: (n: string) => string | undefined; param: (n: string) => string }
}): Principal {
  if (bearer(c) !== ADMIN_TOKEN) throw new Error("unauthorized")
  return { userId: "operator", tenantId: c.req.param("tenant"), operator: true }
}

/** Operator authn for /admin/*: same dev token. */
function adminAuthenticate(c: { req: { header: (n: string) => string | undefined } }): void {
  if (bearer(c) !== ADMIN_TOKEN) throw new Error("unauthorized")
}

const control = createClient({ url: ":memory:" })
await initControl(control)

const tenantId = await createTenant(control, { name: "Acme" })
const projectId = await createProject(control, { tenantId, name: "Demo", dbNamespace: DEMO_NS })
const ada = await createUser(control, { email: "ada@acme.test" })
await addMembership(control, { userId: ada, tenantId, role: "owner" })

// Dev embedder: deterministic, model-free, no API key or network. Lexical rather than semantic,
// so /retrieve and /hybrid return sensible neighbors for demo queries without any setup. `dim` is
// derived from it by createApp, and the demo DB is recreated on every start, so the vector column
// can never disagree with the embedder.
const embed = hashEmbed()

// Seed a small graph in the demo project (operator principal bypasses membership).
// Every node gets a `body` and its embedding — without them the ANN index is empty and the
// semantic/hybrid search modes have nothing to seed from.
const seedPrincipal: Principal = { userId: "seed", tenantId, operator: true }
const g = await graphForProject(control, seedPrincipal, projectId, "write", schema)
const addDoc = async (type: "person" | "document" | "org", data: object, body: string) =>
  g.addNode({ type, data, body, emb: await embed(body) } as Parameters<typeof g.addNode>[0])

const adaN = await addDoc(
  "person",
  { name: "Ada Lovelace" },
  "Ada Lovelace wrote the first published algorithm intended for a machine, computing Bernoulli numbers on the analytical engine.",
)
const alanN = await addDoc(
  "person",
  { name: "Alan Turing" },
  "Alan Turing formalised computation, proved the halting problem undecidable, and led cryptanalysis of naval ciphers.",
)
const graceN = await addDoc(
  "person",
  { name: "Grace Hopper" },
  "Grace Hopper built the first compiler and championed writing programs in readable English-like statements.",
)
const docN = await addDoc(
  "document",
  { title: "On Computable Numbers" },
  "On Computable Numbers introduces the turing machine and settles the entscheidungsproblem, showing decidability has limits.",
)
const orgN = await addDoc(
  "org",
  { name: "Bletchley Park" },
  "Bletchley Park was the wartime codebreaking site where cryptanalysts read intercepted German enigma signals traffic.",
)
await g.addEdge({ rel: "knows", src: adaN.id, dst: alanN.id })
await g.addEdge({ rel: "knows", src: alanN.id, dst: graceN.id })
await g.addEdge({ rel: "authored", src: alanN.id, dst: docN.id })
await g.addEdge({ rel: "works_at", src: alanN.id, dst: orgN.id })
await g.addEdge({ rel: "works_at", src: graceN.id, dst: orgN.id })

const app = createApp({ control, schema, authenticate, embed })
app.route("/admin", createAdminApp({ control, authenticate: adminAuthenticate }))

Bun.serve({ port: PORT, fetch: app.fetch })
console.log(
  `[admin-api] http://localhost:${PORT}  token="${ADMIN_TOKEN}"  seeded tenant=Acme project=Demo (5 nodes, 5 edges)`,
)
