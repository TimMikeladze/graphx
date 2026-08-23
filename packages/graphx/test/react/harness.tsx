import './dom-setup.ts';
import { rmSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { z } from 'zod';
import {
	addMembership,
	createApp,
	createProject,
	createTenant,
	createUser,
	defineGraphSchema,
	evict,
	initControl,
} from '../../src/core/index.ts';
import { makeTestDb } from '../core/harness.ts';
import { createGraphHooks } from '../../src/react/create-hooks.ts';
import { GraphProvider } from '../../src/react/provider.tsx';

// Integration harness: an in-process Hono app (real routes / zod / CDC keyset) reached through the
// provider's injected `fetch` (`app.request`). Mirrors the core p11-serving setup. Importing core
// from SOURCE (not the built `dist`) guarantees the new R0 routes are present.

export const SCHEMA = defineGraphSchema({
	nodes: {
		device: z.object({ type: z.string(), crit: z.number().default(1) }),
		person: z.object({ name: z.string() }),
	},
	edges: {
		owns: { from: 'person', to: 'device', data: z.object({ since: z.number() }) },
		knows: { from: 'person', to: 'person' },
		linked: {},
	},
});

/** The hook set under test, bound to SCHEMA once (the documented usage). */
export const hooks = createGraphHooks(SCHEMA);

/** dim-768 one-hot embedding (init() defaults to 768) for the retrieve/hybrid routes. */
export function vec(seed: number): number[] {
	const a = Array.from({ length: 768 }, () => 0);
	a[seed % 768] = 1;
	return a;
}

function authenticate(c: { req: { header: (n: string) => string | undefined } }) {
	const userId = c.req.header('x-user');
	const tenantId = c.req.header('x-tenant');
	if (!userId || !tenantId) throw new Error('missing auth');
	return { userId, tenantId };
}

export interface Harness {
	app: ReturnType<typeof createApp<typeof SCHEMA>>;
	tenant: string;
	editor: string;
	viewer: string;
	project: string;
	cleanup: () => void;
}

export async function setup(): Promise<Harness> {
	const control = makeTestDb().client;
	await initControl(control);
	const tenant = await createTenant(control, { name: 'Acme' });
	const editor = await createUser(control, { email: `e-${crypto.randomUUID()}@a.test` });
	const viewer = await createUser(control, { email: `v-${crypto.randomUUID()}@a.test` });
	await addMembership(control, { userId: editor, tenantId: tenant, role: 'editor' });
	await addMembership(control, { userId: viewer, tenantId: tenant, role: 'viewer' });
	const ns = `ns_${crypto.randomUUID().replace(/-/g, '')}`;
	const project = await createProject(control, {
		tenantId: tenant,
		name: 'Alpha',
		dbNamespace: ns,
	});
	const app = createApp({
		control,
		schema: SCHEMA,
		authenticate,
		embed: async (q) => vec(q.length),
	});
	return {
		app,
		tenant,
		editor,
		viewer,
		project,
		cleanup: () => {
			evict(ns);
			for (const sfx of ['', '-wal', '-shm']) rmSync(`${ns}.db${sfx}`, { force: true });
			control.close();
		},
	};
}

/** A fresh QueryClient + provider wrapper for `renderHook`, authenticating as `user`. */
export function makeWrapper(h: Harness, user: string) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	function Wrapper({ children }: { children: ReactNode }) {
		return createElement(
			QueryClientProvider,
			{ client: qc },
			createElement(
				GraphProvider,
				{
					baseUrl: '',
					tenant: h.tenant,
					project: h.project,
					headers: () => ({ 'x-user': user, 'x-tenant': h.tenant }),
					fetch: ((input: string, init?: RequestInit) =>
						h.app.request(input, init)) as unknown as typeof fetch,
				},
				children,
			),
		);
	}
	return { Wrapper, qc };
}

/** POST a node directly through the app (test data setup). */
export async function mkNode(
	h: Harness,
	user: string,
	type: string,
	data: unknown,
	extra?: Record<string, unknown>,
): Promise<string> {
	const res = await h.app.request(`/t/${h.tenant}/p/${h.project}/nodes`, {
		method: 'POST',
		headers: { 'x-user': user, 'x-tenant': h.tenant, 'content-type': 'application/json' },
		body: JSON.stringify({ type, data, ...extra }),
	});
	return (await res.json()).id as string;
}

/** POST an edge directly through the app (test data setup). */
export async function mkEdge(
	h: Harness,
	user: string,
	rel: string,
	src: string,
	dst: string,
	data?: unknown,
): Promise<string> {
	const res = await h.app.request(`/t/${h.tenant}/p/${h.project}/edges`, {
		method: 'POST',
		headers: { 'x-user': user, 'x-tenant': h.tenant, 'content-type': 'application/json' },
		body: JSON.stringify({ rel, src, dst, data }),
	});
	return (await res.json()).id as string;
}
