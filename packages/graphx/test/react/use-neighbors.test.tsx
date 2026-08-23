import './dom-setup.ts';
import { expect, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { hooks, makeWrapper, mkEdge, mkNode, setup } from './harness.tsx';

test('useNeighbors: infinite query pages neighbors by cursor (no skip/dup)', async () => {
	const h = await setup();
	const p1 = await mkNode(h, h.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(h, h.editor, 'person', { name: 'p2' });
	const p3 = await mkNode(h, h.editor, 'person', { name: 'p3' });
	await mkEdge(h, h.editor, 'knows', p1, p2);
	await mkEdge(h, h.editor, 'knows', p1, p3);
	const { Wrapper } = makeWrapper(h, h.editor);

	const { result } = renderHook(() => hooks.useNeighbors(p1, { limit: 1 }), { wrapper: Wrapper });
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(result.current.data!.pages[0]!.rows.length).toBe(1);
	expect(result.current.hasNextPage).toBe(true);

	await act(async () => {
		await result.current.fetchNextPage();
	});
	await waitFor(() => expect(result.current.data!.pages.length).toBe(2));

	const ids = new Set(result.current.data!.pages.flatMap((p) => p.rows.map((r) => r.id)));
	expect(ids).toEqual(new Set([p2, p3]));
	expect(result.current.hasNextPage).toBe(false);
	h.cleanup();
});

test('useNeighbors(id, {rel}): narrows to the rel target type and filters to it', async () => {
	const h = await setup();
	const ada = await mkNode(h, h.editor, 'person', { name: 'ada' });
	const router = await mkNode(h, h.editor, 'device', { type: 'router' });
	const bob = await mkNode(h, h.editor, 'person', { name: 'bob' });
	await mkEdge(h, h.editor, 'owns', ada, router, { since: 1 }); // ada -owns-> device
	await mkEdge(h, h.editor, 'knows', ada, bob); // ada -knows-> person
	const { Wrapper } = makeWrapper(h, h.editor);

	const r = renderHook(() => hooks.useNeighbors(ada, { rel: 'owns', direction: 'forward' }), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(r.result.current.isSuccess).toBe(true));
	const rows = r.result.current.data!.pages.flatMap((p) => p.rows);
	expect(rows.map((n) => n.id)).toEqual([router]);
	expect(rows[0]!.data.type).toBe('router'); // typed as NodeOf<S,'device'>
	h.cleanup();
});

test('useListNodes({type}): narrows to that type', async () => {
	const h = await setup();
	await mkNode(h, h.editor, 'person', { name: 'a' });
	const d = await mkNode(h, h.editor, 'device', { type: 'router' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const r = renderHook(() => hooks.useListNodes({ type: 'device' }), { wrapper: Wrapper });
	await waitFor(() => expect(r.result.current.isSuccess).toBe(true));
	const nodes = r.result.current.data!.pages.flatMap((p) => p.nodes);
	expect(nodes.map((n) => n.id)).toEqual([d]);
	expect(nodes[0]!.data.type).toBe('router'); // typed as NodeOf<S,'device'>
	h.cleanup();
});

test('useListNodes: infinite query over the node list', async () => {
	const h = await setup();
	await mkNode(h, h.editor, 'person', { name: 'a' });
	await mkNode(h, h.editor, 'person', { name: 'b' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const { result } = renderHook(() => hooks.useListNodes({ limit: 1 }), { wrapper: Wrapper });
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(result.current.data!.pages[0]!.nodes.length).toBe(1);
	expect(result.current.hasNextPage).toBe(true);
	h.cleanup();
});
