import { rmSync } from 'node:fs';
import { expect, test } from 'bun:test';
import { AuthzError, authorize, type Principal, resolveProjectDb } from '../src/authz.ts';
import type { DbClient } from '../src/dialect.ts';
import { makeTestDb, tableExistsSql } from './harness.ts';
import {
	addMembership,
	createProject,
	createTenant,
	createUser,
	initControl,
} from '../src/control-plane.ts';
import { evict, getDb } from '../src/db.ts';

/** Drop the cached client and remove the project's `file:` DB artifacts. */
function cleanupNamespace(namespace: string): void {
	evict(namespace);
	for (const suffix of ['', '-wal', '-shm']) {
		rmSync(`${namespace}.db${suffix}`, { force: true });
	}
}

// P0.5 control plane + authz + project routing (§0, §3.2, §3.1). Proves
// tenant/project isolation: a viewer reads but cannot write, a cross-tenant request
// is rejected, the resolved object NEVER carries a sqld token, and lazy per-namespace
// init() fires exactly once under concurrency (audit M9).

function mem(): DbClient {
	return makeTestDb().client;
}

interface Seed {
	control: DbClient;
	user: string;
	tenantA: string;
	tenantB: string;
	pA: string;
	pB: string;
	nsA: string;
	nsB: string;
}

async function seed(): Promise<Seed> {
	const control = mem();
	await initControl(control);
	const tenantA = await createTenant(control, { name: 'Acme' });
	const tenantB = await createTenant(control, { name: 'Globex' });
	const user = await createUser(control, { email: 'viewer@acme.test' });
	await addMembership(control, { userId: user, tenantId: tenantA, role: 'viewer' });
	const nsA = 'acme__alpha';
	const nsB = 'globex__beta';
	const pA = await createProject(control, { tenantId: tenantA, name: 'Alpha', dbNamespace: nsA });
	const pB = await createProject(control, { tenantId: tenantB, name: 'Beta', dbNamespace: nsB });
	return { control, user, tenantA, tenantB, pA, pB, nsA, nsB };
}

test('P0.5: viewer can read project in own tenant -> returns dbNamespace', async () => {
	const s = await seed();
	const principal: Principal = { userId: s.user, tenantId: s.tenantA };
	const out = await authorize(s.control, principal, s.pA, 'read');
	expect(out.dbNamespace).toBe(s.nsA);
	s.control.close();
});

test('P0.5: viewer cannot write -> throws AuthzError 403', async () => {
	const s = await seed();
	const principal: Principal = { userId: s.user, tenantId: s.tenantA };
	let caught: unknown;
	try {
		await authorize(s.control, principal, s.pA, 'write');
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(AuthzError);
	expect((caught as AuthzError).status).toBe(403);
	s.control.close();
});

test('P0.5 HEADLINE: cross-tenant request is rejected', async () => {
	const s = await seed();
	// principal authenticated in tenantA asks for pB which belongs to tenantB
	const principal: Principal = { userId: s.user, tenantId: s.tenantA };
	let caught: unknown;
	try {
		await authorize(s.control, principal, s.pB, 'read');
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(AuthzError);
	expect([403, 404]).toContain((caught as AuthzError).status);
	s.control.close();
});

test('P0.5: authorize never returns a token field', async () => {
	const s = await seed();
	const principal: Principal = { userId: s.user, tenantId: s.tenantA };
	const out = await authorize(s.control, principal, s.pA, 'read');
	expect(Object.keys(out)).toEqual(['dbNamespace']);
	expect('token' in out).toBe(false);
	expect('authToken' in out).toBe(false);
	s.control.close();
});

test('P0.5: resolveProjectDb returns {namespace, client} and never a token', async () => {
	const s = await seed();
	const principal: Principal = { userId: s.user, tenantId: s.tenantA };
	const out = await resolveProjectDb(s.control, principal, s.pA, 'read');
	expect(out.namespace).toBe(s.nsA);
	expect('token' in out).toBe(false);
	expect('authToken' in out).toBe(false);
	// the returned client has the project schema present (init ran)
	const r = await out.client.execute(tableExistsSql(out.client, 'node_versions'));
	expect(r.rows.length).toBe(1);
	cleanupNamespace(s.nsA);
	s.control.close();
});

test('P0.5: resolveProjectDb cross-tenant still rejected', async () => {
	const s = await seed();
	const principal: Principal = { userId: s.user, tenantId: s.tenantA };
	await expect(resolveProjectDb(s.control, principal, s.pB, 'read')).rejects.toBeInstanceOf(
		AuthzError,
	);
	s.control.close();
});

test('P0.5 M9: concurrent first-touch inits the namespace only once', async () => {
	const s = await seed();
	const principal: Principal = { userId: s.user, tenantId: s.tenantA };
	// Pre-warm the cached client and spy on executeMultiple, which init() calls once
	// to run the DDL — proves the per-namespace guard, not just idempotent IF NOT EXISTS.
	const client = getDb(s.nsA);
	const origExecMulti = client.executeMultiple.bind(client);
	let ddlRuns = 0;
	client.executeMultiple = (script: string): Promise<void> => {
		ddlRuns++;
		return origExecMulti(script);
	};
	// fire many concurrent resolves for the same fresh namespace
	const results = await Promise.all(
		Array.from({ length: 8 }, () => resolveProjectDb(s.control, principal, s.pA, 'read')),
	);
	// all resolve to the same cached client (one DB); init() DDL ran exactly once
	for (const r of results) expect(r.client).toBe(client);
	expect(ddlRuns).toBe(1);
	const r = await client.execute(tableExistsSql(client, 'node_versions'));
	expect(r.rows.length).toBe(1);
	cleanupNamespace(s.nsA);
	s.control.close();
});
