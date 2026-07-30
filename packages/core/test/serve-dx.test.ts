import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { evict, getDb } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { createApp } from '../src/serve.ts';

// createApp DX knobs: `cors` (browser SPA without a dev proxy) and `logger` (request logging).
// Exercised through the dev overload so no control/authenticate boilerplate is needed.

const SCHEMA = defineGraphSchema({ nodes: { person: z.object({ name: z.string() }) }, edges: {} });

function cleanup(control: { close: () => void }, db: string): void {
	control.close();
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
}

test('createApp cors:true — permissive origin + OPTIONS preflight', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const { app, control } = await createApp({ schema: SCHEMA, db, cors: true });

	// Actual GET carries the ACAO header (unauthenticated /health suffices for the CORS probe).
	const get = await app.request('/health', { headers: { Origin: 'http://elsewhere.test' } });
	expect(get.headers.get('access-control-allow-origin')).toBe('*');

	// Preflight is answered before routing (204, allow-methods present).
	const pre = await app.request('/health', {
		method: 'OPTIONS',
		headers: {
			Origin: 'http://elsewhere.test',
			'Access-Control-Request-Method': 'GET',
		},
	});
	expect(pre.status).toBe(204);
	expect(pre.headers.get('access-control-allow-methods')).toBeTruthy();
	cleanup(control, db);
});

test('createApp cors object — restricts the origin', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const { app, control } = await createApp({
		schema: SCHEMA,
		db,
		cors: { origin: 'http://allowed.test' },
	});
	const ok = await app.request('/health', { headers: { Origin: 'http://allowed.test' } });
	expect(ok.headers.get('access-control-allow-origin')).toBe('http://allowed.test');
	const other = await app.request('/health', { headers: { Origin: 'http://nope.test' } });
	expect(other.headers.get('access-control-allow-origin')).not.toBe('http://nope.test');
	cleanup(control, db);
});

test('createApp: /docs (Scalar) is served by default, pointing at /openapi.json', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const { app, control } = await createApp({ schema: SCHEMA, db, openapi: { title: 'my-api' } });
	const res = await app.request('/docs');
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toContain('text/html');
	const html = await res.text();
	expect(html).toContain('/openapi.json'); // the reference reads the contract
	expect(html).toContain('scalar'); // Scalar CDN embed
	expect(html).toContain('my-api'); // title threaded from openapi config
	cleanup(control, db);
});

test('createApp docs:false — /docs is 404', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const { app, control } = await createApp({ schema: SCHEMA, db, docs: false });
	expect((await app.request('/docs')).status).toBe(404);
	// the machine-readable contract stays available regardless
	expect((await app.request('/openapi.json')).status).toBe(200);
	cleanup(control, db);
});

test('createApp logger:true — logs requests without altering the response', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const original = console.log;
	let lines = 0;
	console.log = () => {
		lines += 1;
	};
	try {
		const { app, control } = await createApp({ schema: SCHEMA, db, logger: true });
		const res = await app.request('/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok' });
		cleanup(control, db);
	} finally {
		console.log = original;
	}
	expect(lines).toBeGreaterThan(0); // logger emitted (in + out lines)
});

test('a write that exhausts its contention budget -> 409, not 500', async () => {
	const db = `dev_${ulid().toLowerCase()}`;
	const { app, control, tenant, project } = await createApp({ schema: SCHEMA, db });

	// Both the §19.1 retry envelope and the snapshot commit protocol give up with this
	// message. Raised straight from the client so the mapping is tested without waiting out
	// 50 backoffs — what onError sees is identical either way.
	const client = getDb(db);
	const batch = client.batch.bind(client);
	client.batch = async () => {
		throw new Error('addNode: too much contention');
	};

	const res = await app.request(`/t/${tenant}/p/${project}/nodes`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ type: 'person', data: { name: 'contended' } }),
	});
	expect(res.status).toBe(409);
	expect((await res.json()).error).toMatch(/too much contention/);

	client.batch = batch;
	cleanup(control, db);
});
