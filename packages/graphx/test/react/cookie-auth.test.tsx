import './dom-setup.ts';
import { afterEach, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { createGraphHooks } from '../../src/react/create-hooks.ts';
import { GraphProvider, useGraphTransport } from '../../src/react/provider.tsx';
import { request } from '../../src/react/transport.ts';
import { SCHEMA } from './harness.tsx';

afterEach(cleanup);

test('bootstrap and subsequent graph requests carry the configured cookie credentials', async () => {
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.credentials !== 'include')
			return new Response('missing session cookie', { status: 401 });
		return new Response(
			JSON.stringify(
				String(input).endsWith('/session')
					? { tenant: 'org', project: 'notes', user: 'user' }
					: { title: 'Cookie authenticated' },
			),
		);
	}) as typeof globalThis.fetch;
	function Wrapper({ children }: { children: ReactNode }) {
		return createElement(
			GraphProvider,
			{ bootstrap: '/session', credentials: 'include', fetch },
			children,
		);
	}
	const { result } = renderHook(useGraphTransport, { wrapper: Wrapper });
	await waitFor(() => expect(result.current?.tenant).toBe('org'));
	expect(await request(result.current, { method: 'GET', path: '/nodes/n' })).toEqual({
		title: 'Cookie authenticated',
	});
});

test('event streams send cookie credentials through GraphProvider', async () => {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	let credentials: RequestCredentials | undefined;
	const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		credentials = init?.credentials;
		return new Response(null, { status: 501 });
	}) as typeof globalThis.fetch;
	function Wrapper({ children }: { children: ReactNode }) {
		return createElement(
			QueryClientProvider,
			{ client: qc },
			createElement(
				GraphProvider,
				{ tenant: 'org', project: 'notes', credentials: 'include', fetch },
				children,
			),
		);
	}
	const hooks = createGraphHooks(SCHEMA);
	renderHook(() => hooks.useGraphEvents(), { wrapper: Wrapper });
	await waitFor(() => expect(credentials).toBe('include'));
});
