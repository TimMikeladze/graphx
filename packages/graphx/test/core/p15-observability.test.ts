import { rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
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
import type { DbClient } from '../../src/core/dialect.ts';
import { defineGraphSchema } from '../../src/core/define-graph-schema.ts';
import {
	InMemoryMetrics,
	NOOP_METRICS,
	QueryTimeoutError,
	withTimeout,
} from '../../src/core/governance.ts';
import { createApp, createReadiness } from '../../src/core/serve.ts';
import { makeTestDb } from './harness.ts';

// P15 — observability (§19.6). Pluggable MetricsSink threaded like `limits` (per-call,
// never a module global). Structured slow-query log (> timeout/2) at withTimeout.
// /health (always up) + /ready (gated on the sync-before-serve latch). Per-tenant query
// counts + traversal histograms. Absent sink ⇒ zero overhead, byte-identical behavior.

// --- governance: MetricsSink + slow-query at withTimeout ---

test('P15 obs: NOOP_METRICS is a callable no-op sink', () => {
	expect(() => {
		NOOP_METRICS.inc('x', { a: '1' });
		NOOP_METRICS.observe('y', 1.5);
		NOOP_METRICS.gauge('z', 3);
	}).not.toThrow();
});

test('P15 obs: InMemoryMetrics records inc/observe/gauge with labels', () => {
	const m = new InMemoryMetrics();
	m.inc('q', { tenant: 'a' });
	m.inc('q', { tenant: 'a' });
	m.inc('q', { tenant: 'b' });
	m.observe('d', 5, { op: 'journey' });
	m.gauge('lag', 12);
	expect(m.count('q', { tenant: 'a' })).toBe(2);
	expect(m.count('q', { tenant: 'b' })).toBe(1);
	expect(m.count('q')).toBe(3); // no label filter = all of name `q`
	expect(m.observations('d')).toEqual([5]);
	expect(m.gauges.find((g) => g.name === 'lag')?.value).toBe(12);
});

test('P15 obs: withTimeout emits ONE slow-query record when elapsed > timeoutMs/2', async () => {
	const sink = new InMemoryMetrics();
	// ms=600 → threshold 300. work sleeps 350ms: elapsed ≥ 350 > 300 is GUARANTEED (load
	// only grows elapsed, never shrinks it), and 350 ≪ 600 so the work completes well before
	// the abandonment timer (250ms upper slack survives parallel-suite load).
	const v = await withTimeout(
		sleep(350).then(() => 'ok'),
		600,
		{ op: 'test.slow', sink },
	);
	expect(v).toBe('ok');
	expect(sink.observations('graphx_query_slow_ms').length).toBe(1);
	expect(sink.histograms.find((h) => h.name === 'graphx_query_slow_ms')?.labels?.op).toBe(
		'test.slow',
	);
});

test('P15 obs: withTimeout emits NO slow-query record for a fast query (< timeoutMs/2)', async () => {
	const sink = new InMemoryMetrics();
	// ms=2000 → threshold 1000. work resolves at ~10ms (timer is cleared on settle, so the
	// test stays ~10ms despite the large budget); even heavy load can't drift 10ms past 1000ms.
	const v = await withTimeout(
		sleep(10).then(() => 'fast'),
		2000,
		{ op: 'test.fast', sink },
	);
	expect(v).toBe('fast');
	expect(sink.observations('graphx_query_slow_ms').length).toBe(0);
});

test('P15 obs: withTimeout records slow on the timeout/abandonment path too', async () => {
	const sink = new InMemoryMetrics();
	// ms=40 → threshold 20; work sleeps 400ms → the timer fires first (abandonment), well
	// before the work; elapsed ≈ 40 > 20 → recorded once.
	await expect(
		withTimeout(
			sleep(400).then(() => 'late'),
			40,
			{ op: 'test.timeout', sink },
		),
	).rejects.toBeInstanceOf(QueryTimeoutError);
	expect(sink.observations('graphx_query_slow_ms').length).toBe(1); // recorded once, no double
});

test('P15 obs: withTimeout WITHOUT a sink is unchanged (additive — no throw, returns value)', async () => {
	expect(await withTimeout(Promise.resolve('x'), 200)).toBe('x');
	// a delayed (timer-armed) query with no sink still just returns — no metric, no behavior
	// change. ms=2000 so the work (≈50ms) resolves long before the timer regardless of load.
	expect(
		await withTimeout(
			sleep(50).then(() => 'y'),
			2000,
		),
	).toBe('y');
});

// --- serve: /health, /ready, per-tenant counter, traversal histogram ---

const SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: { knows: { from: 'person', to: 'person' } },
});

function authenticate(c: { req: { header: (n: string) => string | undefined } }) {
	const userId = c.req.header('x-user');
	const tenantId = c.req.header('x-tenant');
	if (!userId || !tenantId) throw new Error('missing auth');
	return { userId, tenantId };
}

interface Setup {
	control: DbClient;
	tenantA: string;
	editor: string;
	pA: string;
	nsA: string;
}

