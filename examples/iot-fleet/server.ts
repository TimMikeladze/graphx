/**
 * Dev API for the IoT-fleet example — Bun + libSQL (SQLite). Bootstraps an in-memory control plane,
 * one tenant/project/user, seeds a small fleet graph into a local SQLite file, and serves the graphx
 * HTTP surface (createApp) on :8899. `GET /demo` hands the client the seeded ids so it can configure
 * <GraphProvider>. Auth is header-based (x-user / x-tenant), matching the client.
 *
 *   bun run server.ts     # then, in another shell: bun run dev  (Vite on :5173, proxies to :8899)
 */
import { rmSync } from 'node:fs';
import process from 'node:process';
import { createClient } from '@libsql/client';
import {
	addMembership,
	createApp,
	createProject,
	createTenant,
	createUser,
	graphForProject,
	initControl,
	type Principal,
} from '@graphx/core';
import { schema } from './schema.ts';

const PORT = Number(process.env.PORT ?? 8899);
const NS = 'iot_demo';

// Fresh graph every start (cwd = this dir).
for (const sfx of ['', '-wal', '-shm']) rmSync(`${NS}.db${sfx}`, { force: true });

/** Deterministic 768-dim bag-of-tokens embedding — no model needed for the retrieve/hybrid demo. */
function embed(text: string): Promise<number[]> {
	const v = Array.from({ length: 768 }, () => 0);
	for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
		let h = 0;
		for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
		const idx = h % 768;
		v[idx] = (v[idx] ?? 0) + 1;
	}
	return Promise.resolve(v);
}

// --- control plane + one tenant/project/user ---
const control = createClient({ url: ':memory:' });
await initControl(control);
const tenantId = await createTenant(control, { name: 'Acme IoT' });
const projectId = await createProject(control, { tenantId, name: 'Fleet', dbNamespace: NS });
const userId = await createUser(control, { email: 'ops@acme.test' });
await addMembership(control, { userId, tenantId, role: 'editor' });

// --- seed the graph (operator principal bypasses membership for the seed) ---
const seed: Principal = { userId: 'seed', tenantId, operator: true };
const g = await graphForProject(control, seed, projectId, 'write', schema);

const usEast = await g.addNode({ kind: 'site', props: { name: 'us-east-1', region: 'us' } });
const euWest = await g.addNode({ kind: 'site', props: { name: 'eu-west-1', region: 'eu' } });

const gw1 = await g.addNode({ kind: 'gateway', props: { name: 'gw-1', firmware: '2.1.0' } });
const gw2 = await g.addNode({ kind: 'gateway', props: { name: 'gw-2', firmware: '2.0.5', online: false } });

const temp1 = await g.addNode({
	kind: 'device',
	props: { name: 'temp-1', category: 'sensor', model: 'DHT22' },
	body: 'temperature humidity sensor cold-aisle rack 4',
});
const valve1 = await g.addNode({
	kind: 'device',
	props: { name: 'valve-1', category: 'actuator', model: 'V10' },
	body: 'coolant flow valve actuator',
});
const temp2 = await g.addNode({
	kind: 'device',
	props: { name: 'temp-2', category: 'sensor', model: 'DHT22' },
	body: 'temperature sensor hot-aisle',
});

await g.addEdge({ rel: 'deployedAt', src: gw1.id, dst: usEast.id });
await g.addEdge({ rel: 'deployedAt', src: gw2.id, dst: euWest.id });
await g.addEdge({ rel: 'connectedTo', src: temp1.id, dst: gw1.id, props: { rssi: -55 } });
await g.addEdge({ rel: 'connectedTo', src: valve1.id, dst: gw1.id, props: { rssi: -71 } });
await g.addEdge({ rel: 'connectedTo', src: temp2.id, dst: gw2.id, props: { rssi: -60 } });

const overheat = await g.addNode({
	kind: 'alert',
	props: { code: 'OVER_TEMP', severity: 'critical' },
	body: 'temperature threshold exceeded 85C sustained',
});
const battery = await g.addNode({
	kind: 'alert',
	props: { code: 'LOW_BATTERY', severity: 'warning' },
	body: 'battery below 15 percent replace soon',
});
await g.addEdge({ rel: 'raised', src: overheat.id, dst: temp1.id });
await g.addEdge({ rel: 'raised', src: battery.id, dst: valve1.id });

// --- serve ---
const app = createApp({
	control,
	schema,
	embed,
	authenticate: (c) => {
		const u = c.req.header('x-user');
		const t = c.req.header('x-tenant');
		if (!u || !t) throw new Error('missing auth');
		return { userId: u, tenantId: t };
	},
	openapi: { title: 'iot-fleet', servers: [{ url: `http://localhost:${PORT}` }] },
});

// Unauthenticated bootstrap: hand the client its session ids.
app.get('/demo', (c) => c.json({ tenant: tenantId, project: projectId, user: userId }));

Bun.serve({ port: PORT, fetch: app.fetch });
console.log(`[iot-fleet] http://localhost:${PORT}  (GET /demo for ids, GET /openapi.json for the contract)`);
