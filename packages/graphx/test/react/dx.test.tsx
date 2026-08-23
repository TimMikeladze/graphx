import './dom-setup.ts';
import { rmSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createApp, defineGraphSchema, evict } from '../../src/core/index.ts';
// Importing the core harness registers the pg adapter under the postgres test leg, so the dev
// `createApp` below (which opens project DBs via getDb) works on both backends.
import { TEST_DRIVER } from '../core/harness.ts';
import { createGraphHooks } from '../../src/react/create-hooks.ts';
import { GraphError } from '../../src/react/errors.ts';
import { GraphProvider } from '../../src/react/provider.tsx';
import { appFetch } from '../../src/react/transport.ts';
import { hooks, makeWrapper, mkEdge, mkNode, setup } from './harness.tsx';

void TEST_DRIVER;

const DEV_SCHEMA = defineGraphSchema({
	nodes: { person: z.object({ name: z.string() }) },
	edges: {},
});

function qcWrapper(inner: (children: ReactNode) => ReactNode) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	function Wrapper({ children }: { children: ReactNode }) {
		return createElement(QueryClientProvider, { client: qc }, inner(children));
	}
	return Wrapper;
}

function cleanupDev(control: { close: () => void }, db: string) {
	control.close();
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
}

// --- item 2 + 5: <GraphProvider bootstrap> resolves ids from /demo via appFetch (no hardcoded ids) ---
test('GraphProvider bootstrap: fetches /demo ids and drives hooks through appFetch', async () => {
	const db = `dev_${crypto.randomUUID().replace(/-/g, '')}`;
	const { app, control } = await createApp({
		schema: DEV_SCHEMA,
		db,
		seed: async (g) => {
			await g.addNode({ type: 'person', data: { name: 'ada' } });
		},
	});
	const fetch = appFetch(app);
	const h = createGraphHooks(DEV_SCHEMA);
	const Wrapper = qcWrapper((children) =>
		createElement(
			GraphProvider,
			{ baseUrl: '', bootstrap: '/demo', fetch, fallback: createElement('span', null, 'loading') },
			children,
		),
	);

	const { result } = renderHook(() => h.useListNodes({ type: 'person' }), { wrapper: Wrapper });
	// First renders the fallback (no transport yet), then resolves after the /demo fetch.
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	const names = result.current.data?.pages.flatMap((p) => p.nodes.map((n) => n.data.name));
	expect(names).toEqual(['ada']);
	cleanupDev(control, db);
});

// --- item 2 (regression): bootstrap fetches /demo ONCE, even when the parent re-renders with a
// fresh `fetch` identity (a naive inline `fetch={appFetch(app)}`) — no refetch loop. ---
test('GraphProvider bootstrap: /demo is fetched once across re-renders with a new fetch identity', async () => {
	const db = `dev_${crypto.randomUUID().replace(/-/g, '')}`;
	const { app, control } = await createApp({
		schema: DEV_SCHEMA,
		db,
		seed: async (g) => {
			await g.addNode({ type: 'person', data: { name: 'ada' } });
		},
	});
	let demoHits = 0;
	const countingApp = {
		request(input: string | URL | Request, init?: RequestInit) {
			if (String(input).endsWith('/demo')) demoHits += 1;
			return app.request(input, init);
		},
	};
	const h = createGraphHooks(DEV_SCHEMA);
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	function Probe() {
		const q = h.useListNodes({ type: 'person' });
		return createElement('span', null, q.isSuccess ? 'ok' : '…');
	}
	// Each call mints a NEW appFetch identity — the bug re-ran the bootstrap effect on every one.
	const mkTree = () =>
		createElement(
			QueryClientProvider,
			{ client: qc },
			createElement(
				GraphProvider,
				{ baseUrl: '', bootstrap: '/demo', fetch: appFetch(countingApp) },
				createElement(Probe),
			),
		);
	const { rerender, findByText } = render(mkTree());
	await findByText('ok');
	rerender(mkTree()); // new fetch identity on the provider
	rerender(mkTree());
	await findByText('ok');
	expect(demoHits).toBe(1);
	cleanupDev(control, db);
});

