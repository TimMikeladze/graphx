import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { evict, getDb } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { hashEmbed } from '../../src/core/embedder.ts';
import { init } from '../../src/core/schema.ts';
import { createApp } from '../../src/core/serve.ts';

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

test('createApp dev: the vector table is sized from the embedder and writes embed through it', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const embedder = hashEmbed(64); // deliberately NOT the 768 default
	const { app, control, tenant, project, graph } = await createApp({
		schema: SCHEMA,
		embedder,
		db,
		// The seed passes no vector: the graph embeds `body` itself at the embedder's width, so
		// a retrieve hit proves both the table sizing and the automatic embedding.
		seed: async (g) => {
			await g.addNode({ type: 'person', data: { name: 'ada' }, body: 'analytical engine' });
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

test('createApp dev: fails fast when the embedder disagrees with an existing namespace', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	await init(getDb(db), hashEmbed(64)); // namespace already embedded with hash:64
	// A different model must throw (model mismatch), not silently keep the old vectors.
	await expect(createApp({ schema: SCHEMA, embedder: hashEmbed(128), db })).rejects.toThrow(
		/embedded with 'hash:64'/,
	);
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
});
