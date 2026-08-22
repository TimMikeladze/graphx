import { defineGraphSchema } from '@graphx/core';
import { z } from 'zod';

/**
 * An IoT fleet graph. Defined once — the SERVER imports the value (`schema`) to seed + serve; the
 * CLIENT imports only the TYPE (`Schema`) so its bundle carries no SDK runtime.
 */
export const schema = defineGraphSchema({
	nodes: {
		site: z.object({ name: z.string(), region: z.enum(['us', 'eu', 'apac']) }),
		gateway: z.object({
			name: z.string(),
			firmware: z.string(),
			online: z.boolean().default(true),
		}),
		device: z.object({
			name: z.string(),
			category: z.enum(['sensor', 'actuator']),
			model: z.string(),
		}),
		alert: z.object({
			code: z.string(),
			severity: z.enum(['info', 'warning', 'critical']),
			status: z.enum(['open', 'ack', 'resolved']).default('open'),
		}),
	},
	edges: {
		deployedAt: { from: 'gateway', to: 'site', single: true },
		connectedTo: {
			from: 'device',
			to: 'gateway',
			data: z.object({ rssi: z.number() }),
			single: true,
		},
		raised: { from: 'alert', to: 'device' },
	},
});

export type Schema = typeof schema;
