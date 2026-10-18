import '@/hooks/dom-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountControl, AuthProvider } from './auth-provider';
import { configureAuth } from '@/lib/auth-client';
import { api } from '@/lib/api';

const nativeFetch = globalThis.fetch;
afterEach(() => {
	cleanup();
	globalThis.fetch = nativeFetch;
	configureAuth({ mode: 'legacy' });
});
function fixture(
	session: unknown = {
		user: { id: 'alice', name: 'Alice', email: 'alice@example.test' },
		session: { id: 'session-1' },
	},
) {
	window.location.href = 'http://localhost:3000/';
	const calls: { path: string; init?: RequestInit }[] = [];
	let currentSession = session;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input);
		calls.push({ path, init });
		if (path === '/auth-config')
			return Response.json({
				mode: 'better-auth',
				basePath: '/custom/auth',
				projectAccess: true,
			});
		if (path.includes('/get-session')) return Response.json(currentSession);
		if (path.includes('/sign-out')) {
			currentSession = null;
			return Response.json({ success: true });
		}
		if (path.includes('/nodes'))
			return Response.json({ error: 'unauthenticated' }, { status: 401 });
		return Response.json({});
	}) as typeof fetch;
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={qc}>
			<AuthProvider>
				<p>Protected project</p>
				<AccountControl />
			</AuthProvider>
		</QueryClientProvider>,
	);
	return {
		...view,
		qc,
		calls,
		setSession: (value: unknown) => {
			currentSession = value;
		},
	};
}

describe('session gate', () => {
	it('keeps protected routes behind login and uses the discovered auth path', async () => {
		const view = fixture(null);
		await waitFor(() =>
			expect(view.getByRole('button', { name: 'Sign in', exact: true })).toBeTruthy(),
		);
		expect(view.queryByText('Protected project')).toBeNull();
		expect(view.calls.some((call) => call.path.includes('/custom/auth/get-session'))).toBe(true);
	});

	it('clears cached graph data on logout and returns to login', async () => {
		const view = fixture();
		await waitFor(() => expect(view.getByText('Protected project')).toBeTruthy());
		view.qc.setQueryData(['private-graph'], { secret: 'alice-only' });
		fireEvent.click(view.getByRole('button', { name: 'Sign out' }));
		await waitFor(() =>
			expect(view.getByRole('button', { name: 'Sign in', exact: true })).toBeTruthy(),
		);
		expect(view.qc.getQueryData(['private-graph'])).toBeUndefined();
		expect(view.queryByText('Protected project')).toBeNull();
	});

	it('clears cached data and closes protected routes when a graph request expires', async () => {
		const view = fixture();
		await waitFor(() => expect(view.getByText('Protected project')).toBeTruthy());
		view.qc.setQueryData(['private-graph'], { secret: 'alice-only' });
		await act(async () => {
			await api.listNodes('org', 'project').catch(() => {});
		});
		await waitFor(() =>
			expect(view.getByRole('button', { name: 'Sign in', exact: true })).toBeTruthy(),
		);
		expect(view.qc.getQueryData(['private-graph'])).toBeUndefined();
	});

	it('clears cached graph data when the browser session changes accounts', async () => {
		const view = fixture();
		await waitFor(() => expect(view.getByText('alice@example.test')).toBeTruthy());
		view.qc.setQueryData(['private-graph'], { secret: 'alice-only' });
		view.setSession({
			user: { id: 'bob', name: 'Bob', email: 'bob@example.test' },
			session: { id: 'session-2' },
		});
		await act(async () => {
			window.dispatchEvent(new Event('focus'));
		});
		await waitFor(() => expect(view.getByText('bob@example.test')).toBeTruthy());
		expect(view.qc.getQueryData(['private-graph'])).toBeUndefined();
		expect(view.queryByText('alice@example.test')).toBeNull();
	});

	it('shows retry after failed discovery without mounting protected routes', async () => {
		globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
		const view = render(
			<QueryClientProvider client={new QueryClient()}>
				<AuthProvider>
					<p>Protected project</p>
				</AuthProvider>
			</QueryClientProvider>,
		);
		await waitFor(() => expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy());
		expect(view.queryByText('Protected project')).toBeNull();
		expect(view.getByRole('alert').textContent).toContain('503');
	});
});
