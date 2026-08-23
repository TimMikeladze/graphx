import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { defineGraphSchema } from 'graphx-core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Backend } from '../src/backend.ts';
import { inferSchemaDoc, registerSchema, schemaDoc } from '../src/resources.ts';

const SCHEMA = defineGraphSchema({
	nodes: {
		person: z.object({ name: z.string(), age: z.number().optional() }),
		device: z.object({ kind: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device', single: true },
		knows: { from: 'person', to: 'person' },
	},
});

test('resources: node types become JSON Schema', () => {
	const doc = schemaDoc(SCHEMA);
	expect(Object.keys(doc.nodes).sort()).toEqual(['device', 'person']);
	const person = doc.nodes.person as any;
	expect(person.type).toBe('object');
	expect(Object.keys(person.properties).sort()).toEqual(['age', 'name']);
	expect(person.required).toEqual(['name']);
	expect(doc.inferred).toBeUndefined();
});

test('resources: relations carry their endpoint constraints', () => {
	const doc = schemaDoc(SCHEMA);
	const owns = doc.edges.find((e) => e.rel === 'owns')!;
	expect(owns.from).toBe('person');
	expect(owns.to).toBe('device');
	expect(owns.single).toBe(true);
	const knows = doc.edges.find((e) => e.rel === 'knows')!;
	expect(knows.single).toBeUndefined();
});

/** A Backend that answers one canned response and records the call. */
function stubBackend(res: () => Response): Backend & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		call: (method, path, init) => {
			calls.push(`${method} ${path}?${new URLSearchParams(init?.query).toString()}`);
			return Promise.resolve(res());
		},
	};
}

test('inferSchemaDoc: samples distinct node types off the graph', async () => {
	const backend = stubBackend(() =>
		Response.json({
			nodes: [
				{ id: '1', type: 'person' },
				{ id: '2', type: 'device' },
				{ id: '3', type: 'person' },
				{ id: '4' },
			],
		}),
	);
	const doc = await inferSchemaDoc(backend, 't 1', 'p1');
	expect(doc).not.toBeInstanceOf(Response);
	expect(Object.keys((doc as any).nodes).sort()).toEqual(['device', 'person']);
	// Relations are not derivable from a node listing, and the guess is flagged as one.
	expect((doc as any).edges).toEqual([]);
	expect((doc as any).inferred).toBe(true);
	expect(backend.calls).toEqual(['GET /t/t%201/p/p1/nodes?limit=200']);
});

test('inferSchemaDoc: a non-2xx comes back as the response, not as an empty graph', async () => {
	const backend = stubBackend(() => Response.json({ error: 'project not found' }, { status: 404 }));
	const res = await inferSchemaDoc(backend, 't1', 'nope');
	expect(res).toBeInstanceOf(Response);
	expect((res as Response).status).toBe(404);
});

/** `describe_schema` on a schemaless server, wired to a stub backend. */
async function schemalessClient(backend: Backend) {
	const server = new McpServer({ name: 'test', version: '1.0.0' });
	registerSchema(server, { backend });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test', version: '1.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return {
		client,
		teardown: async () => {
			await client.close();
			await server.close();
		},
	};
}

test('describe_schema: an inference failure is an error result, not "no types"', async () => {
	const h = await schemalessClient(
		stubBackend(() => Response.json({ error: 'project not found' }, { status: 404 })),
	);
	const res: any = await h.client.callTool({
		name: 'describe_schema',
		arguments: { tenant: 't1', project: 'nope' },
	});
	expect(res.isError).toBe(true);
	expect(res.content[0].text).toContain('404');
	expect(res.content[0].text).toContain('project not found');
	await h.teardown();
});

test('describe_schema: an empty graph is a document, and says it was inferred', async () => {
	const h = await schemalessClient(stubBackend(() => Response.json({ nodes: [] })));
	const res: any = await h.client.callTool({
		name: 'describe_schema',
		arguments: { tenant: 't1', project: 'p1' },
	});
	expect(res.isError).toBeFalsy();
	expect(JSON.parse(res.content[0].text)).toEqual({ nodes: {}, edges: [], inferred: true });
	await h.teardown();
});
