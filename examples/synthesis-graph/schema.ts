import { defineGraphSchema } from 'graphx';
import { z } from 'zod';

/**
 * A synthesis graph: molecules and the reactions between them. The SERVER imports the value; the
 * web app imports only the TYPE (`Schema`), so its bundle carries no graphx runtime.
 */
export const schema = defineGraphSchema({
	nodes: {
		molecule: z.object({
			name: z.string(),
			formula: z.string(),
			mw: z.number(),
			/** $/mol, or null when it is not bought (intermediate, recycled catalyst, supply cut). */
			price: z.number().nullable(),
			hazard: z.string().nullable(),
			/** 'severe' | 'none' — a string so a pattern can `.where()` on it. */
			severity: z.enum(['severe', 'none']),
		}),
		reaction: z.object({
			name: z.string(),
			route: z.enum(['Boots', 'BHC', 'Flow']),
			yield: z.number(),
			conditions: z.string(),
			ref: z.string(),
		}),
	},
	edges: {
		// weight 0: entering a reaction costs nothing
		reactant: { from: 'molecule', to: 'reaction', data: z.object({ stoich: z.number() }) },
		// weight −ln(yield): a weighted shortestPath sums to −ln(yield of the whole chain)
		product: { from: 'reaction', to: 'molecule', data: z.object({ stoich: z.number() }) },
		// not consumed — only here so hazards are part of the graph
		catalyst: { from: 'reaction', to: 'molecule' },
	},
});

export type Schema = typeof schema;
