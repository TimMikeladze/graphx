import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import {
	addMembership,
	createProject,
	createTenant,
	createUser,
	initControl,
} from '../../src/core/control-plane.ts';
import { evict } from '../../src/core/db.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import { createApp } from '../../src/core/serve.ts';
import { makeTestDb } from './harness.ts';

// GraphQL (docs/graphql.md): a schema generated from the app's own OpenAPI document, each field
// dispatched in-process to its REST route with the caller's headers.

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

function cleanup(control: { close: () => void }, db: string): void {
	control.close();
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
}

async function gql(
	app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
	query: string,
	variables: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) {
	const res = await app.request('/graphql', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ query, variables }),
	});
	// biome-ignore lint/suspicious/noExplicitAny: GraphQL response bodies are untyped here.
	return { status: res.status, body: (await res.json()) as any };
}

test('graphql: queries and mutations run through the REST routes', async () => {
	const db = `gql_${ulid().toLowerCase()}`;
	const { app, control, tenant, project } = await createApp({ schema: SCHEMA, db, graphql: true });
	const vars = { tenant, project };

	const created = await gql(
		app,
		`mutation ($tenant: String!, $project: String!, $input: CreateNodeBodyInput!) {
			createNode(tenant: $tenant, project: $project, input: $input) { id type data }
		}`,
		{ ...vars, input: { type: 'person', data: { name: 'ada' } } },
	);
	expect(created.body.errors).toBeUndefined();
	const id = created.body.data.createNode.id;
	expect(created.body.data.createNode).toMatchObject({ type: 'person', data: { name: 'ada' } });

	const read = await gql(
		app,
		`query ($tenant: String!, $project: String!, $id: String!) {
			getNode(tenant: $tenant, project: $project, id: $id) { id data }
			listNodes(tenant: $tenant, project: $project, type: "person") { nodes { id } nextCursor }
		}`,
		{ ...vars, id },
	);
	expect(read.body.errors).toBeUndefined();
	expect(read.body.data.getNode).toEqual({ id, data: { name: 'ada' } });
	expect(read.body.data.listNodes.nodes).toEqual([{ id }]);
	cleanup(control, db);
});

test('graphql: a route error becomes a GraphQL error carrying the status and body', async () => {
	const db = `gql_${ulid().toLowerCase()}`;
	const { app, control, tenant, project } = await createApp({ schema: SCHEMA, db, graphql: true });
	const res = await gql(
		app,
		`mutation ($tenant: String!, $project: String!, $input: CreateNodeBodyInput!) {
			createNode(tenant: $tenant, project: $project, input: $input) { id }
		}`,
		{ tenant, project, input: { type: 'person', data: { name: 42 } } },
	);
	expect(res.body.data.createNode).toBeNull();
	expect(res.body.errors[0].extensions).toMatchObject({ status: 400, operationId: 'create_node' });
	cleanup(control, db);
});

test('graphql: the caller headers reach authenticate, so authz is the route’s', async () => {
	const control = makeTestDb().client;
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const other = await createTenant(control, { name: 'Globex' });
	const user = await createUser(control, { email: `u-${ulid()}@a.test` });
	await addMembership(control, { userId: user, tenantId: tenant, role: 'viewer' });
	const ns = `gql_${ulid().toLowerCase()}`;
	const project = await createProject(control, { tenantId: tenant, name: 'A', dbNamespace: ns });
	const app = createApp({
		control,
		schema: SCHEMA,
		graphql: true,
		authenticate: (c) => {
			const auth = c.req.header('authorization');
			if (!auth) throw new Error('missing auth');
			return { userId: auth.replace('Bearer ', ''), tenantId: tenant };
		},
	});
	const query = `query ($tenant: String!, $project: String!) {
		listNodes(tenant: $tenant, project: $project) { nodes { id } }
	}`;

	const ok = await gql(app, query, { tenant, project }, { authorization: `Bearer ${user}` });
	expect(ok.body.errors).toBeUndefined();
	expect(ok.body.data.listNodes.nodes).toEqual([]);

	const anon = await gql(app, query, { tenant, project });
	expect(anon.body.errors[0].extensions.status).toBe(401);

	// A viewer may read but not write; the route's authz, not a GraphQL-side copy, says so.
	const write = await gql(
		app,
		`mutation ($tenant: String!, $project: String!) {
			createNode(tenant: $tenant, project: $project, input: { type: "person", data: { name: "x" } }) { id }
		}`,
		{ tenant, project },
		{ authorization: `Bearer ${user}` },
	);
	expect(write.body.errors[0].extensions.status).toBe(403);

	const crossTenant = await gql(
		app,
		query,
		{ tenant: other, project },
		{ authorization: `Bearer ${user}` },
	);
	expect(crossTenant.body.errors[0].extensions.status).toBeGreaterThanOrEqual(400);
	control.close();
	evict(ns);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${ns}.db${sfx}`, { force: true });
});

test('graphql: off by default, and routes without an operationId are not fields', async () => {
	const db = `gql_${ulid().toLowerCase()}`;
	const off = await createApp({ schema: SCHEMA, db });
	expect((await off.app.request('/graphql', { method: 'POST' })).status).toBe(404);
	cleanup(off.control, db);

	const db2 = `gql_${ulid().toLowerCase()}`;
	const { app, control } = await createApp({ schema: SCHEMA, db: db2, graphql: { path: '/gql' } });
	const res = await app.request('/gql', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: '{ __schema { queryType { fields { name } } } }' }),
	});
	const names = (
		(await res.json()) as { data: { __schema: { queryType: { fields: { name: string }[] } } } }
	).data.__schema.queryType.fields.map((f) => f.name);
	expect(names).toContain('getNode');
	expect(names).not.toContain('getHealth');
	expect(names.some((n) => /events/i.test(n))).toBe(false);
	cleanup(control, db2);
});