async function setup(): Promise<Setup> {
	const control = makeTestDb().client;
	await initControl(control);
	const tenantA = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${ulid()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenantA, role: 'editor' });
	const nsA = `ns_${ulid().toLowerCase()}`;
	const pA = await createProject(control, { tenantId: tenantA, name: 'Alpha', dbNamespace: nsA });
	return { control, tenantA, editor, pA, nsA };
}

function cleanup(s: Setup): void {
	evict(s.nsA);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${s.nsA}.db${sfx}`, { force: true });
	s.control.close();
}

function hdr(userId: string, tenantId: string): Record<string, string> {
	return { 'x-user': userId, 'x-tenant': tenantId, 'content-type': 'application/json' };
}

test('P15 obs: GET /health → 200 always, without auth, not tenant-scoped', async () => {
	const s = await setup();
	const app = createApp({ control: s.control, schema: SCHEMA, authenticate });
	const res = await app.request('/health'); // no auth headers at all
	expect(res.status).toBe(200);
	cleanup(s);
});

test('P15 obs: GET /ready → 503 before the readiness latch, 200 after (no auth)', async () => {
	const s = await setup();
	const readiness = createReadiness();
	const app = createApp({ control: s.control, schema: SCHEMA, authenticate, readiness });
	const before = await app.request('/ready'); // sync-before-serve not yet complete
	expect(before.status).toBe(503);
	readiness.markReady(); // operator flips it after syncIfReplica(...) completes
	const after = await app.request('/ready');
	expect(after.status).toBe(200);
	cleanup(s);
});

test('P15 obs: GET /ready → 200 by default when no readiness latch is configured (non-replica)', async () => {
	const s = await setup();
	const app = createApp({ control: s.control, schema: SCHEMA, authenticate });
	const res = await app.request('/ready');
	expect(res.status).toBe(200);
	cleanup(s);
});

test('P15 obs: /health and /ready do not require auth (not behind the authn group)', async () => {
	const s = await setup();
	const app = createApp({ control: s.control, schema: SCHEMA, authenticate });
	// a protected route with no auth is 401; the health routes are NOT
	expect((await app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/x`)).status).toBe(401);
	expect((await app.request('/health')).status).toBe(200);
	expect((await app.request('/ready')).status).toBe(200);
	cleanup(s);
});

test('P15 obs: a read route increments a per-tenant query counter', async () => {
	const s = await setup();
	const metrics = new InMemoryMetrics();
	const app = createApp({ control: s.control, schema: SCHEMA, authenticate, metrics });
	const created = await app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ type: 'person', data: { name: 'ada' } }),
	});
	const id = (await created.json()).id;
	const before = metrics.count('graphx_queries_total', { tenant: s.tenantA, op: 'read' });
	await app.request(`/t/${s.tenantA}/p/${s.pA}/nodes/${id}`, { headers: hdr(s.editor, s.tenantA) });
	const after = metrics.count('graphx_queries_total', { tenant: s.tenantA, op: 'read' });
	expect(after).toBe(before + 1); // exactly one read counted, labelled by tenant
	cleanup(s);
});

test('P15 obs: journey route observes a traversal histogram into the sink', async () => {
	const s = await setup();
	const metrics = new InMemoryMetrics();
	const app = createApp({ control: s.control, schema: SCHEMA, authenticate, metrics });
	const me = hdr(s.editor, s.tenantA);
	const p1 = (
		await (
			await app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
				method: 'POST',
				headers: me,
				body: JSON.stringify({ type: 'person', data: { name: 'p1' } }),
			})
		).json()
	).id;
	const p2 = (
		await (
			await app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
				method: 'POST',
				headers: me,
				body: JSON.stringify({ type: 'person', data: { name: 'p2' } }),
			})
		).json()
	).id;
	await app.request(`/t/${s.tenantA}/p/${s.pA}/edges`, {
		method: 'POST',
		headers: me,
		body: JSON.stringify({ rel: 'knows', src: p1, dst: p2 }),
	});
	await app.request(`/t/${s.tenantA}/p/${s.pA}/journey`, {
		method: 'POST',
		headers: me,
		body: JSON.stringify({ start: p1, from: 0 }),
	});
	const obs = metrics.histograms.filter(
		(h) => h.name === 'graphx_traversal_rows' && h.labels?.op === 'journey',
	);
	expect(obs.length).toBe(1);
	expect(obs[0]?.value).toBeGreaterThanOrEqual(1); // reached at least p2
	cleanup(s);
});

test('P15 obs: with NO metrics sink, routes behave identically (additive)', async () => {
	const s = await setup();
	const app = createApp({ control: s.control, schema: SCHEMA, authenticate });
	const created = await app.request(`/t/${s.tenantA}/p/${s.pA}/nodes`, {
		method: 'POST',
		headers: hdr(s.editor, s.tenantA),
		body: JSON.stringify({ type: 'person', data: { name: 'ada' } }),
	});
	expect(created.status).toBe(201);
	cleanup(s);
});
