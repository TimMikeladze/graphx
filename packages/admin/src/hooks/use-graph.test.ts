import './dom-setup.ts';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { setToken } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import {
	useCreateEdge,
	useDeleteEdge,
	useGraphSlice,
	useTimeline,
	useUpdateNode,
	useUpdateNodeBody,
} from './use-graph';

afterEach(cleanup);

function ok(body: unknown) {
	return { ok: true, status: 200, json: async () => body } as Response;
}

function freshClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
}

function wrapperFor(qc: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return createElement(QueryClientProvider, { client: qc }, children);
	};
}

/**
 * The four write mutations must invalidate the as-of-agnostic `all*` prefix, not a live-only leaf
 * key — a leaf-key invalidation evicts only the live cache entry and leaves every as-of entry
 * stale (the bug this whole plan exists to fix; see `qk.allNode`/`allNodeContent`/`allNeighbors`
 * in query-keys.ts). Each case here seeds both a live and an as-of cache entry, fires the mutation
 * against a stubbed transport (no server involved — only which keys get invalidated is under
 * test), and asserts BOTH entries were marked invalidated.
 */
describe('mutation invalidation reaches every asOf cache entry', () => {
	let fetchMock: ReturnType<typeof mock>;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		setToken(null);
		fetchMock = mock();
		originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('useUpdateNodeBody invalidates the live and asOf content cache', async () => {
		fetchMock.mockResolvedValue(ok({ id: 'n1', type: 'device', data: {} }));
		const qc = freshClient();
		qc.setQueryData(qk.nodeContent('t', 'p', 'n1'), { body: 'old' });
		qc.setQueryData(qk.nodeContent('t', 'p', 'n1', { asOf: 5 }), { body: 'old-asof' });

		const { result } = renderHook(() => useUpdateNodeBody('t', 'p', 'n1'), {
			wrapper: wrapperFor(qc),
		});
		await act(async () => {
			await result.current.mutateAsync('new body');
		});

		expect(qc.getQueryState(qk.nodeContent('t', 'p', 'n1'))?.isInvalidated).toBe(true);
		expect(qc.getQueryState(qk.nodeContent('t', 'p', 'n1', { asOf: 5 }))?.isInvalidated).toBe(true);
	});

	it('useUpdateNode invalidates the live and asOf node + content cache', async () => {
		fetchMock.mockResolvedValue(ok({ id: 'n1', type: 'device', data: { crit: 9 } }));
		const qc = freshClient();
		qc.setQueryData(qk.node('t', 'p', 'n1'), { id: 'n1', type: 'device', data: {} });
		qc.setQueryData(qk.node('t', 'p', 'n1', { asOf: 5 }), { id: 'n1', type: 'device', data: {} });
		qc.setQueryData(qk.nodeContent('t', 'p', 'n1'), { body: 'old' });
		qc.setQueryData(qk.nodeContent('t', 'p', 'n1', { asOf: 5 }), { body: 'old-asof' });

		const { result } = renderHook(() => useUpdateNode('t', 'p', 'n1'), { wrapper: wrapperFor(qc) });
		await act(async () => {
			await result.current.mutateAsync({ data: { crit: 9 } });
		});

		expect(qc.getQueryState(qk.node('t', 'p', 'n1'))?.isInvalidated).toBe(true);
		expect(qc.getQueryState(qk.node('t', 'p', 'n1', { asOf: 5 }))?.isInvalidated).toBe(true);
		expect(qc.getQueryState(qk.nodeContent('t', 'p', 'n1'))?.isInvalidated).toBe(true);
		expect(qc.getQueryState(qk.nodeContent('t', 'p', 'n1', { asOf: 5 }))?.isInvalidated).toBe(true);
	});

	it('useCreateEdge invalidates the live and asOf neighbors cache for both endpoints', async () => {
		fetchMock.mockResolvedValue(ok({ id: 'e1' }));
		const qc = freshClient();
		for (const id of ['src1', 'dst1']) {
			qc.setQueryData(qk.neighbors('t', 'p', id), []);
			qc.setQueryData(qk.neighbors('t', 'p', id, { asOf: 5 }), []);
		}

		const { result } = renderHook(() => useCreateEdge('t', 'p'), { wrapper: wrapperFor(qc) });
		await act(async () => {
			await result.current.mutateAsync({ rel: 'knows', src: 'src1', dst: 'dst1' });
		});

		for (const id of ['src1', 'dst1']) {
			expect(qc.getQueryState(qk.neighbors('t', 'p', id))?.isInvalidated).toBe(true);
			expect(qc.getQueryState(qk.neighbors('t', 'p', id, { asOf: 5 }))?.isInvalidated).toBe(true);
		}
	});

	it('useDeleteEdge invalidates the live and asOf neighbors cache for both endpoints', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 204, json: async () => undefined } as Response);
		const qc = freshClient();
		for (const id of ['src1', 'dst1']) {
			qc.setQueryData(qk.neighbors('t', 'p', id), []);
			qc.setQueryData(qk.neighbors('t', 'p', id, { asOf: 5 }), []);
		}

		const { result } = renderHook(() => useDeleteEdge('t', 'p'), { wrapper: wrapperFor(qc) });
		await act(async () => {
			await result.current.mutateAsync({ id: 'e1', source: 'src1', target: 'dst1' });
		});

		for (const id of ['src1', 'dst1']) {
			expect(qc.getQueryState(qk.neighbors('t', 'p', id))?.isInvalidated).toBe(true);
			expect(qc.getQueryState(qk.neighbors('t', 'p', id, { asOf: 5 }))?.isInvalidated).toBe(true);
		}
	});
});

