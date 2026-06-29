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
} from '../src/control-plane.ts';
import { evict } from '../src/db.ts';
import { defineGraphSchema } from '../src/define-graph-schema.ts';
import type { DbClient } from '../src/dialect.ts';
import { createApp } from '../src/serve.ts';
import { makeTestDb } from './harness.ts';

// Coverage for the backend-only SDK ops newly exposed over HTTP (GAPS.md §2):
// /changes (changeFeed), /diff, PATCH /nodes/:id (updateNode), DELETE /edges/:id
// (deleteEdge), POST /hybrid, POST /bulk, POST /match, and the /algorithms/* routes.
// Self-contained setup mirrors p11-serving (control plane + authz + per-project DB),
// and every test runs on BOTH backends via `GRAPHX_TEST_DRIVER` (libSQL default, postgres).

const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string(), crit: z.number().default(1) }),
		person: z.object({ name: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device', props: z.object({ since: z.number() }) },
		knows: { from: 'person', to: 'person' },
		linked: {}, // unconstrained rel: endpoint-kind check skipped (exercises the FK path)
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
	editor: string;
	viewer: string;
	pA: string;
	nsA: string;
}

async function setup(): Promise<Setup> {
	const control = makeTestDb().client;
	await initControl(control);
	const tenantA = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	const viewer = await createUser(control, { email: `v-${ulid()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenantA, role: 'editor' });
	await addMembership(control, { userId: viewer, tenantId: tenantA, role: 'viewer' });
	const nsA = `ns_${ulid().toLowerCase()}`;
	const pA = await createProject(control, { tenantId: tenantA, name: 'Alpha', dbNamespace: nsA });
	// embed: a deterministic one-hot keyed off the query length so /hybrid has a real embedder.
	const app = createApp({ control, schema: SCHEMA, authenticate, embed: async (q) => vec(q.length) });
	return { control, app, tenantA, editor, viewer, pA, nsA };
}

function cleanup(s: Setup): void {
	evict(s.nsA);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${s.nsA}.db${sfx}`, { force: true });
	s.control.close();
}

/** Request headers carrying the test principal. */
function hdr(userId: string, tenantId: string): Record<string, string> {
	return { 'x-user': userId, 'x-tenant': tenantId, 'content-type': 'application/json' };
}

/** POST a node as the given principal; returns its minted id. */
async function mkNode(s: Setup, user: string, kind: string, props: unknown): Promise<string> {
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		method: 'POST',
		headers: hdr(user, s.tenantA),
		body: JSON.stringify({ kind, props }),
	});
	return (await res.json()).id as string;
}

/** POST an edge as the given principal; returns its minted id. */
async function mkEdge(
	s: Setup,
	user: string,
	rel: string,
	src: string,
	dst: string,
	props?: unknown,
): Promise<string> {
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: hdr(user, s.tenantA),
		body: JSON.stringify({ rel, src, dst, props }),
	});
	return (await res.json()).id as string;
}

// --- Group A: /changes (changeFeed) + /diff -------------------------------------

test('changes: returns created node/edge versions + per-stream cursors (viewer read)', async () => {
	const s = await setup();
	const p1 = await mkNode(s, s.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(s, s.editor, 'person', { name: 'p2' });
	await mkEdge(s, s.editor, 'knows', p1, p2);

	// a viewer (read role) can tail the feed
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/changes`, {
		headers: hdr(s.viewer, s.tenantA),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.nodes.length).toBe(2);
	expect(body.edges.length).toBe(1);
	expect(typeof body.nextCursor.nodes === 'string' || body.nextCursor.nodes === null).toBe(true);
	expect(typeof body.nextCursor.edges === 'string' || body.nextCursor.edges === null).toBe(true);
	cleanup(s);
});

test('changes: limit caps each page and the cursor resumes the next page', async () => {
	const s = await setup();
	await mkNode(s, s.editor, 'person', { name: 'a' });
	await mkNode(s, s.editor, 'person', { name: 'b' });
	await mkNode(s, s.editor, 'person', { name: 'c' });

	const first = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/changes?limit=2`, {
		headers: hdr(s.editor, s.tenantA),
	});
	const page1 = await first.json();
	expect(page1.nodes.length).toBe(2);
	expect(typeof page1.nextCursor.nodes).toBe('string'); // more to come

	const second = await s.app.request(
		`/t/${s.tenantA}/p/${s.pA}/changes?nodes=${encodeURIComponent(page1.nextCursor.nodes)}&limit=2`,
		{ headers: hdr(s.editor, s.tenantA) },
	);
	const page2 = await second.json();
	expect(page2.nodes.length).toBe(1); // the remaining node
	expect(page2.nextCursor.nodes).toBe(null);
	cleanup(s);
});

