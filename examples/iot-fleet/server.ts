/**
 * Dev API for the IoT-fleet example — Bun + libSQL (SQLite). `createApp({ schema, seed })` bootstraps
 * an in-memory control plane + one tenant/project/user, seeds a small fleet graph into a local SQLite
 * file, mounts the graphx HTTP surface + `GET /demo` (session ids), and serves on :8899.
 *
 *   bun run server.ts     # then, in another shell: bun run dev  (Vite on :5173, proxies to :8899)
 */
import { rmSync } from 'node:fs';
import process from 'node:process';
import { createApp, hashEmbed } from '@graphx/core';
import { schema } from './schema.ts';

const PORT = Number(process.env.PORT ?? 8899);
const db = 'iot_demo';

// Fresh graph every start (cwd = this dir).
for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });

const { app } = await createApp({
	schema,
	// Model-free dev embedder; auto-dim sizes the vector column to match it (no `dim` bookkeeping).
	embed: hashEmbed(),
	db: db,
	// CORS lets a browser SPA on another origin call this directly (the Vite proxy also covers dev).
	cors: true,
	openapi: { title: 'iot-fleet', servers: [{ url: `http://localhost:${PORT}` }] },
	seed: async (g) => {

		const usEast = await g.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
		const euWest = await g.addNode({ type: 'site', data: { name: 'eu-west-1', region: 'eu' } });

		const gw1 = await g.addNode({ type: 'gateway', data: { name: 'gw-1', firmware: '2.1.0' } });
		const gw2 = await g.addNode({ type: 'gateway', data: { name: 'gw-2', firmware: '2.0.5', online: false } });

		const temp1 = await g.addNode({
			type: 'device',
			data: { name: 'temp-1', category: 'sensor', model: 'DHT22' },
			body: 'temperature humidity sensor cold-aisle rack 4',
		});
		const valve1 = await g.addNode({
			type: 'device',
			data: { name: 'valve-1', category: 'actuator', model: 'V10' },
			body: 'coolant flow valve actuator',
		});
		const temp2 = await g.addNode({
			type: 'device',
			data: { name: 'temp-2', category: 'sensor', model: 'DHT22' },
			body: 'temperature sensor hot-aisle',
		});

		await g.addEdge({ rel: 'deployedAt', src: gw1.id, dst: usEast.id });
		await g.addEdge({ rel: 'deployedAt', src: gw2.id, dst: euWest.id });
		await g.addEdge({ rel: 'connectedTo', src: temp1.id, dst: gw1.id, data: { rssi: -55 } });
		await g.addEdge({ rel: 'connectedTo', src: valve1.id, dst: gw1.id, data: { rssi: -71 } });
		await g.addEdge({ rel: 'connectedTo', src: temp2.id, dst: gw2.id, data: { rssi: -60 } });

		const overheat = await g.addNode({
			type: 'alert',
			data: { code: 'OVER_TEMP', severity: 'critical' },
			body: 'temperature threshold exceeded 85C sustained',
		});
		const battery = await g.addNode({
			type: 'alert',
			data: { code: 'LOW_BATTERY', severity: 'warning' },
			body: 'battery below 15 percent replace soon',
		});
		await g.addEdge({ rel: 'raised', src: overheat.id, dst: temp1.id });
		await g.addEdge({ rel: 'raised', src: battery.id, dst: valve1.id });
	},
});

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[iot-fleet] http://localhost:${PORT}  (GET /demo for ids, GET /openapi.json for the contract)`);