/**
 * `useGraphSlice`/`useTimeline` scope their `keepPreviousData` placeholder to (tenant, project) —
 * see `sameScopePlaceholder` in `use-graph.ts`. A same-scope key change (a scrub step, a zoom) must
 * retain the previous data so `isLoading` never flips true — that's what keeps the canvas mounted
 * during playback. A tenant/project change must NOT retain it: the route doesn't remount across
 * that switch, so an unscoped placeholder would keep painting the previous scope's data — for the
 * graph slice, that includes node ids a click would carry into a lookup under the new scope.
 */
describe('useGraphSlice / useTimeline placeholders are scoped to (tenant, project)', () => {
	let fetchMock: ReturnType<typeof mock>;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		setToken(null);
		fetchMock = mock();
		originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('useGraphSlice retains the previous slice across an asOf change in the same scope', async () => {
		const qc = freshClient();
		fetchMock.mockResolvedValue(
			ok({ nodes: [{ id: 'n1', type: 'device' }], links: [], truncated: false }),
		);

		const { result, rerender } = renderHook(
			(props: { tenant: string; project: string; filters: { asOf?: number } }) =>
				useGraphSlice(props.tenant, props.project, props.filters),
			{
				wrapper: wrapperFor(qc),
				initialProps: { tenant: 't1', project: 'p1', filters: { asOf: 1 } },
			},
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.nodes[0]?.id).toBe('n1');

		fetchMock.mockResolvedValue(
			ok({ nodes: [{ id: 'n2', type: 'device' }], links: [], truncated: false }),
		);
		rerender({ tenant: 't1', project: 'p1', filters: { asOf: 2 } });

		// Retained in the same render pass as the key change — isLoading never flips true, which is
		// what keeps `GraphShell` out of its loading branch and the canvas mounted during playback.
		expect(result.current.isLoading).toBe(false);
		expect(result.current.data?.nodes[0]?.id).toBe('n1');

		await waitFor(() => expect(result.current.data?.nodes[0]?.id).toBe('n2'));
	});

	it('useGraphSlice does not retain data across a tenant/project change', async () => {
		const qc = freshClient();
		fetchMock.mockResolvedValue(
			ok({ nodes: [{ id: 'n1', type: 'device' }], links: [], truncated: false }),
		);

		const { result, rerender } = renderHook(
			(props: { tenant: string; project: string; filters: { asOf?: number } }) =>
				useGraphSlice(props.tenant, props.project, props.filters),
			{
				wrapper: wrapperFor(qc),
				initialProps: { tenant: 't1', project: 'p1', filters: { asOf: 1 } },
			},
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		fetchMock.mockResolvedValue(ok({ nodes: [], links: [], truncated: false }));
		rerender({ tenant: 't2', project: 'p1', filters: { asOf: 1 } });

		// No placeholder across a scope change: a real loading state, not the previous project's slice
		// (and not its node ids, which a click would otherwise carry into a wrong-scope lookup).
		expect(result.current.isLoading).toBe(true);
		expect(result.current.data).toBeUndefined();

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
	});

	it('useTimeline retains the previous window across a same-scope zoom', async () => {
		const qc = freshClient();
		fetchMock.mockResolvedValue(
			ok({
				min: 0,
				max: 100,
				total: 2,
				from: 0,
				to: 100,
				buckets: [1, 1],
				ticks: [0, 100],
				ticksTruncated: false,
			}),
		);

		const { result, rerender } = renderHook(
			(props: { tenant: string; project: string; window: { from?: number; to?: number } }) =>
				useTimeline(props.tenant, props.project, props.window),
			{
				wrapper: wrapperFor(qc),
				initialProps: { tenant: 't1', project: 'p1', window: { from: 0, to: 100 } },
			},
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.to).toBe(100);

		fetchMock.mockResolvedValue(
			ok({
				min: 0,
				max: 100,
				total: 1,
				from: 25,
				to: 75,
				buckets: [1],
				ticks: [50],
				ticksTruncated: false,
			}),
		);
		rerender({ tenant: 't1', project: 'p1', window: { from: 25, to: 75 } });

		expect(result.current.isLoading).toBe(false);
		expect(result.current.data?.to).toBe(100);

		await waitFor(() => expect(result.current.data?.to).toBe(75));
	});

	it('useTimeline does not retain data across a tenant/project change', async () => {
		const qc = freshClient();
		fetchMock.mockResolvedValue(
			ok({
				min: 0,
				max: 100,
				total: 2,
				from: 0,
				to: 100,
				buckets: [1, 1],
				ticks: [0, 100],
				ticksTruncated: false,
			}),
		);

		const { result, rerender } = renderHook(
			(props: { tenant: string; project: string; window: { from?: number; to?: number } }) =>
				useTimeline(props.tenant, props.project, props.window),
			{
				wrapper: wrapperFor(qc),
				initialProps: { tenant: 't1', project: 'p1', window: { from: 0, to: 100 } },
			},
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		fetchMock.mockResolvedValue(
			ok({
				min: 0,
				max: 50,
				total: 1,
				from: 0,
				to: 50,
				buckets: [1],
				ticks: [10],
				ticksTruncated: false,
			}),
		);
		rerender({ tenant: 't1', project: 'p2', window: { from: 0, to: 100 } });

		expect(result.current.isLoading).toBe(true);
		expect(result.current.data).toBeUndefined();

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
	});
});