// --- item 6: opt-in response validation catches server/contract drift ---
test('createGraphHooks(schema, { validate: true }) throws on a node that violates the client schema', async () => {
	const db = `dev_${crypto.randomUUID().replace(/-/g, '')}`;
	// Server stores { name } only.
	const { app, control, tenant, project, user } = await createApp({
		schema: DEV_SCHEMA,
		db,
		seed: async (g) => {
			await g.addNode({ type: 'person', data: { name: 'ada' } });
		},
	});
	// The seeded id (first node) — fetch it via the list route.
	const listRes = await app.request(`/t/${tenant}/p/${project}/nodes?type=person`, {
		headers: { 'x-user': user, 'x-tenant': tenant },
	});
	const id = (await listRes.json()).nodes[0].id as string;

	// Client schema is STRICTER (age required) — a valid-on-server node fails client validation.
	const strict = defineGraphSchema({
		nodes: { person: z.object({ name: z.string(), age: z.number() }) },
		edges: {},
	});
	const strictHooks = createGraphHooks(strict, { validate: true });
	const fetch = appFetch(app);
	const Wrapper = qcWrapper((children) =>
		createElement(
			GraphProvider,
			{
				baseUrl: '',
				tenant,
				project,
				headers: () => ({ 'x-user': user, 'x-tenant': tenant }),
				fetch,
			},
			children,
		),
	);

	const { result } = renderHook(() => strictHooks.useNode(id, 'person'), { wrapper: Wrapper });
	await waitFor(() => expect(result.current.isError).toBe(true));
	const err = result.current.error as GraphError;
	expect(err).toBeInstanceOf(GraphError);
	expect(err.code).toBe('validation');
	cleanupDev(control, db);
});

// --- item 7: fluent MatchBuilder passed to useMatch yields per-alias-typed rows ---
test('useMatch(builder): fluent spec returns the matched, per-alias rows', async () => {
	const h = await setup();
	const { Wrapper } = makeWrapper(h, h.editor);
	const person = await mkNode(h, h.editor, 'person', { name: 'ada' });
	const device = await mkNode(h, h.editor, 'device', { type: 'router' });
	await mkEdge(h, h.editor, 'owns', person, device, { since: 1 });

	const { result } = renderHook(
		() =>
			hooks.useMatch((m) => m.node('p', 'person').out('owns').node('d', 'device').select('p', 'd')),
		{ wrapper: Wrapper },
	);
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	const rows = result.current.data?.rows ?? [];
	expect(rows.length).toBe(1);
	// Per-alias narrowing: p is NodeOf<S,'person'>, d is NodeOf<S,'device'> — data are typed.
	expect(rows[0]?.p.data.name).toBe('ada');
	expect(rows[0]?.d.data.type).toBe('router');
	h.cleanup();
});

// --- item 6 (extended): validation also covers the paginated node reads (useNeighbors) ---
test('validate covers useNeighbors: a neighbor that violates the client schema throws', async () => {
	const h = await setup();
	const { Wrapper } = makeWrapper(h, h.editor);
	const person = await mkNode(h, h.editor, 'person', { name: 'ada' });
	const device = await mkNode(h, h.editor, 'device', { type: 'router' }); // server device = { type, crit }
	await mkEdge(h, h.editor, 'owns', person, device, { since: 1 });

	// Client schema demands an `extra` field the server never sends → the neighbor fails validation.
	const strict = defineGraphSchema({
		nodes: {
			device: z.object({ type: z.string(), crit: z.number(), extra: z.number() }),
			person: z.object({ name: z.string() }),
		},
		edges: { owns: { from: 'person', to: 'device' }, knows: {}, linked: {} },
	});
	const strictHooks = createGraphHooks(strict, { validate: true });
	const { result } = renderHook(() => strictHooks.useNeighbors(person, { rel: 'owns' }), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(result.current.isError).toBe(true));
	expect((result.current.error as GraphError).code).toBe('validation');
	h.cleanup();
});
