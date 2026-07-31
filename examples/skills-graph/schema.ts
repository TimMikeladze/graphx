/**
 * The skills example's graph schema — occupations, the skills they need, and 2.7M observed job
 * moves, assembled from the `skill-collector` SQLite database (O*NET, Nesta skills-taxonomy-v2,
 * JobHop, Karrierewege).
 *
 * Two taxonomies meet here and the collector never merges them: O*NET describes occupations and
 * their skills (`11-1011.00`, "Chief Executives"), while the career-transition datasets speak
 * ESCO/ISCO codes (`1212.2`, "human resources manager"). Not one of the 2.7M transitions
 * references an O*NET code. So they are two node types — `occupation` and `occupation_code` —
 * joined by explicit `aligned_with` edges carrying the crosswalk's confidence. Traversing from a
 * skill to a career path means crossing that seam, and the seam is visible.
 *
 * No `single: true` rels — `bulkEdges` refuses them (it cannot close a predecessor edge).
 */
import { z } from 'zod';
import { defineGraphSchema } from '@graphx/core';

export const skillsSchema = defineGraphSchema({
	nodes: {
		/** An upstream dataset, with its license — the provenance root of everything below it. */
		source: z.object({
			name: z.string(),
			url: z.string().optional(),
			license: z.string().optional(),
			accessMethod: z.string().optional(),
		}),
		/** An O*NET occupation: the described end of the graph — title, summary, SOC code. */
		occupation: z.object({
			label: z.string(),
			description: z.string().optional(),
			externalId: z.string(),
			taxonomyCode: z.string().optional(),
			source: z.string(),
		}),
		/**
		 * An ESCO/ISCO occupation code as the career-transition datasets use it. `label` is filled
		 * in from the official ESCO-Code ⇄ ESCO-Label crosswalk where one exists; the rest are
		 * codes nothing in the corpus names, and keep the code as their label.
		 */
		occupation_code: z.object({
			code: z.string(),
			label: z.string(),
			named: z.boolean(),
			source: z.string(),
		}),
		/** A skill, ability, knowledge area or tool — from O*NET's taxonomy or Nesta's. */
		skill: z.object({
			label: z.string(),
			description: z.string().optional(),
			externalId: z.string(),
			skillType: z.string().optional(),
			source: z.string(),
		}),
	},
	edges: {
		/** Provenance: which dataset asserted this row. */
		sourced_from: { from: ['occupation', 'occupation_code', 'skill'], to: 'source' },
		/** O*NET's occupation-to-skill link. `data.relation` is `essential` / `optional` / `related`. */
		requires: {
			from: 'occupation',
			to: 'skill',
			data: z.object({ relation: z.string() }),
		},
		/**
		 * One observed job move by one person, not an aggregate: the corpus records 2.7M of them
		 * over 328k distinct pairs. `validFrom` is the quarter the move landed in where the dataset
		 * records one (JobHop does, Karrierewege does not), so the graph really does grow from 1955
		 * to 2024 as you scrub. `data.window` keeps the raw `Q3 2000 -> Q4 2003` string.
		 */
		transitioned_to: {
			from: 'occupation_code',
			to: 'occupation_code',
			data: z.object({ window: z.string().optional() }),
		},
		/**
		 * The seam between the two taxonomies. `weight` is the crosswalk's confidence and
		 * `data.method` is `official` or `fuzzy` — these are label matches, so they are suggestions.
		 */
		aligned_with: {
			from: 'occupation',
			to: 'occupation_code',
			data: z.object({ method: z.string() }),
		},
		/** The same seam between the two skill taxonomies (O*NET elements ⇄ Nesta skill ids). */
		similar_to: {
			from: 'skill',
			to: 'skill',
			data: z.object({ method: z.string() }),
		},
	},
});

export type SkillsSchema = typeof skillsSchema;

/** Bumped by hand when the schema or the loader's output changes shape; invalidates the cache. */
export const SKILLS_SCHEMA_VERSION = 1;
