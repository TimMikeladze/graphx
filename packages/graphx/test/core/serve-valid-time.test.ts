import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { ulid } from 'ulidx';
import { z } from 'zod';
import type { Principal } from '../../src/core/authz.ts';
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

// D11: valid time over HTTP is the operator's opt-in (`allowValidTime`); recorded-time reads
// (`recordedAsOf`) are always allowed.

const SCHEMA = defineGraphSchema({
	nodes: { plant: z.object({ name: z.string(), yield: z.number() }) },
	edges: { feeds: { from: 'plant', to: 'plant' } },
});

function authenticate(c: { req: { header: (n: string) => string | undefined } }): Principal {
	return { userId: c.req.header('x-user') ?? '', tenantId: c.req.header('x-tenant') ?? '' };
}

async function setup(allowValidTime: boolean) {
	const control = makeTestDb().client;
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const user = await createUser(control, { email: `e-${ulid()}@a.test` });
	await addMembership(control, { userId: user, tenantId: tenant, role: 'editor' });
	const ns = `ns_${ulid().toLowerCase()}`;
	const project = await createProject(control, { tenantId: tenant, name: 'P', dbNamespace: ns });
	const app = createApp({ control, schema: SCHEMA, authenticate, allowValidTime });
	const base = `/t/${tenant}/p/${project}`;
	const headers = { 'x-user': user, 'x-tenant': tenant, 'content-type': 'application/json' };
	const call = (method: string, path: string, body?: unknown) =>
		app.request(`${base}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const cleanup = () => {
		evict(ns);
		for (const sfx of ['', '-wal', '-shm']) rmSync(`${ns}.db${sfx}`, { force: true });
		control.close();
	};
	return { call, cleanup };
}

const Y = (year: number) => Date.UTC(year, 0, 1);

test('without allowValidTime, valid time on writes is refused; recordedAsOf reads work', async () => {
	const { call, cleanup } = await setup(false);
	const created = await call('POST', '/nodes', { type: 'plant', data: { name: 'h', yield: 1 } });
	expect(created.status).toBe(201);
	const { id } = await created.json();

	for (const [method, path, body] of [
		['POST', '/nodes', { type: 'plant', data: { name: 'x', yield: 1 }, validFrom: Y(1992) }],
		['PATCH', `/nodes/${id}`, { data: { yield: 2 }, validFrom: Y(1992) }],
		['DELETE', `/nodes/${id}?validFrom=${Y(1992)}`, undefined],
		['POST', `/nodes/${id}/correct`, { data: { yield: 2 }, validFrom: Y(1992) }],
		['POST', `/nodes/${id}/retract`, { validFrom: Y(1992) }],
		[
			'POST',
			'/bulk',
			{ rows: [{ type: 'plant', data: { name: 'b', yield: 1 }, validFrom: Y(1992) }] },
		],
	] as const) {
		const res = await call(method, path, body);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain('allowValidTime');
	}
	const read = await call('GET', `/nodes/${id}?recordedAsOf=${Date.now()}`);
	expect(read.status).toBe(200);
	cleanup();
});

test('with allowValidTime, the past can be written, corrected and read both ways', async () => {
	const { call, cleanup } = await setup(true);
	const { id } = await (
		await call('POST', '/nodes', {
			type: 'plant',
			data: { name: 'h', yield: 0.9 },
			validFrom: Y(1992),
		})
	).json();
	await Bun.sleep(3);
	const beforeFix = Date.now();
	await Bun.sleep(3);
	const fixed = await call('POST', `/nodes/${id}/correct`, {
		data: { yield: 0.88 },
		validFrom: Y(1992),
	});
	expect(fixed.status).toBe(200);
	expect((await fixed.json()).data.yield).toBe(0.88);

	const at = async (q: string) =>
		(await (await call('GET', `/nodes/${id}?${q}`)).json()).data.yield;
	expect(await at(`asOf=${Y(1995)}`)).toBe(0.88);
	expect(await at(`asOf=${Y(1995)}&recordedAsOf=${beforeFix}`)).toBe(0.9);

	const { versions } = await (await call('GET', `/nodes/${id}/history`)).json();
	expect(versions.map((v: { current: boolean }) => v.current)).toEqual([false, true]);
	const recorded = await (
		await call('GET', `/diff?t1=${beforeFix}&t2=${Date.now()}&axis=recorded`)
	).json();
	expect(recorded.nodes.map((n: { id: string }) => n.id)).toContain(id);

	expect(
		(await call('POST', `/nodes/${id}/retract`, { validFrom: Y(1993), validTo: Y(1994) })).status,
	).toBe(204);
	expect((await call('GET', `/nodes/${id}?asOf=${Y(1993) + 1}`)).status).toBe(404);
	// no future dating, and nothing to correct, map to client errors
	expect(
		(await call('PATCH', `/nodes/${id}`, { data: { yield: 1 }, validFrom: Date.now() + 60_000 }))
			.status,
	).toBe(400);
	expect(
		(await call('POST', `/nodes/${ulid()}/correct`, { data: {}, validFrom: Y(1992) })).status,
	).toBe(404);
	cleanup();
});
