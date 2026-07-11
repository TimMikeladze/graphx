import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { evict, getDb } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { hashEmbed } from '../src/retrieve.ts';
import { init } from '../src/schema.ts';
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
			await g.addNode({ type: 'person', data: { name: 'ada' } });
		},
	});

	expect(await (await app.request('/demo')).json()).toEqual({ tenant, project, user });

	const res = await app.request(`/t/${tenant}/p/${project}/nodes?type=person`, {
		headers: { 'x-user': user, 'x-tenant': tenant },
	});
	expect(res.status).toBe(200);
	expect((await res.json()).nodes.map((n: { data: { name: string } }) => n.data.name)).toEqual([
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

test('createApp dev: auto-dim sizes the vector column from the embedder (non-768 works end-to-end)', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const embed = hashEmbed(64); // deliberately NOT the 768 default
	const { app, control, tenant, project, graph } = await createApp({
		schema: SCHEMA,
		embed,
		db,
		// seed a node whose stored embedding is 64-dim — a 768 column would reject the ANN
		// (vector_distance dimension mismatch), so a hit proves the column was sized at the
		// embedder's width, not the default.
		seed: async (g) => {
			await g.addNode({
				type: 'person',
				data: { name: 'ada' },
				body: 'analytical engine',
				emb: await embed('analytical engine'),
			});
		},
	});
	expect(graph).toBeDefined();
	const res = await app.request(
		`/t/${tenant}/p/${project}/retrieve?query=${encodeURIComponent('analytical engine')}&k=5`,
	);
	expect(res.status).toBe(200);
	const hits = (await res.json()) as Array<{ id: string; body: string | null }>;
	expect(hits.length).toBeGreaterThan(0);
	expect(hits[0]?.body).toContain('analytical');
	cleanup(control, db);
});

test('createApp dev: fails fast when auto-dim disagrees with an existing namespace', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	await init(getDb(db), 64); // namespace already materialized at dim 64
	// An embedder implying dim 128 must throw (immutable), not silently keep 64 and reject inserts.
	await expect(createApp({ schema: SCHEMA, embed: hashEmbed(128), db })).rejects.toThrow(
		/immutable|dim 64/,
	);
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
});
