import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { hc } from 'hono/client';
import { ulid } from 'ulidx';
import { z } from 'zod';
import {
	addMembership,
	createProject,
	createTenant,
	createUser,
	initControl,
} from '../src/control-plane.ts';
import { evict } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { type AppType, createApp } from '../src/serve.ts';
import { makeTestDb } from './harness.ts';

// P11 — serving (§14, D2). The Hono app reuses the P0.5 control plane + authz to
// route every request to ONE project DB, exposes the SDK over typed routes, and is
// consumed by `hc<AppType>`. Acceptance: a typed client call over HTTP returns typed
// rows, and tenant A can't read tenant B.

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string(), crit: z.number().default(1) }),
		person: z.object({ name: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device', data: z.object({ since: z.number() }) },
		knows: { from: 'person', to: 'person' },
		linked: {}, // unconstrained rel: endpoint-type check is skipped (exercises the FK path)
	},
});

/** dim-768 one-hot embedding (init() defaults to 768). */
function vec(seed: number): number[] {
	const a = Array.from({ length: 768 }, () => 0);
	a[seed % 768] = 1;
	return a;
}

/** Authn reads the principal off headers the tests inject. */
function authenticate(c: { req: { header: (n: string) => string | undefined } }) {
	const userId = c.req.header('x-user');
	const tenantId = c.req.header('x-tenant');
	if (!userId || !tenantId) throw new Error('missing auth');
	return { userId, tenantId };
}

interface Setup {
	control: DbClient;
	app: ReturnType<typeof createApp<typeof SCHEMA>>;
	tenantA: string;
	tenantB: string;
	editor: string;
	viewer: string;
	editorB: string;
	pA: string;
	pB: string;
	nsA: string;
	nsB: string;
}

async function setup(): Promise<Setup> {
	const control = makeTestDb().client;
	await initControl(control);
	const tenantA = await createTenant(control, { name: 'Acme' });
	const tenantB = await createTenant(control, { name: 'Globex' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	const viewer = await createUser(control, { email: `v-${ulid()}@a.test` });
	const editorB = await createUser(control, { email: `e-${ulid()}@b.test` });
	await addMembership(control, { userId: editor, tenantId: tenantA, role: 'editor' });
	await addMembership(control, { userId: viewer, tenantId: tenantA, role: 'viewer' });
	await addMembership(control, { userId: editorB, tenantId: tenantB, role: 'editor' });
	const nsA = `ns_${ulid().toLowerCase()}`;
	const nsB = `ns_${ulid().toLowerCase()}`;
	const pA = await createProject(control, { tenantId: tenantA, name: 'Alpha', dbNamespace: nsA });
	const pB = await createProject(control, { tenantId: tenantB, name: 'Beta', dbNamespace: nsB });
	const app = createApp({ control, schema: SCHEMA, authenticate, embed: async () => vec(3) });
	return { control, app, tenantA, tenantB, editor, viewer, editorB, pA, pB, nsA, nsB };
}

function cleanup(s: Setup): void {
	for (const ns of [s.nsA, s.nsB]) {
		evict(ns);
		for (const sfx of ['', '-wal', '-shm']) rmSync(`${ns}.db${sfx}`, { force: true });
	}
	s.control.close();
}

/** Request headers carrying the test principal. */
function hdr(userId: string, tenantId: string): Record<string, string> {
	return { 'x-user': userId, 'x-tenant': tenantId, 'content-type': 'application/json' };
}

/** POST a node as the given principal; returns the parsed body + status. */
async function postNode(
	s: Setup,
	principal: { user: string; tenant: string },
	project: string,
	body: unknown,
): Promise<{ status: number; json: any }> {
	const res = await s.app.request(`/t/${principal.tenant}/p/${project}/nodes`, {
		method: 'POST',
		headers: hdr(principal.user, principal.tenant),
		body: JSON.stringify(body),
	});
	return { status: res.status, json: await res.json() };
}

test('P11: addNode over HTTP -> 201 with parsed data, then getNode round-trips', async () => {
	const s = await setup();
	const created = await postNode(s, { user: s.editor, tenant: s.tenantA }, s.pA, {
		type: 'device',
		data: { type: 'router' },
	});
	expect(created.status).toBe(201);
	expect(created.json.type).toBe('device');
	expect(created.json.data).toEqual({ type: 'router', crit: 1 }); // default applied
	expect(created.json.id.length).toBe(26);

	const get = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${created.json.id}`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(get.status).toBe(200);
	expect((await get.json()).id).toBe(created.json.id);
	cleanup(s);
});

test('P11: viewer cannot write -> 403', async () => {
	const s = await setup();
	const res = await postNode(s, { user: s.viewer, tenant: s.tenantA }, s.pA, {
		type: 'person',
		data: { name: 'ada' },
	});
	expect(res.status).toBe(403);
	cleanup(s);
});

test('P11: unauthenticated request -> 401', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/x`, {});
	expect(res.status).toBe(401);
	cleanup(s);
});

test('P11 HEADLINE: cross-tenant access is rejected (404, no existence leak)', async () => {
	const s = await setup();
	// principal in tenant A asks for tenant B's project (URL tenant = A, project = pB)
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pB}/nodes/anything`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(404);
	// URL tenant spoofed to B while the token says A -> confused-deputy guard 404
	const spoof = await s.app.request(`/t/${s.tenantB}/p/${s.pB}/nodes/anything`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(spoof.status).toBe(404);
	cleanup(s);
});

test('P11: physical isolation — a node created in tenant B is invisible under tenant A', async () => {
	const s = await setup();
	const inB = await postNode(s, { user: s.editorB, tenant: s.tenantB }, s.pB, {
		type: 'person',
		data: { name: 'bob' },
	});
	expect(inB.status).toBe(201);
	// same id, queried under A's project DB -> different physical DB -> 404
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${inB.json.id}`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(404);
	cleanup(s);
});

