import { defineGraphSchema, hashEmbed } from 'graphx';
import { z } from 'zod';

export const DAYS = ['weekday', 'saturday', 'sunday'] as const;
export type Day = (typeof DAYS)[number];

/**
 * King County Metro as a graph. Routes own patterns (one per distinct stop sequence), patterns
 * call at stops, trips run a pattern. Stop times live on the trip as an offset array: 1.1M
 * stop_time rows would be one version each and nothing asks for a single one.
 *
 * Valid time is service time: everything in the feed is valid from the feed's start date.
 * Scenario edits are ordinary writes in a forked branch.
 */
export const schema = defineGraphSchema({
	nodes: {
		route: z.object({
			gtfsId: z.string(),
			short: z.string(),
			long: z.string(),
			desc: z.string(),
			agency: z.string(),
			mode: z.enum(['bus', 'streetcar', 'rail', 'ferry', 'other']),
			color: z.string(),
			textColor: z.string(),
			url: z.string(),
		}),
		stop: z.object({
			gtfsId: z.string(),
			code: z.string(),
			name: z.string(),
			lat: z.number(),
			lng: z.number(),
			wheelchair: z.boolean(),
		}),
		pattern: z.object({
			key: z.string(), // `<route gtfsId>:<direction>:<n>`
			route: z.string(), // route gtfsId
			direction: z.number(),
			headsign: z.string(),
			stops: z.array(z.string()), // stop gtfsIds in order
			offsets: z.array(z.number()), // median seconds from the first stop
			lengthM: z.number(),
			coords: z.array(z.tuple([z.number(), z.number()])), // [lng, lat]
		}),
		trip: z.object({
			gtfsId: z.string(),
			route: z.string(),
			pattern: z.string(), // pattern key
			direction: z.number(),
			headsign: z.string(),
			days: z.array(z.enum(DAYS)),
			start: z.number(), // seconds after midnight; may pass 86400 for after-midnight trips
			times: z.array(z.number()), // seconds from `start`, one per pattern stop
			block: z.string(),
		}),
		scenario: z.object({
			title: z.string(),
			namespace: z.string(),
			project: z.string(),
			edits: z.array(z.record(z.string(), z.unknown())),
			status: z.enum(['forking', 'ready', 'failed']),
			forkedAt: z.number().nullable(), // edits after this instant are the scenario's
		}),
	},
	edges: {
		has: { from: 'route', to: 'pattern' },
		calls: { from: 'pattern', to: 'stop', data: z.object({ seq: z.number() }) },
		runs: { from: 'trip', to: 'pattern' },
		serves: { from: 'route', to: 'stop' },
		// weight = median scheduled seconds between the two stops on this route
		hop: {
			from: 'stop',
			to: 'stop',
			data: z.object({ route: z.string(), trips: z.number() }),
		},
	},
	embedding: {
		trip: { text: () => null },
		pattern: { text: () => null },
		stop: { text: (d: { name: string }) => d.name },
		route: {
			text: (d: { short: string; long: string; desc: string }) =>
				`${d.short} ${d.long} ${d.desc}`.trim(),
		},
	},
});

export type Schema = typeof schema;
export type RouteData = Schema['nodes']['route']['_output'];
export type StopData = Schema['nodes']['stop']['_output'];
export type PatternData = Schema['nodes']['pattern']['_output'];
export type TripData = Schema['nodes']['trip']['_output'];

/** Model-free 256-wide vectors: search works offline and loads fast. */
export const embedder = hashEmbed(256);
