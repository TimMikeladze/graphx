import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { makeTestDb } from './harness.ts';
import { ulid } from 'ulidx';
import { z } from 'zod';
import {
	addMembership,
	createProject,
	createTenant,
	createUser,
	initControl,
} from '../src/control-plane.ts';
import { evict, FOREVER, getDb } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { createApp } from '../src/serve.ts';
import { defineUpcasters } from '../src/upcast.ts';

// P12 serving wire (§14 / §15). The HTTP read surfaces (getNode/neighbors/journey)
// must apply the read-time upcaster when the operator configures one on ServeConfig —
// otherwise the primary multi-tenant consumer returns raw, un-upcast data over the
// wire while the in-process SDK upcasts. This test wires `upcasters` into createApp
// and asserts a v1 row served over HTTP comes back in the latest (v2) shape.

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({
			name: z.string(),
			criticality: z.number(),
			status: z.string().default('online'),
		}),
	},
	edges: {},
});

const UPCAST = defineUpcasters({
	device: { current: 2, steps: [(p) => ({ name: p.name, criticality: p.crit, status: 'online' })] },
});

function authenticate(c: { req: { header: (n: string) => string | undefined } }) {
	const userId = c.req.header('x-user');
	const tenantId = c.req.header('x-tenant');
	if (!userId || !tenantId) throw new Error('missing auth');
	return { userId, tenantId };
}

test('P12 (serve): a v1 row served over HTTP is upcast to the latest shape when ServeConfig.upcasters is set', async () => {
	const control = makeTestDb().client;
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenant, role: 'editor' });
	const ns = `ns_${ulid().toLowerCase()}`;
	const project = await createProject(control, { tenantId: tenant, name: 'Alpha', dbNamespace: ns });

	const app = createApp({ control, schema: SCHEMA, authenticate, upcasters: UPCAST });
	const hdr = { 'x-user': editor, 'x-tenant': tenant, 'content-type': 'application/json' };
	const base = `/t/${tenant}/p/${project}`;

	// A first authorized request lazily init()s the project DB + schema (404 is fine).
	await app.request(`${base}/nodes/${ulid()}`, { headers: hdr });

	// Inject a raw v1 device row directly into the project DB the server just init'd —
	// the SAME cached client the server resolves via getDb (so it works on either backend).
	const projectDb = getDb(ns);
	const id = ulid();
	await projectDb.execute({ sql: 'INSERT INTO node_identity (id) VALUES (?)', args: [id] });
	await projectDb.execute({
		sql: 'INSERT INTO node_versions (id, type, data, valid_from, valid_to) VALUES (?,?,?,?,?)',
		args: [id, 'device', JSON.stringify({ name: 'r1', crit: 5, _v: 1 }), 1, FOREVER],
	});

	const res = await app.request(`${base}/nodes/${id}`, { headers: hdr });
	expect(res.status).toBe(200);
	const node = (await res.json()) as { data: Record<string, unknown> };
	// upcast to v2 over the wire: crit -> criticality, status default applied, `_v` stripped
	expect(node.data).toEqual({ name: 'r1', criticality: 5, status: 'online' });

	evict(ns);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${ns}.db${sfx}`, { force: true });
	control.close();
});