test('P11: bad data -> 400 (per-type ZodError mapped)', async () => {
	const s = await setup();
	const res = await postNode(
		s,
		{ user: s.editor, tenant: s.tenantA },
		s.pA,
		{ type: 'device', data: {} }, // missing required `type`
	);
	expect(res.status).toBe(400);
	cleanup(s);
});

test('P11: unknown type -> 400', async () => {
	const s = await setup();
	const res = await postNode(s, { user: s.editor, tenant: s.tenantA }, s.pA, {
		type: 'ghost',
		data: {},
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('P11: edges + neighbors over HTTP (with rel filter)', async () => {
	const s = await setup();
	const me = { user: s.editor, tenant: s.tenantA };
	const p1 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p1' } })).json.id;
	const p2 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p2' } })).json.id;
	const d1 = (await postNode(s, me, s.pA, { type: 'device', data: { type: 'sw' } })).json.id;

	const knows = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'knows', src: p1, dst: p2 }),
	});
	expect(knows.status).toBe(201);
	const owns = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'owns', src: p1, dst: d1, data: { since: 2020 } }),
	});
	expect(owns.status).toBe(201);

	const all = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${p1}/neighbors`, {
		headers: hdr(s.editor, s.tenantA),
	});
	const allRows = await all.json();
	expect(allRows.map((n: { id: string }) => n.id).sort()).toEqual([p2, d1].sort());

	const onlyKnows = await s.app.request(
		`/t/${s.tenantA}/p/${s.pA}/nodes/${p1}/neighbors?rel=knows`,
		{ headers: hdr(s.editor, s.tenantA) },
	);
	const knowsRows = await onlyKnows.json();
	expect(knowsRows.map((n: { id: string }) => n.id)).toEqual([p2]);
	cleanup(s);
});

test('P14: server-set limits cap a read route (not client-overridable)', async () => {
	const s = await setup();
	const me = { user: s.editor, tenant: s.tenantA };
	// a second app over the SAME control plane + project DB, but with a hard maxRows=1.
	const capped = createApp({
		control: s.control,
		schema: SCHEMA,
		authenticate,
		limits: { maxRows: 1 },
	});
	const hub = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'hub' } })).json.id;
	for (const name of ['a', 'b', 'c']) {
		const n = (await postNode(s, me, s.pA, { type: 'person', data: { name } })).json.id;
		await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
			method: 'POST',
			headers: hdr(s.editor, s.tenantA),
			body: JSON.stringify({ rel: 'knows', src: hub, dst: n }),
		});
	}
	const res = await capped.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${hub}/neighbors`, {
		headers: hdr(s.editor, s.tenantA),
	});
	const rows = await res.json();
	expect(rows.length).toBe(1); // 3 neighbors exist, the server cap returns 1
	cleanup(s);
});

test('P11: journey over HTTP returns reached nodes with arrival times', async () => {
	const s = await setup();
	const me = { user: s.editor, tenant: s.tenantA };
	const p1 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p1' } })).json.id;
	const p2 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p2' } })).json.id;
	await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'knows', src: p1, dst: p2 }),
	});

	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/journey`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ start: p1, from: 0 }),
	});
	expect(res.status).toBe(200);
	const rows = await res.json();
	expect(rows.map((r: { id: string }) => r.id)).toContain(p2);
	cleanup(s);
});

test('P11: retrieve over HTTP returns the ANN-seeded subgraph', async () => {
	const s = await setup();
	const me = { user: s.editor, tenant: s.tenantA };
	const seeded = (
		await postNode(s, me, s.pA, { type: 'device', data: { type: 'router' }, emb: vec(3) })
	).json.id;

	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/retrieve?query=hi&k=5`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(200);
	const rows = await res.json();
	expect(rows.length).toBeGreaterThanOrEqual(1);
	expect(rows.map((r: { id: string }) => r.id)).toContain(seeded);
	expect(rows[0]).toHaveProperty('depth');
	cleanup(s);
});

