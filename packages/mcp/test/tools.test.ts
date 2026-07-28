import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { expect, test } from 'bun:test';
import { buildCall, toolsFrom } from '../src/tools.ts';

/** A miniature app carrying the same declaration shapes serve.ts uses. */
function fixtureApp() {
	const app = new OpenAPIHono();
	const scope = z.object({ tenant: z.string(), project: z.string() });
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/nodes',
			operationId: 'list_nodes',
			tags: ['read'],
			summary: 'List nodes',
			request: { params: scope, query: z.object({ limit: z.coerce.number().optional() }) },
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.json({}, 200),
	);
	app.openapi(
		createRoute({
			method: 'post',
			path: '/t/{tenant}/p/{project}/nodes',
			operationId: 'create_node',
			tags: ['write'],
			summary: 'Create a node',
			request: {
				params: scope,
				body: {
					required: true,
					content: {
						'application/json': {
							schema: z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }),
						},
					},
				},
			},
			responses: { 201: { description: 'created' } },
		}),
		(c) => c.json({}, 201),
	);
	app.openapi(
		createRoute({
			method: 'delete',
			path: '/t/{tenant}/p/{project}/nodes/{id}',
			operationId: 'delete_node',
			tags: ['write'],
			summary: 'Retract a node',
			request: { params: scope.extend({ id: z.string() }) },
			responses: { 204: { description: 'no content' } },
		}),
		(c) => c.body(null, 204),
	);
	// No operationId — the opt-out. Must not be mirrored.
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/events',
			summary: 'SSE stream',
			request: { params: scope },
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.body(null, 200),
	);
	return app;
}

test('tools: mirrors only routes carrying an operationId', () => {
	const tools = toolsFrom(fixtureApp());
	expect(tools.map((t) => t.name).sort()).toEqual(['create_node', 'delete_node', 'list_nodes']);
});

test('tools: merges path, query and body into one flat input shape', () => {
	const tools = toolsFrom(fixtureApp());
	const list = tools.find((t) => t.name === 'list_nodes')!;
	expect(Object.keys(list.inputShape).sort()).toEqual(['limit', 'project', 'tenant']);
	expect(list.pathFields.sort()).toEqual(['project', 'tenant']);
	expect(list.queryFields).toEqual(['limit']);
	expect(list.bodyFields).toEqual([]);

	const create = tools.find((t) => t.name === 'create_node')!;
	expect(Object.keys(create.inputShape).sort()).toEqual(['data', 'project', 'tenant', 'type']);
	expect(create.bodyFields.sort()).toEqual(['data', 'type']);
});

test('tools: annotations come off the tag, with the destructive exceptions', () => {
	const tools = toolsFrom(fixtureApp());
	const byName = new Map(tools.map((t) => [t.name, t]));
	expect(byName.get('list_nodes')!.readOnly).toBe(true);
	expect(byName.get('list_nodes')!.annotations).toEqual({ readOnlyHint: true });
	expect(byName.get('create_node')!.annotations).toEqual({ destructiveHint: false });
	expect(byName.get('delete_node')!.annotations).toEqual({ destructiveHint: true });
});

test('tools: an untagged route is a build-time error, not a silent default', () => {
	const app = new OpenAPIHono();
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/oops',
			operationId: 'oops',
			request: { params: z.object({ tenant: z.string(), project: z.string() }) },
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.json({}, 200),
	);
	expect(() => toolsFrom(app)).toThrow(/oops/);
});

test('tools: a field name colliding across sources is a build-time error', () => {
	const app = new OpenAPIHono();
	app.openapi(
		createRoute({
			method: 'get',
			path: '/t/{tenant}/p/{project}/clash',
			operationId: 'clash',
			tags: ['read'],
			request: {
				params: z.object({ tenant: z.string(), project: z.string() }),
				query: z.object({ tenant: z.string() }),
			},
			responses: { 200: { description: 'ok' } },
		}),
		(c) => c.json({}, 200),
	);
	expect(() => toolsFrom(app)).toThrow(/tenant/);
});

test('buildCall: routes each argument to its source', () => {
	const tools = toolsFrom(fixtureApp());
	const list = tools.find((t) => t.name === 'list_nodes')!;
	expect(buildCall(list, { tenant: 't1', project: 'p1', limit: 5 })).toEqual({
		method: 'GET',
		path: '/t/t1/p/p1/nodes',
		init: { query: { limit: '5' }, body: undefined },
	});

	const create = tools.find((t) => t.name === 'create_node')!;
	expect(
		buildCall(create, { tenant: 't1', project: 'p1', type: 'person', data: { name: 'a' } }),
	).toEqual({
		method: 'POST',
		path: '/t/t1/p/p1/nodes',
		init: { query: {}, body: { type: 'person', data: { name: 'a' } } },
	});
});

test('buildCall: omits undefined query fields and url-encodes path values', () => {
	const tools = toolsFrom(fixtureApp());
	const list = tools.find((t) => t.name === 'list_nodes')!;
	const call = buildCall(list, { tenant: 't/1', project: 'p1' });
	expect(call.path).toBe('/t/t%2F1/p/p1/nodes');
	expect(call.init.query).toEqual({});
});
