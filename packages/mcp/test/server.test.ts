import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createApp, defineGraphSchema, hashEmbed } from '@graphx/core';
import { localBackend } from '../src/backend.ts';
import { createGraphxMcp } from '../src/server.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string() }),
		device: z.object({ kind: z.string() }),
	},
	edges: { owns: { from: 'person', to: 'device' } },
});

/** A dev app + an MCP client wired to it over an in-memory transport pair. */
async function harness(opts: { readOnly?: boolean } = {}) {
	const db = `mcp_test_${crypto.randomUUID().replaceAll('-', '')}`;
	const dev = await createApp({
		schema: SCHEMA,
		db,
		embed: hashEmbed(),
		seed: async (g) => {
			await g.addNode({ type: 'person', data: { name: 'ada' } });
		},
	});
	const backend = localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant });
	const server = createGraphxMcp({
		app: dev.app,
		backend,
		readOnly: opts.readOnly,
		schema: SCHEMA,
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test', version: '1.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		tenant: dev.tenant,
		project: dev.project,
		teardown: async () => {
			await client.close();
			await server.close();
		},
	};
}

/** The JSON payload of a tool result, or throw with the error text. */
function payload(res: any): any {
	if (res.isError) throw new Error(`tool error: ${res.content[0]?.text}`);
	return JSON.parse(res.content[0].text);
}

test('server: exposes one tool per mirrored route, with annotations', async () => {
	const h = await harness();
	const { tools } = await h.client.listTools();
	const names = new Set(tools.map((t) => t.name));

	expect(names.has('list_nodes')).toBe(true);
	expect(names.has('create_node')).toBe(true);
	expect(names.has('list_projects')).toBe(true);
	// SSE is deliberately unmirrored.
	expect(names.has('events')).toBe(false);

	const list = tools.find((t) => t.name === 'list_nodes')!;
	expect(list.annotations?.readOnlyHint).toBe(true);
	expect(list.inputSchema.required).toEqual(expect.arrayContaining(['tenant', 'project']));

	const del = tools.find((t) => t.name === 'delete_node')!;
	expect(del.annotations?.destructiveHint).toBe(true);

	await h.teardown();
});

test('server: a read tool returns the same payload as the HTTP route', async () => {
	const h = await harness();
	const res = await h.client.callTool({
		name: 'list_nodes',
		arguments: { tenant: h.tenant, project: h.project },
	});
	const body = payload(res);
	expect(body.nodes.map((n: any) => n.data.name)).toContain('ada');
	await h.teardown();
});

test('server: a write tool round-trips through a read tool', async () => {
	const h = await harness();
	const created = payload(
		await h.client.callTool({
			name: 'create_node',
			arguments: { tenant: h.tenant, project: h.project, type: 'device', data: { kind: 'sensor' } },
		}),
	);
	expect(created.id).toBeString();

	const fetched = payload(
		await h.client.callTool({
			name: 'get_node',
			arguments: { tenant: h.tenant, project: h.project, id: created.id },
		}),
	);
	expect(fetched.data.kind).toBe('sensor');
	await h.teardown();
});

test('server: a 204 route reports ok rather than an empty body', async () => {
	const h = await harness();
	const created = payload(
		await h.client.callTool({
			name: 'create_node',
			arguments: { tenant: h.tenant, project: h.project, type: 'device', data: { kind: 'gone' } },
		}),
	);
	const res: any = await h.client.callTool({
		name: 'delete_node',
		arguments: { tenant: h.tenant, project: h.project, id: created.id },
	});
	expect(res.isError).toBeFalsy();
	expect(res.structuredContent).toEqual({ ok: true });
	await h.teardown();
});

test('server: a failing route becomes isError, not a thrown transport error', async () => {
	const h = await harness();
	const res: any = await h.client.callTool({
		name: 'get_node',
		arguments: { tenant: h.tenant, project: h.project, id: 'nope' },
	});
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain('404');
	await h.teardown();
});

test('server: read-only mode drops every write tool', async () => {
	const h = await harness({ readOnly: true });
	const { tools } = await h.client.listTools();
	const names = tools.map((t) => t.name);

	for (const write of [
		'create_node',
		'create_edge',
		'update_node',
		'delete_node',
		'delete_edge',
		'bulk_load',
		'pagerank',
		'community',
		'centrality',
	]) {
		expect(names).not.toContain(write);
	}
	expect(names).toContain('list_nodes');
	expect(
		tools.every((t) => t.annotations?.readOnlyHint === true || t.name === 'describe_schema'),
	).toBe(true);
	await h.teardown();
});

test('server: list_projects reaches the tenant-scoped route', async () => {
	const h = await harness();
	const body = payload(
		await h.client.callTool({ name: 'list_projects', arguments: { tenant: h.tenant } }),
	);
	expect(body.projects.map((p: any) => p.id)).toContain(h.project);
	await h.teardown();
});

test('server: exposes the schema as a resource and as a tool', async () => {
	const h = await harness();

	const listed = await h.client.listResources();
	expect(listed.resources.map((r) => r.uri)).toContain('graphx://schema');

	const read = await h.client.readResource({ uri: 'graphx://schema' });
	const doc = JSON.parse(read.contents[0].text as string);
	expect(Object.keys(doc.nodes).sort()).toEqual(['device', 'person']);
	expect(doc.edges.map((e: any) => e.rel)).toContain('owns');

	const viaTool = payload(
		await h.client.callTool({
			name: 'describe_schema',
			arguments: { tenant: h.tenant, project: h.project },
		}),
	);
	expect(viaTool).toEqual(doc);

	await h.teardown();
});

test('server: mounts on a Hono app and answers an MCP initialize', async () => {
	const { Hono } = await import('hono');
	const { createMcpApp } = await import('../src/index.ts');

	const db = `mcp_mount_${crypto.randomUUID().replaceAll('-', '')}`;
	const dev = await createApp({ schema: SCHEMA, db, embed: hashEmbed() });
	const host = new Hono();
	host.route(
		'/mcp',
		createMcpApp({
			app: dev.app,
			backend: localBackend(dev.app, { 'x-user': dev.user, 'x-tenant': dev.tenant }),
			schema: SCHEMA,
		}),
	);

	const res = await host.request('/mcp', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1.0.0' },
			},
		}),
	});
	expect(res.status).toBe(200);
	const text = await res.text();
	expect(text).toContain('serverInfo');
	expect(text).toContain('graphx');
});
