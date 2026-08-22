import './dom-setup.ts';
import { afterEach, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { createGraphHooks } from '../src/create-hooks.ts';
import { graphKeys } from '../src/keys.ts';
import { GraphProvider } from '../src/provider.tsx';
import { SCHEMA } from './harness.tsx';

afterEach(cleanup);

// useGraphEvents (eventing Layer 3): the SSE push hook. Its contract is "parse each frame → invalidate
// EXACTLY the affected keys", and its differentiator over the poll feed is delete-INCLUSIVE handling
// (edge.delete / edge.supersede carry src/dst → both neighbor caches invalidate). Here that contract
// is driven against a canned SSE stream — deterministic, no server, no timers. The route + live push
// (incl. delete-inclusive replay) are integration-tested in core: test/serve-events.test.ts. (A live
// React integration test is precluded here: happy-dom's fake timers stall the server-side poll loop.)

const hooks = createGraphHooks(SCHEMA);

/** A Response whose body streams the given SSE text once, then closes. */
function sseResponse(sse: string): Response {
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(new TextEncoder().encode(sse));
			c.close();
		},
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function frame(ev: Record<string, unknown>): string {
	return `event: ${ev.op}\ndata: ${JSON.stringify(ev)}\nid: ${ev.seq}\n\n`;
}

/** Mount useGraphEvents against a fetch that yields `events`; capture every invalidated query key. */
function mountWithEvents(events: Array<Record<string, unknown>>): {
	keys: unknown[][];
	unmount: () => void;
} {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const keys: unknown[][] = [];
	const orig = qc.invalidateQueries.bind(qc);
	(
		qc as unknown as { invalidateQueries: (o: { queryKey?: unknown[] }) => unknown }
	).invalidateQueries = (o) => {
		if (o?.queryKey) keys.push(o.queryKey);
		return orig(o as never);
	};
	const fakeFetch = (() =>
		Promise.resolve(sseResponse(events.map(frame).join('')))) as unknown as typeof fetch;
	function Wrapper({ children }: { children: ReactNode }) {
		return createElement(
			QueryClientProvider,
			{ client: qc },
			createElement(
				GraphProvider,
				{ baseUrl: '', tenant: 't', project: 'p', headers: () => ({}), fetch: fakeFetch },
				children,
			),
		);
	}
	const { unmount } = renderHook(() => hooks.useGraphEvents({ since: 'beginning' }), {
		wrapper: Wrapper,
	});
	return { keys, unmount };
}

const hasKey = (keys: unknown[][], want: unknown[]): boolean =>
	keys.some((k) => JSON.stringify(k) === JSON.stringify(want));

test('an edge.delete frame invalidates BOTH endpoint neighbor caches (delete-inclusive)', async () => {
	const k = graphKeys('p');
	const { keys, unmount } = mountWithEvents([
		{
			seq: 7,
			op: 'edge.delete',
			entity: 'edge',
			id: 'E',
			label: 'knows',
			shape: 'close',
			ts: 1,
			src: 'P1',
			dst: 'P2',
		},
	]);
	await waitFor(() => expect(hasKey(keys, k.neighbors('P1'))).toBe(true));
	expect(hasKey(keys, k.neighbors('P2'))).toBe(true);
	unmount();
});

test('an edge.supersede frame invalidates the CLOSED edge endpoints', async () => {
	const k = graphKeys('p');
	const { keys, unmount } = mountWithEvents([
		{
			seq: 8,
			op: 'edge.supersede',
			entity: 'edge',
			id: 'OLD',
			label: 'licensed',
			shape: 'close',
			ts: 1,
			src: 'P1',
			dst: 'D1',
		},
	]);
	await waitFor(() => expect(hasKey(keys, k.neighbors('P1'))).toBe(true));
	expect(hasKey(keys, k.neighbors('D1'))).toBe(true);
	unmount();
});

test('a node event invalidates node(id) + the list/slice views', async () => {
	const k = graphKeys('p');
	const { keys, unmount } = mountWithEvents([
		{
			seq: 9,
			op: 'node.update',
			entity: 'node',
			id: 'N1',
			label: 'person',
			shape: 'insert',
			ts: 1,
		},
	]);
	await waitFor(() => expect(hasKey(keys, k.node('N1'))).toBe(true));
	expect(hasKey(keys, [...k.all, 'listNodes'])).toBe(true);
	expect(hasKey(keys, [...k.all, 'graphSlice'])).toBe(true);
	unmount();
});

test('multiple frames in one stream chunk are all processed', async () => {
	const k = graphKeys('p');
	const { keys, unmount } = mountWithEvents([
		{ seq: 1, op: 'node.create', entity: 'node', id: 'A', label: 'person', shape: 'insert', ts: 1 },
		{
			seq: 2,
			op: 'edge.create',
			entity: 'edge',
			id: 'E',
			label: 'knows',
			shape: 'insert',
			ts: 1,
			src: 'A',
			dst: 'B',
		},
	]);
	await waitFor(() => expect(hasKey(keys, k.node('A'))).toBe(true));
	expect(hasKey(keys, k.neighbors('A'))).toBe(true);
	expect(hasKey(keys, k.neighbors('B'))).toBe(true);
	unmount();
});

test('a node.delete frame invalidates neighbor caches broadly (node events carry no src/dst)', async () => {
	const k = graphKeys('p');
	const { keys, unmount } = mountWithEvents([
		{
			seq: 10,
			op: 'node.delete',
			entity: 'node',
			id: 'N9',
			label: 'person',
			shape: 'close',
			ts: 1,
		},
	]);
	await waitFor(() => expect(hasKey(keys, k.node('N9'))).toBe(true));
	expect(hasKey(keys, [...k.all, 'neighbors'])).toBe(true);
	unmount();
});
