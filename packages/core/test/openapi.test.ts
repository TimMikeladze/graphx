import { createClient } from '@libsql/client';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import { buildOpenApiDocument } from '../src/openapi.ts';
import { createApp } from '../src/serve.ts';

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

// The OpenAPI contract is backend-agnostic (routes/schemas are identical on libSQL + Postgres) and
// these tests never query the DB, so they use an in-memory libSQL control on every driver — this
// also dodges the PG harness's lazy ensureSchema firing against a torn-down pool.
function app() {
	const control = createClient({ url: ':memory:' });
	const a = createApp({ control, schema: SCHEMA, authenticate: () => ({ userId: 'u', tenantId: 't' }) });
	return { app: a, teardown: () => control.close() };
}

test('openapi: document shape — 3.1, info, error component, security scheme', () => {
	const doc = buildOpenApiDocument() as any;
	expect(doc.openapi).toBe('3.1.0');
	expect(doc.info.title).toBeDefined();
	expect(doc.components.schemas.Error.required).toEqual(['error']);
	expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
});

test('openapi: POST /nodes requestBody schema is derived from the Zod wire schema', () => {
	const doc = buildOpenApiDocument() as any;
	const op = doc.paths['/t/{tenant}/p/{project}/nodes'].post;
	const schema = op.requestBody.content['application/json'].schema;
	expect(schema.properties.kind).toBeDefined();
	expect(schema.required).toContain('kind');
	expect(schema.required).toContain('props');
});

test('openapi: query params are emitted (GET /changes -> nodes/edges/limit)', () => {
	const doc = buildOpenApiDocument() as any;
	const op = doc.paths['/t/{tenant}/p/{project}/changes'].get;
	const names = (op.parameters as Array<{ name: string }>).map((p) => p.name).sort();
	expect(names).toEqual(['edges', 'limit', 'nodes']);
});

test('openapi: path params + write-only 403', () => {
	const doc = buildOpenApiDocument() as any;
	const item = doc.paths['/t/{tenant}/p/{project}/nodes/{id}'];
	const params = (item.parameters as Array<{ name: string }>).map((p) => p.name);
	expect(params).toEqual(['tenant', 'project', 'id']);
	expect(item.delete.responses['403']).toBeDefined(); // write op
	expect(item.get.responses['403']).toBeUndefined(); // read op
});

test('openapi: served unauthenticated at GET /openapi.json', async () => {
	const { app: a, teardown } = app();
	const res = await a.request('/openapi.json');
	expect(res.status).toBe(200);
	expect((await res.json()).openapi).toBe('3.1.0');
	await teardown();
});

test('openapi: documented paths match the live app routes (no drift)', async () => {
	const { app: a, teardown } = app();
	const live = new Set(
		a.routes.filter(
				(r) => ['GET', 'POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.startsWith('/t/'),
			)
			.map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
	);
	const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
	const documented = new Set<string>();
	for (const [p, item] of Object.entries(doc.paths)) {
		for (const m of Object.keys(item)) {
			if (m !== 'parameters') documented.add(`${m} ${p}`);
		}
	}
	expect(documented).toEqual(live);
	await teardown();
});