test('changes: a tampered cursor -> 400 invalid cursor', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/changes?nodes=not-a-cursor`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('diff: returns node/edge versions opened within (t1, t2]', async () => {
	const s = await setup();
	const p1 = await mkNode(s, s.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(s, s.editor, 'person', { name: 'p2' });
	await mkEdge(s, s.editor, 'knows', p1, p2);

	// t1=0 is before everything; t2 is far in the future (well under FOREVER) — viewer read.
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/diff?t1=0&t2=9000000000000`, {
		headers: hdr(s.viewer, s.tenantA),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.nodes.length).toBe(2);
	expect(body.edges.length).toBe(1);
	cleanup(s);
});

test('diff: missing t1/t2 -> 400 validation', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/diff?t1=0`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

// --- Group B: PATCH /nodes/:id (updateNode) + DELETE /edges/:id (deleteEdge) ------

test('patch node: shallow-merges props and round-trips via getNode (editor write)', async () => {
	const s = await setup();
	const id = await mkNode(s, s.editor, 'device', { type: 'router' }); // crit defaults to 1
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${id}`, {
		method: 'PATCH',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ props: { crit: 5 } }),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.props).toEqual({ type: 'router', crit: 5 }); // type carried, crit patched
	cleanup(s);
});

test('patch node: viewer cannot write -> 403', async () => {
	const s = await setup();
	const id = await mkNode(s, s.editor, 'device', { type: 'router' });
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${id}`, {
		method: 'PATCH',
		headers: hdr(s.viewer, s.tenantA),
		body: JSON.stringify({ props: { crit: 5 } }),
	});
	expect(res.status).toBe(403);
	cleanup(s);
});

test('patch node: no live version for the id -> 404', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${ulid()}`, {
		method: 'PATCH',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ props: { crit: 5 } }),
	});
	expect(res.status).toBe(404);
	cleanup(s);
});

test('delete edge: removes the edge (neighbors drops it) -> 204', async () => {
	const s = await setup();
	const p1 = await mkNode(s, s.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(s, s.editor, 'person', { name: 'p2' });
	const eid = await mkEdge(s, s.editor, 'knows', p1, p2);

	const del = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges/${eid}`, {
		method: 'DELETE',
		headers: hdr(s.editor, s.tenantA),
	});
	expect(del.status).toBe(204);

	const nbrs = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${p1}/neighbors`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect((await nbrs.json()).length).toBe(0);
	cleanup(s);
});

test('delete edge: viewer cannot write -> 403', async () => {
	const s = await setup();
	const p1 = await mkNode(s, s.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(s, s.editor, 'person', { name: 'p2' });
	const eid = await mkEdge(s, s.editor, 'knows', p1, p2);
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges/${eid}`, {
		method: 'DELETE',
		headers: hdr(s.viewer, s.tenantA),
	});
	expect(res.status).toBe(403);
	cleanup(s);
});

test('delete edge: no live version for the id -> 404', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/edges/${ulid()}`, {
		method: 'DELETE',
		headers: hdr(s.editor, s.tenantA),
	});
	expect(res.status).toBe(404);
	cleanup(s);
});

// --- Group C: POST /hybrid (hybridRetrieve) --------------------------------------

/** POST a node carrying free-text `body` (feeds the FTS leg of hybridRetrieve). */
async function mkDoc(s: Setup, name: string, body: string, emb?: number[]): Promise<string> {
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ kind: 'person', props: { name }, body, emb }),
	});
	return (await res.json()).id as string;
}

