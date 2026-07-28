/**
 * The demo graph's schema — eight node types and ten rels, sized so the admin explorer has
 * something to filter, color and traverse. Dev tooling only: nothing here ships in a package.
 *
 * No `single: true` rels — `bulkEdges` refuses them (it cannot close a predecessor edge).
 */
import { z } from 'zod'
import { defineGraphSchema } from '../../packages/core/src/index.ts'

export const demoSchema = defineGraphSchema({
  nodes: {
    // `avatar` is one of the keys the graph slice reads as a node picture, so the demo graph
    // exercises the canvases' avatar rendering.
    person: z.object({
      name: z.string(),
      title: z.string(),
      location: z.string(),
      avatar: z.string().optional(),
    }),
    team: z.object({ name: z.string(), charter: z.string() }),
    org: z.object({ name: z.string(), industry: z.string() }),
    project: z.object({ name: z.string(), status: z.string() }),
    document: z.object({ title: z.string(), kind: z.string() }),
    ticket: z.object({ title: z.string(), state: z.string(), priority: z.number() }),
    repo: z.object({ name: z.string(), language: z.string() }),
    tag: z.object({ label: z.string() }),
  },
  edges: {
    knows: { from: "person", to: "person" },
    member_of: { from: "person", to: "team" },
    works_at: { from: "person", to: "org" },
    owns: { from: "team", to: ["project", "repo"] },
    authored: { from: "person", to: ["document", "ticket"] },
    mentions: { from: "document", to: ["person", "project", "repo", "document"] },
    blocks: { from: "ticket", to: "ticket" },
    assigned_to: { from: "ticket", to: "person" },
    tagged: { from: ["document", "ticket", "project", "repo"], to: "tag" },
    depends_on: { from: ["project", "repo"], to: ["project", "repo"] },
  },
})

export type DemoSchema = typeof demoSchema

/**
 * Bumped whenever the schema or the generator's output changes shape. Feeds the seed-cache
 * fingerprint, so an edit here invalidates every cached demo database.
 */
export const DEMO_SCHEMA_VERSION = 2
