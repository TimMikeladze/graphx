/**
 * The pantheon example's graph schema — a cross-cultural graph of deities assembled from the
 * `pantheon-collector` SQLite database (Wikidata, DBpedia, Wikipedia, Greek Myth API,
 * greek-mythology-data).
 *
 * The collector deliberately does NOT reconcile its sources: two sources claiming different
 * parents for the same figure produce two rows, each with its own `source_id`. That shape is
 * preserved here rather than flattened — every deity carries the source it came from, every
 * source is a node you can traverse to, and cross-source identity is an explicit `same_as` edge
 * with a confidence rather than a merge. The interesting queries are about the disagreement.
 *
 * No `single: true` rels — `bulkEdges` refuses them (it cannot close a predecessor edge).
 */
import { z } from 'zod';
import { defineGraphSchema } from 'graphx-core';

export const pantheonSchema = defineGraphSchema({
	nodes: {
		/** An upstream dataset, with its license — the provenance root of everything below it. */
		source: z.object({
			name: z.string(),
			url: z.string().optional(),
			license: z.string().optional(),
			accessMethod: z.string().optional(),
		}),
		/** A named pantheon as one source describes it (Greek, Norse, Yoruba, …). */
		pantheon: z.object({
			name: z.string(),
			culture: z.string().optional(),
			region: z.string().optional(),
			era: z.string().optional(),
			source: z.string(),
		}),
		/** One source's row for one figure. The same god appears once per source that names it. */
		deity: z.object({
			name: z.string(),
			nativeName: z.string().optional(),
			pantheon: z.string().optional(),
			description: z.string().optional(),
			externalId: z.string().optional(),
			coverage: z.string().optional(),
			source: z.string(),
		}),
		/** A domain of influence (sky, fertility, war, …), shared across sources and cultures. */
		domain: z.object({ label: z.string() }),
	},
	edges: {
		/** Provenance: which dataset asserted this row. */
		sourced_from: { from: ['deity', 'pantheon'], to: 'source' },
		belongs_to: { from: 'deity', to: 'pantheon' },
		/** `data.source` names the dataset that asserted the domain — sources disagree here. */
		has_domain: { from: 'deity', to: 'domain' },
		parent_of: { from: 'deity', to: 'deity' },
		sibling_of: { from: 'deity', to: 'deity' },
		consort_of: { from: 'deity', to: 'deity' },
		/**
		 * Cross-source identity, NOT a merge. `weight` is the collector's confidence and
		 * `data.method` is how it was decided (`asserted_in_source` ⇒ 1.0, `fuzzy` ⇒ a name match).
		 */
		same_as: {
			from: 'deity',
			to: 'deity',
			data: z.object({ method: z.string() }),
		},
	},
});

export type PantheonSchema = typeof pantheonSchema;

/** Bumped by hand when the schema or the loader's output changes shape; invalidates the cache. */
export const PANTHEON_SCHEMA_VERSION = 1;
