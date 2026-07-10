import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { evict } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { createApp } from '../src/serve.ts';

// The batteries-included `createApp` overload: pass a schema (no control/authenticate) and it
// bootstraps an in-memory control plane, one tenant/project/user, seeds, and serves — collapsing
// the 15-line dev bootstrap into one call.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: {},
});

function cleanup(control: { close: () => void }, db: string): void {
	control.close();
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
}

test('createApp dev: bootstraps + seeds + serves; /demo returns the ids', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const { app, control, tenant, project, user } = await createApp({
		schema: SCHEMA,
		db,
		seed: async (g) => {
			await g.addNode({ kind: 'person', props: { name: 'ada' } });
		},
	});

	expect(await (await app.request('/demo')).json()).toEqual({ tenant, project, user });

	const res = await app.request(`/t/${tenant}/p/${project}/nodes?kind=person`, {
		headers: { 'x-user': user, 'x-tenant': tenant },
	});
	expect(res.status).toBe(200);
	expect((await res.json()).nodes.map((n: { props: { name: string } }) => n.props.name)).toEqual([
		'ada',
	]);
	cleanup(control, db);
});

test('createApp dev: reads default to the seeded principal when no auth headers are sent', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const { app, control, tenant, project } = await createApp({ schema: SCHEMA, db });
	const res = await app.request(`/t/${tenant}/p/${project}/nodes`); // no x-user/x-tenant
	expect(res.status).toBe(200);
	cleanup(control, db);
});
