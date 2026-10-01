/**
 * The graphx schema for the MMA vault. Node data is the frontmatter (`.passthrough()` —
 * frontmatter is node data), and fights carry the graph:
 *
 *   fight --won--> fighter      (winner)
 *   fight --lost--> fighter     (loser)
 *   fight --drew--> fighter     (both corners of a draw/NC)
 *   fight --part_of--> event
 *
 * Ingest maps them via `edgeFields` (see load.ts) — the vault's `winner:`/`loser:`/`drew:`/
 * `event:` frontmatter keys become these typed edges.
 */
import { defineGraphSchema } from 'graphx';
import { z } from 'zod';

export const mmaSchema = defineGraphSchema({
	nodes: {
		fighter: z.object({ id: z.string(), name: z.string() }).passthrough(),
		event: z.object({ id: z.string(), name: z.string() }).passthrough(),
		// `date` is optional: a handful of early one-night-tournament fights carry no date.
		fight: z.object({ id: z.string() }).passthrough(),
	},
	edges: {
		won: { from: 'fight', to: 'fighter' },
		lost: { from: 'fight', to: 'fighter' },
		drew: { from: 'fight', to: 'fighter' },
		part_of: { from: 'fight', to: 'event' },
	},
});

export type MmaSchema = typeof mmaSchema;
/** Bump when the shape of derived fighter stats changes, so cached builds rebuild. */
export const MMA_SCHEMA_VERSION = 1;
