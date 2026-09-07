import { rmSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { Validator } from '@seriousme/openapi-schema-validator';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { evict } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { createApp } from '../../src/core/serve.ts';

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

// The OpenAPI contract is backend-agnostic (routes/schemas are identical on libSQL + Postgres) and
// these tests never query the DB, so they use an in-memory libSQL control on every driver — this
// also dodges the PG harness's lazy ensureSchema firing against a torn-down pool.
function app() {
	const control = createClient({ url: ':memory:' });
	const a = createApp({
		control,
		schema: SCHEMA,
		authenticate: () => ({ userId: 'u', tenantId: 't' }),
	});
	return { app: a, teardown: () => control.close() };
}

/** The document as the app serves it — generated from the routes, so there is no other way in. */
async function doc(): Promise<any> {
	const { app: a, teardown } = app();
	const res = await a.request('/openapi.json');
	expect(res.status).toBe(200);
	const body = await res.json();
	await teardown();
	return body;
}

const TENANT = '/t/{tenant}/p/{project}';

test('openapi: document shape — 3.1, info, security scheme', async () => {
	const d = await doc();
	expect(d.openapi).toBe('3.1.0');
	expect(d.info.title).toBeDefined();
	expect(d.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
	expect(d.security).toEqual([{ bearerAuth: [] }]);
});

test('openapi: served unauthenticated at GET /openapi.json', async () => {
	const { app: a, teardown } = app();
	const res = await a.request('/openapi.json'); // no Authorization header
	expect(res.status).toBe(200);
	expect((await res.json()).openapi).toBe('3.1.0');
	await teardown();
});

test('openapi: the document validates against the OpenAPI 3.1 schema', async () => {
	const result = await new Validator().validate(await doc());
	expect(result.errors ?? []).toEqual([]);
	expect(result.valid).toBe(true);
});

test('openapi: POST /nodes requestBody schema is derived from the Zod wire schema', async () => {
	const op = (await doc()).paths[`${TENANT}/nodes`].post;
	const schema = op.requestBody.content['application/json'].schema;
	expect(schema.properties.type).toEqual({ type: 'string' });
	expect(schema.properties.emb).toEqual({ type: 'array', items: { type: 'number' } });
	expect(schema.required).toEqual(['type']); // `data` carries a default
});

test('openapi: query params are emitted (GET /changes -> nodes/edges/limit)', async () => {
	const op = (await doc()).paths[`${TENANT}/changes`].get;
	const query = (op.parameters as Array<{ name: string; in: string }>).filter(
		(p) => p.in === 'query',
	);
	expect(query.map((p) => p.name).sort()).toEqual(['edges', 'limit', 'nodes']);
	// Coerced numerics publish as plain numbers, not the `number | null` their input type implies.
	expect(query.find((p) => p.name === 'limit')).toMatchObject({
		required: false,
		schema: { type: 'integer', exclusiveMinimum: 0 },
	});
});

test('openapi: required query params are marked required (GET /diff -> t1, t2)', async () => {
	const op = (await doc()).paths[`${TENANT}/diff`].get;
	const query = (op.parameters as Array<{ name: string; in: string; required: boolean }>)
		.filter((p) => p.in === 'query')
		.map((p) => [p.name, p.required]);
	expect(query.sort()).toEqual([
		['t1', true],
		['t2', true],
	]);
});

test('openapi: path params + write-only 403 + 204 on delete', async () => {
	const item = (await doc()).paths[`${TENANT}/nodes/{id}`];
	const params = (item.get.parameters as Array<{ name: string; in: string }>)
		.filter((p) => p.in === 'path')
		.map((p) => p.name);
	expect(params).toEqual(['tenant', 'project', 'id']);
	expect(item.delete.responses['403']).toBeDefined(); // write op
	expect(item.get.responses['403']).toBeUndefined(); // read op
	expect(item.delete.responses['204']).toEqual({ description: 'No Content' });
});

test('openapi: success responses carry real schemas (not an empty object)', async () => {
	const paths = (await doc()).paths;
	const body = (path: string, method: string) =>
		paths[path][method].responses['200'].content['application/json'].schema;

	const nodes = body(`${TENANT}/nodes`, 'get');
	expect(nodes.properties.nodes.items.properties.id).toEqual({ type: 'string' });
	expect(nodes.properties.nextCursor.type).toEqual(['string', 'null']);
	expect(Object.keys(body(`${TENANT}/graph`, 'get').properties).sort()).toEqual([
		'links',
		'nodes',
		'truncated',
	]);
	expect(Object.keys(body(`${TENANT}/retrieve`, 'get').items.properties).sort()).toEqual([
		'body',
		'data',
		'depth',
		'id',
		'score',
		'seed',
		'snippet',
		'type',
		'uri',
		'via',
	]);
	expect(Object.keys(body(`${TENANT}/changes`, 'get').properties).sort()).toEqual([
		'edges',
		'nextCursor',
		'nodes',
	]);
});

test('openapi: the SSE route documents its event-stream media type + 501', async () => {
	const op = (await doc()).paths[`${TENANT}/events`].get;
	expect(op.responses['200'].content['text/event-stream'].schema).toEqual({ type: 'string' });
	expect(op.responses['501'].content['application/json'].schema.required).toEqual(['error']);
});

test('openapi: the ops routes are public; the tenant routes require bearer', async () => {
	const paths = (await doc()).paths;
	expect(paths['/health'].get.security).toEqual([]);
	expect(paths['/ready'].get.responses['503']).toBeDefined();
	expect(paths[`${TENANT}/nodes`].post.security).toEqual([{ bearerAuth: [] }]);
});

test('openapi: a wire-validation failure matches the documented 400 body', async () => {
	// The document says 400 is `{ error, issues? }` — so the validator's rejection must be that
	// shape too, not the wrapper's default `{ success, error }`.
	const db = `openapi_${ulid().toLowerCase()}`;
	const { app: a, control, tenant, project } = await createApp({ schema: SCHEMA, db });
	const res = await a.request(`/t/${tenant}/p/${project}/changes?limit=abc`);
	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: string; issues: unknown[] };
	expect(body.error).toBe('validation');
	expect(Array.isArray(body.issues)).toBe(true);

	const schema = (await doc()).paths[`${TENANT}/changes`].get.responses['400'].content[
		'application/json'
	].schema;
	expect(schema.required).toEqual(['error']);
	expect(Object.keys(body).sort()).toEqual(Object.keys(schema.properties).sort());

	control.close();
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
});

test('openapi: every documented operation is one the app actually serves', async () => {
	// The document is generated FROM the route definitions, so drift in the other direction
	// (a served route missing from the document) is impossible by construction. This catches the
	// remaining direction: a documented operation whose route never made it onto the app.
	const { app: a, teardown } = app();
	const live = new Set(
		a.routes
			.filter((r) => ['GET', 'POST', 'PATCH', 'DELETE'].includes(r.method))
			.map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
	);
	for (const [path, item] of Object.entries((await doc()).paths as Record<string, object>)) {
		for (const method of Object.keys(item)) expect(live).toContain(`${method} ${path}`);
	}
	await teardown();
});

test('openapi: every tenant operation is tagged read or write', async () => {
	const d = await doc();
	const offenders: string[] = [];
	for (const [path, item] of Object.entries<any>(d.paths)) {
		if (!path.startsWith('/t/{tenant}')) continue;
		for (const [method, op] of Object.entries<any>(item)) {
			// `/events` is SSE — deliberately unmirrored, so it carries no read/write tag.
			if (path.endsWith('/events')) continue;
			const tags: string[] = op.tags ?? [];
			const tagged = tags.filter((t) => t === 'read' || t === 'write');
			if (tagged.length !== 1) offenders.push(`${method.toUpperCase()} ${path}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('openapi: every mirrored operation has a unique operationId', async () => {
	const d = await doc();
	const ids: string[] = [];
	const missing: string[] = [];
	for (const [path, item] of Object.entries<any>(d.paths)) {
		if (!path.startsWith('/t/{tenant}')) continue;
		for (const [method, op] of Object.entries<any>(item)) {
			// `/events` is SSE — deliberately unmirrored, so it carries no operationId.
			if (path.endsWith('/events')) {
				expect(op.operationId).toBeUndefined();
				continue;
			}
			if (!op.operationId) missing.push(`${method.toUpperCase()} ${path}`);
			else ids.push(op.operationId);
		}
	}
	expect(missing).toEqual([]);
	expect(new Set(ids).size).toBe(ids.length);
	expect(ids).toContain('create_node');
	expect(ids).toContain('neighbors_page');
	expect(ids).toContain('top_nodes');
});

test('openapi: ops routes are not mirrored', async () => {
	const d = await doc();
	expect(d.paths['/health'].get.operationId).toBeUndefined();
	expect(d.paths['/ready'].get.operationId).toBeUndefined();
});

test('openapi: the timeline route is documented as a read', async () => {
	const d = await doc();
	const op = d.paths[`${TENANT}/timeline`].get;
	expect(op.operationId).toBe('timeline');
	expect(op.tags).toContain('read');
});
