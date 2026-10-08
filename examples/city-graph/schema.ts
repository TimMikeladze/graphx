import { defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

/**
 * Boston as a graph. Intersections and the directed road segments between them carry the
 * traffic; zones, commutes, crashes, 311 reports and the bus network hang off them.
 *
 * Valid time is city time: a crash is valid from when it happened, a 311 case while it was open,
 * and each road segment has one version per modelled window of the day (see `src/day.ts`).
 */
export const schema = defineGraphSchema({
	nodes: {
		intersection: z.object({
			key: z.string(), // `osm:<node id>`
			name: z.string(),
			lat: z.number(),
			lng: z.number(),
			signal: z
				.object({
					cityId: z.number(),
					name: z.string(),
					cycleSec: z.number(),
					green: z.record(z.string(), z.number()),
					synthetic: z.boolean(),
				})
				.nullable(),
		}),
		zone: z.object({
			key: z.string(), // `bg:<geoid>` (Boston block group) or `tract:<geoid>` (elsewhere in MA)
			geoid: z.string(),
			kind: z.enum(['boston', 'external']),
			name: z.string(),
			neighborhood: z.string(),
			lat: z.number(),
			lng: z.number(),
			residents: z.number(), // LODES workers living here
			jobs: z.number(), // LODES jobs located here
		}),
		commute: z.object({
			home: z.string(), // zone key
			work: z.string(),
			workers: z.number(),
			drivers: z.number(),
			amMinutes: z.number(), // driving time leaving at 08:00
			pmMinutes: z.number(), // driving time home leaving at 17:15
		}),
		crash: z.object({
			at: z.number(),
			mode: z.enum(['ped', 'bike', 'mv']),
			locationType: z.string(),
			street: z.string(),
			lat: z.number(),
			lng: z.number(),
		}),
		report: z.object({
			caseId: z.string(),
			type: z.string(),
			status: z.string(),
			openedAt: z.number(),
			closedAt: z.number().nullable(),
			street: z.string(),
			neighborhood: z.string(),
			lat: z.number(),
			lng: z.number(),
		}),
		stop: z.object({ gtfsId: z.string(), name: z.string(), lat: z.number(), lng: z.number() }),
		route: z.object({
			gtfsId: z.string(),
			name: z.string(),
			longName: z.string(),
			color: z.string(),
		}),
		scenario: z.object({
			title: z.string(),
			namespace: z.string(),
			project: z.string(),
			edits: z.record(z.string(), z.unknown()),
			status: z.enum(['running', 'done', 'failed']),
			progress: z.number(),
			summary: z.record(z.string(), z.unknown()).nullable(),
		}),
	},
	edges: {
		road: {
			from: 'intersection',
			to: 'intersection',
			// weight = seconds to drive the segment and clear the signal at its far end, this window
			data: z.object({
				key: z.string(),
				street: z.string(),
				highway: z.string(),
				lengthM: z.number(),
				lanes: z.number(),
				freeFlowSec: z.number(),
				capacity: z.number(),
				volume: z.number(), // vehicles per hour, this window
			}),
		},
		connects: { from: 'zone', to: 'intersection' },
		home: { from: 'commute', to: 'zone' },
		work: { from: 'commute', to: 'zone' },
		passes: { from: 'commute', to: 'intersection', data: z.object({ order: z.number() }) },
		at: { from: 'crash', to: 'intersection' },
		near: { from: 'report', to: 'intersection' },
		serves: { from: 'route', to: 'stop' },
		// weight = seconds between consecutive stops: scheduled, then observed live
		transitLink: {
			from: 'stop',
			to: 'stop',
			data: z.object({
				route: z.string(),
				scheduledSec: z.number(),
				observedSec: z.number().nullable(),
			}),
		},
	},
	// Intersections are found by name through full-text search on their `body`; only things
	// worth searching by meaning carry vectors, which keeps the vector index (and forks) small.
	embedding: {
		intersection: { text: () => null },
		commute: { text: () => null },
		crash: { text: () => null },
		zone: { text: (d: { name: string; neighborhood: string }) => `${d.name}, ${d.neighborhood}` },
		stop: { text: (d: { name: string }) => d.name },
		route: { text: (d: { name: string; longName: string }) => `${d.name} ${d.longName}` },
	},
});

export type Schema = typeof schema;

/** Model-free 256-wide vectors: search works offline and loads fast. Swap for a real model freely. */
export const embedder = hashEmbed(256);