test('P11 HEADLINE: hc<AppType> client round-trips over real HTTP (Bun.serve)', async () => {
	// NOTE: this proves the RUNTIME path (real socket, hc proxy builds the routes, rows
	// come back). It does NOT assert static route typing — `AppType` is env-level under
	// isolatedDeclarations (see serve.ts), and bun does not type-check tests anyway.
	const s = await setup();
	const server = Bun.serve({ port: 0, fetch: s.app.fetch });
	try {
		// hc sets Content-Type itself for `json` bodies; pass auth headers only.
		const client = hc<AppType>(server.url.origin, {
			headers: { 'x-user': s.editor, 'x-tenant': s.tenantA },
		});
		const res = await client.t[':tenant'].p[':project'].nodes.$post({
			param: { tenant: s.tenantA, project: s.pA },
			json: { type: 'device', data: { type: 'router' } },
		});
		expect(res.status).toBe(201);
		const created = await res.json();
		expect(created.id.length).toBe(26);
		expect(created.type).toBe('device');

		const got = await client.t[':tenant'].p[':project'].nodes[':id'].$get({
			param: { tenant: s.tenantA, project: s.pA, id: created.id },
		});
		expect(got.status).toBe(200);
		const node = await got.json();
		expect(node.id).toBe(created.id);
	} finally {
		server.stop(true);
		cleanup(s);
	}
});

