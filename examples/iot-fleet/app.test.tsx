import { rmSync } from 'node:fs';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createApp, evict, hashEmbed } from '@graphx/core';
import { appFetch, createGraphHooks, GraphProvider } from '@graphx/react';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterAll, expect, test } from 'bun:test';
import { schema } from './schema.ts';

// How to TEST a graphx UI with no server, port, or CORS: run `createApp` in-process and point the
// provider's `fetch` at it via `appFetch(app)`. Real routes, real Zod validation, real CDC keyset.
// This one file exercises three of the DX helpers together: `appFetch` (in-process transport),
// `bootstrap="/demo"` (id-less provider), and `{ validate: true }` (runtime response validation — the
// schema value is already in scope here, so it's free, unlike in the SDK-free browser bundle).

// Registering happy-dom replaces global fetch/Response/etc. with DOM implementations. In the root
// `bun test` run (one shared process, files run in path order — examples/ BEFORE packages/) that
// would leak into later files and break native-HTTP tests (Bun.serve, CORS). So unregister after
// this file to restore the native globals — only if WE registered (guarded).
const registeredHappyDom = !(globalThis as { document?: unknown }).document;
if (registeredHappyDom) GlobalRegistrator.register();
afterAll(() => {
	if (registeredHappyDom) GlobalRegistrator.unregister();
});
notifyManager.setScheduler((cb) => cb()); // flush RQ notifications synchronously inside act()

// Validate every node response against the schema at runtime (defense against contract drift).
const g = createGraphHooks(schema, { validate: true });

test('iot-fleet UI renders the seeded fleet through an in-process app (appFetch + bootstrap)', async () => {
	const db = `iot_test_${crypto.randomUUID().replace(/-/g, '')}`;
	const { app, control } = await createApp({
		schema,
		embed: hashEmbed(),
		db,
		seed: async (graph) => {
			const site = await graph.addNode({ type: 'site', data: { name: 'us-east-1', region: 'us' } });
			const gw = await graph.addNode({ type: 'gateway', data: { name: 'gw-1', firmware: '2.1.0' } });
			await graph.addEdge({ rel: 'deployedAt', src: gw.id, dst: site.id });
		},
	});

	function Gateways() {
		const q = g.useListNodes({ type: 'gateway' });
		return createElement(
			'ul',
			null,
			q.data?.pages.flatMap((p) => p.nodes).map((gw) => createElement('li', { key: gw.id }, gw.data.name)),
		);
	}

	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const { findByText } = render(
		createElement(
			QueryClientProvider,
			{ client: qc },
			createElement(GraphProvider, { bootstrap: '/demo', fetch: appFetch(app) }, createElement(Gateways)),
		),
	);

	expect(await findByText('gw-1')).toBeDefined(); // seeded gateway rendered through the in-process app

	control.close();
	evict(db);
	for (const sfx of ['', '-wal', '-shm']) rmSync(`${db}.db${sfx}`, { force: true });
});