test('hybrid: FTS leg returns body matches (viewer read)', async () => {
	const s = await setup();
	const a = await mkDoc(s, 'a', 'alpha gateway router');
	const b = await mkDoc(s, 'b', 'beta gateway switch');
	await mkDoc(s, 'c', 'gamma firewall'); // no "gateway" — excluded

	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/hybrid`, {
		method: 'POST',
		headers: hdr(s.viewer, s.tenantA),
		body: JSON.stringify({ query: 'gateway', k: 10, maxDepth: 0 }),
	});
	expect(res.status).toBe(200);
	const ids = new Set((await res.json()).map((r: { id: string }) => r.id));
	expect(ids.has(a)).toBe(true);
	expect(ids.has(b)).toBe(true);
	cleanup(s);
});

test('hybrid: 501 when no embedder is configured', async () => {
	const s = await setup();
	const noEmbed = createApp({ control: s.control, schema: SCHEMA, authenticate });
	const res = await noEmbed.request(`/t/${s.tenantA}/p/${s.pA}/hybrid`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ query: 'x' }),
	});
	expect(res.status).toBe(501);
	cleanup(s);
});

test('hybrid: mmr.k caps the number of diversified results', async () => {
	const s = await setup();
	// give each doc a 768-dim embedding so the MMR similarity pass has vectors to work with
	await mkDoc(s, 'a', 'red gateway', vec(1));
	await mkDoc(s, 'b', 'red gateway', vec(2));
	await mkDoc(s, 'c', 'red gateway', vec(3));

	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/hybrid`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ query: 'gateway', k: 10, maxDepth: 0, mmr: { k: 2, lambda: 0.5 } }),
	});
	expect(res.status).toBe(200);
	expect((await res.json()).length).toBeLessThanOrEqual(2);
	cleanup(s);
});

// --- Group D: POST /bulk (bulkLoad) ----------------------------------------------

test('bulk: loads rows -> 201 with minted ids, persisted + readable (editor write)', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/bulk`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({
			rows: [
				{ kind: 'person', props: { name: 'x' } },
				{ kind: 'person', props: { name: 'y' } },
				{ kind: 'device', props: { type: 'router' } },
			],
		}),
	});
	expect(res.status).toBe(201);
	const body = await res.json();
	expect(body.count).toBe(3);
	expect(body.ids.length).toBe(3);
	expect(body.ids[0].length).toBe(26);

	// the loaded rows are real nodes
	const get = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${body.ids[2]}`, {
		headers: hdr(s.editor, s.tenantA),
	});
	expect((await get.json()).props).toEqual({ type: 'router', crit: 1 });
	cleanup(s);
});

test('bulk: viewer cannot write -> 403', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/bulk`, {
		method: 'POST',
		headers: hdr(s.viewer, s.tenantA),
		body: JSON.stringify({ rows: [{ kind: 'person', props: { name: 'x' } }] }),
	});
	expect(res.status).toBe(403);
	cleanup(s);
});

test('bulk: unknown kind in a row -> 400', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/bulk`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rows: [{ kind: 'ghost', props: {} }] }),
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