test('P11: viewer (read role) can GET a node -> 200 (read-side authz)', async () => {
	const s = await setup();
	const created = await postNode(s, { user: s.editor, tenant: s.tenantA }, s.pA, {
		type: 'person',
		data: { name: 'ada' },
	});
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${created.json.id}`, {
		headers: hdr(s.viewer, s.tenantA),
	});
	expect(res.status).toBe(200);
	expect((await res.json()).id).toBe(created.json.id);
	cleanup(s);
});

test('P11: edge to a non-existent endpoint (FK violation) -> 400, not 500', async () => {
	const s = await setup();
	// `linked` is unconstrained, so the endpoint-type check is skipped and the dangling
	// src/dst reach the FK to node_identity — must surface as a client error, not a 500.
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'linked', src: ulid(), dst: ulid() }),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('P11: negative edge weight -> 400 (wire schema rejects before the DB CHECK)', async () => {
	const s = await setup();
	const me = { user: s.editor, tenant: s.tenantA };
	const p1 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p1' } })).json.id;
	const p2 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p2' } })).json.id;
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'knows', src: p1, dst: p2, weight: -5 }),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('P11: unknown rel -> 400 (addEdge prefix mapping)', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'nope', src: ulid(), dst: ulid() }),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('P11: endpoint-type mismatch -> 400 (addEdge prefix mapping)', async () => {
	const s = await setup();
	const me = { user: s.editor, tenant: s.tenantA };
	const dev = (await postNode(s, me, s.pA, { type: 'device', data: { type: 'sw' } })).json.id;
	const per = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p' } })).json.id;
	// `knows` requires person -> person; a device src violates `from`.
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'knows', src: dev, dst: per }),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('P11: neighbors direction=reverse and =both over HTTP', async () => {
	const s = await setup();
	const me = { user: s.editor, tenant: s.tenantA };
	const p1 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p1' } })).json.id;
	const p2 = (await postNode(s, me, s.pA, { type: 'person', data: { name: 'p2' } })).json.id;
	await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rel: 'knows', src: p1, dst: p2 }),
	});
	// reverse neighbors of p2 = its in-edge source p1
	const rev = await s.app.request(
		`/t/${s.tenantA}/p/${s.pA}/nodes/${p2}/neighbors?direction=reverse`,
		{ headers: hdr(s.editor, s.tenantA) },
	);
	expect((await rev.json()).map((n: { id: string }) => n.id)).toEqual([p1]);
	// both = union; p2's only incident edge is the in-edge from p1
	const both = await s.app.request(
		`/t/${s.tenantA}/p/${s.pA}/nodes/${p2}/neighbors?direction=both`,
		{ headers: hdr(s.editor, s.tenantA) },
	);
	expect((await both.json()).map((n: { id: string }) => n.id)).toEqual([p1]);
	cleanup(s);
});

test('P11: retrieve without an embed fn -> 501', async () => {
	const s = await setup();
	const noEmbed = createApp({ control: s.control, schema: SCHEMA, authenticate });
	const res = await noEmbed.request(`/t/${s.tenantA}/p/${s.pA}/retrieve?query=hi`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(501);
	cleanup(s);
});

test('P11: list_projects returns the caller tenant projects, without db namespaces', async () => {
	const s = await setup();

	const res = await s.app.request(`/t/${s.tenantA}/projects`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { projects: Array<Record<string, unknown>> };
	expect(body.projects.map((p) => p.id)).toContain(s.pA);
	// Tenant isolation: tenant B's project must not appear.
	expect(body.projects.map((p) => p.id)).not.toContain(s.pB);
	// §2.9 — the sqld namespace is internal routing detail and never crosses the wire.
	for (const p of body.projects) expect(p.dbNamespace).toBeUndefined();

	// Confused-deputy guard: a route tenant that isn't the principal's is 404, not 403,
	// so cross-tenant existence doesn't leak.
	const cross = await s.app.request(`/t/${s.tenantB}/projects`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(cross.status).toBe(404);

	// A principal with no membership row in the tenant is 403.
	const stranger = await createUser(s.control, { email: `x-${ulid()}@a.test` });
	const noMem = await s.app.request(`/t/${s.tenantA}/projects`, {
		headers: hdr(stranger, s.tenantA),
	});
	expect(noMem.status).toBe(403);

	cleanup(s);
});

test('P11: get_schema serves the declared node types and rels as JSON Schema', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/schema`, {
		headers: hdr(s.viewer, s.tenantA), // read scope: a viewer may read the shape
	});
	expect(res.status).toBe(200);
	const doc = (await res.json()) as {
		nodes: Array<{ type: string; jsonSchema: Record<string, unknown> }>;
		edges: Array<{
			rel: string;
			from: string[] | null;
			to: string[] | null;
			single: boolean;
			jsonSchema: Record<string, unknown> | null;
		}>;
	};

	expect(doc.nodes.map((n) => n.type).sort()).toEqual(['device', 'person']);
	const person = doc.nodes.find((n) => n.type === 'person');
	expect(person?.jsonSchema.type).toBe('object');
	expect(Object.keys(person?.jsonSchema.properties as object)).toEqual(['name']);
	expect(person?.jsonSchema.required).toEqual(['name']);
	// A field with a default is not required on input — that is the whole reason for `io: input`.
	const device = doc.nodes.find((n) => n.type === 'device');
	expect(device?.jsonSchema.required).toEqual(['type']);
	const deviceProps = device?.jsonSchema.properties as Record<string, { default?: unknown }>;
	expect(deviceProps.crit.default).toBe(1);

	const owns = doc.edges.find((e) => e.rel === 'owns');
	expect(owns?.from).toEqual(['person']);
	expect(owns?.to).toEqual(['device']);
	expect(owns?.single).toBe(false);
	expect(Object.keys(owns?.jsonSchema?.properties as object)).toEqual(['since']);
	// An unconstrained rel carries neither endpoint types nor a data schema.
	const linked = doc.edges.find((e) => e.rel === 'linked');
	expect(linked?.from).toBeNull();
	expect(linked?.to).toBeNull();
	expect(linked?.jsonSchema).toBeNull();

	cleanup(s);
});

test('P11: get_schema is tenant-scoped like every other project route', async () => {
	const s = await setup();
	const cross = await s.app.request(`/t/${s.tenantA}/p/${s.pB}/schema`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(cross.status).toBe(404);
	const anon = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/schema`, {});
	expect(anon.status).toBe(401);
	cleanup(s);
});

test('P11: get_schema degrades a type zod cannot describe instead of failing the document', async () => {
	const s = await setup();
	// `z.custom` has no JSON Schema representation. The document must still serve — the client
	// falls back to free-form JSON for that one type — and the types around it stay intact.
	const opaque = defineGraphSchema({
		nodes: {
			person: z.object({ name: z.string() }),
			blob: z.custom<Record<string, unknown>>(() => true) as unknown as ReturnType<
				typeof z.object<{ [k: string]: never }>
			>,
		},
		edges: {},
	});
	const app = createApp({ control: s.control, schema: opaque, authenticate });
	const res = await app.request(`/t/${s.tenantA}/p/${s.pA}/schema`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(200);
	const doc = (await res.json()) as {
		nodes: Array<{ type: string; jsonSchema: Record<string, unknown> }>;
	};
	expect(doc.nodes.map((n) => n.type).sort()).toEqual(['blob', 'person']);
	// No declared properties -> the admin editor drops to a raw JSON field for this type.
	expect(doc.nodes.find((n) => n.type === 'blob')?.jsonSchema.properties).toBeUndefined();
	expect(doc.nodes.find((n) => n.type === 'person')?.jsonSchema.properties).toBeDefined();
	cleanup(s);
});