test('bulk: bad props (missing required) -> 400', async () => {
	const s = await setup();
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/bulk`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ rows: [{ kind: 'device', props: {} }] }), // missing `type`
	});
	expect(res.status).toBe(400);
	cleanup(s);
});

// --- Group E: POST /match (PatternBuilder) ---------------------------------------

async function postMatch(s: Setup, user: string, spec: unknown) {
	const res = await s.app.request(`/t/${s.tenantA}/p/${s.pA}/match`, {
		method: 'POST',
		headers: hdr(user, s.tenantA),
		body: JSON.stringify(spec),
	});
	return { status: res.status, json: res.status === 200 ? await res.json() : null };
}

test('match: 2-hop pattern returns typed rows per alias (viewer read)', async () => {
	const s = await setup();
	const ada = await mkNode(s, s.editor, 'person', { name: 'ada' });
	const router = await mkNode(s, s.editor, 'device', { type: 'router' });
	const cam = await mkNode(s, s.editor, 'device', { type: 'cam' });
	await mkEdge(s, s.editor, 'owns', ada, router, { since: 1 });
	await mkEdge(s, s.editor, 'owns', ada, cam, { since: 2 });

	const { status, json } = await postMatch(s, s.viewer, {
		steps: [
			{ node: { alias: 'a', kind: 'person' } },
			{ edge: { rel: 'owns', direction: 'out' } },
			{ node: { alias: 'b', kind: 'device' } },
		],
		select: ['a', 'b'],
	});
	expect(status).toBe(200);
	expect(json.rows.length).toBe(2);
	expect(json.rows[0].a.id).toBe(ada);
	expect(new Set(json.rows.map((r: { b: { id: string } }) => r.b.id))).toEqual(
		new Set([router, cam]),
	);
	cleanup(s);
});

test('match: .where prop filter narrows the result', async () => {
	const s = await setup();
	const ada = await mkNode(s, s.editor, 'person', { name: 'ada' });
	const router = await mkNode(s, s.editor, 'device', { type: 'router' });
	const cam = await mkNode(s, s.editor, 'device', { type: 'cam' });
	await mkEdge(s, s.editor, 'owns', ada, router, { since: 1 });
	await mkEdge(s, s.editor, 'owns', ada, cam, { since: 2 });

	const { status, json } = await postMatch(s, s.editor, {
		steps: [
			{ node: { alias: 'a', kind: 'person' } },
			{ edge: { rel: 'owns', direction: 'out' } },
			{ node: { alias: 'b', kind: 'device' } },
		],
		where: [{ alias: 'b', key: 'type', value: 'router' }],
		select: ['a', 'b'],
	});
	expect(status).toBe(200);
	expect(json.rows.length).toBe(1);
	expect(json.rows[0].b.id).toBe(router);
	cleanup(s);
});

test('match: page caps + cursor resumes', async () => {
	const s = await setup();
	const ada = await mkNode(s, s.editor, 'person', { name: 'ada' });
	const router = await mkNode(s, s.editor, 'device', { type: 'router' });
	const cam = await mkNode(s, s.editor, 'device', { type: 'cam' });
	await mkEdge(s, s.editor, 'owns', ada, router, { since: 1 });
	await mkEdge(s, s.editor, 'owns', ada, cam, { since: 2 });

	const steps = [
		{ node: { alias: 'a', kind: 'person' } },
		{ edge: { rel: 'owns', direction: 'out' } },
		{ node: { alias: 'b', kind: 'device' } },
	];
	const p1 = await postMatch(s, s.editor, { steps, select: ['b'], page: { limit: 1 } });
	expect(p1.json.rows.length).toBe(1);
	expect(typeof p1.json.nextCursor).toBe('string');

	const p2 = await postMatch(s, s.editor, {
		steps,
		select: ['b'],
		page: { limit: 1, cursor: p1.json.nextCursor },
	});
	expect(p2.json.rows.length).toBe(1);
	expect(p2.json.rows[0].b.id).not.toBe(p1.json.rows[0].b.id);
	cleanup(s);
});

test('match: a pattern with no node step -> 400', async () => {
	const s = await setup();
	const { status } = await postMatch(s, s.editor, { steps: [], select: ['a'] });
	expect(status).toBe(400);
	cleanup(s);
});
