import './dom-setup.ts';
import { afterEach, expect, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { hooks, makeWrapper, mkEdge, mkNode, setup } from './harness.tsx';

afterEach(cleanup);

test('useAddNode: creates a node and returns it with server defaults', async () => {
	const h = await setup();
	const { Wrapper } = makeWrapper(h, h.editor);
	const { result } = renderHook(() => hooks.useAddNode(), { wrapper: Wrapper });

	let created: any;
	await act(async () => {
		created = await result.current.mutateAsync({ type: 'device', data: { type: 'router' } });
	});
	expect(created.id.length).toBe(26);
	expect(created.data).toEqual({ type: 'router', crit: 1 });
	h.cleanup();
});

test('useAddNode: viewer write -> mutation error (403)', async () => {
	const h = await setup();
	const { Wrapper } = makeWrapper(h, h.viewer);
	const { result } = renderHook(() => hooks.useAddNode(), { wrapper: Wrapper });
	let err: any;
	await act(async () => {
		err = await result.current.mutateAsync({ type: 'person', data: { name: 'x' } }).catch((e) => e);
	});
	expect(err.status).toBe(403);
	h.cleanup();
});

test('useAddEdge: invalidates neighbors so a mounted useNeighbors refetches', async () => {
	const h = await setup();
	const p1 = await mkNode(h, h.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(h, h.editor, 'person', { name: 'p2' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const nbrs = renderHook(() => hooks.useNeighbors(p1), { wrapper: Wrapper });
	const add = renderHook(() => hooks.useAddEdge(), { wrapper: Wrapper });
	await waitFor(() => expect(nbrs.result.current.isSuccess).toBe(true));
	expect(nbrs.result.current.data!.pages.flatMap((p) => p.rows).length).toBe(0);

	await act(async () => {
		await add.result.current.mutateAsync({ rel: 'knows', src: p1, dst: p2 });
	});
	await waitFor(() => {
		const ids = nbrs.result.current.data!.pages.flatMap((p) => p.rows.map((r) => r.id));
		expect(ids).toContain(p2);
	});
	h.cleanup();
});

test('useUpdateNode: invalidates node(id) so a mounted useNode refetches', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'device', { type: 'router' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const node = renderHook(() => hooks.useNode(id), { wrapper: Wrapper });
	const upd = renderHook(() => hooks.useUpdateNode(), { wrapper: Wrapper });
	await waitFor(() => expect(node.result.current.isSuccess).toBe(true));
	expect(node.result.current.data!.data).toEqual({ type: 'router', crit: 1 });

	await act(async () => {
		await upd.result.current.mutateAsync({ id, patch: { data: { crit: 9 } } });
	});
	await waitFor(() => expect(node.result.current.data!.data).toEqual({ type: 'router', crit: 9 }));
	h.cleanup();
});

test('useDeleteEdge: invalidates neighbors(src/dst) so the edge disappears', async () => {
	const h = await setup();
	const p1 = await mkNode(h, h.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(h, h.editor, 'person', { name: 'p2' });
	const eid = await mkEdge(h, h.editor, 'knows', p1, p2);
	const { Wrapper } = makeWrapper(h, h.editor);

	const nbrs = renderHook(() => hooks.useNeighbors(p1), { wrapper: Wrapper });
	const del = renderHook(() => hooks.useDeleteEdge(), { wrapper: Wrapper });
	await waitFor(() => expect(nbrs.result.current.isSuccess).toBe(true));
	expect(nbrs.result.current.data!.pages.flatMap((p) => p.rows.map((r) => r.id))).toContain(p2);

	await act(async () => {
		await del.result.current.mutateAsync({ id: eid, src: p1, dst: p2 });
	});
	await waitFor(() =>
		expect(nbrs.result.current.data!.pages.flatMap((p) => p.rows).length).toBe(0),
	);
	h.cleanup();
});

test('useBulkLoad: loads rows and returns the result', async () => {
	const h = await setup();
	const { Wrapper } = makeWrapper(h, h.editor);
	const { result } = renderHook(() => hooks.useBulkLoad(), { wrapper: Wrapper });

	let out: any;
	await act(async () => {
		out = await result.current.mutateAsync({
			rows: [
				{ type: 'person', data: { name: 'a' } },
				{ type: 'person', data: { name: 'b' } },
			],
		});
	});
	expect(out.count).toBe(2);
	expect(out.ids.length).toBe(2);
	h.cleanup();
});

test('usePagerank: persists scores for every node', async () => {
	const h = await setup();
	const a = await mkNode(h, h.editor, 'person', { name: 'a' });
	const b = await mkNode(h, h.editor, 'person', { name: 'b' });
	await mkEdge(h, h.editor, 'knows', a, b);
	const { Wrapper } = makeWrapper(h, h.editor);
	const { result } = renderHook(() => hooks.usePagerank(), { wrapper: Wrapper });

	let out: any;
	await act(async () => {
		out = await result.current.mutateAsync({});
	});
	expect(Object.keys(out.scores).length).toBe(2);
	h.cleanup();
});

test('useDeleteNode: removes the node so useNode resolves to null', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'device', { type: 'router' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const node = renderHook(() => hooks.useNode(id), { wrapper: Wrapper });
	const del = renderHook(() => hooks.useDeleteNode(), { wrapper: Wrapper });
	await waitFor(() => expect(node.result.current.data?.id).toBe(id));

	await act(async () => {
		await del.result.current.mutateAsync({ id });
	});
	await waitFor(() => expect(node.result.current.data).toBe(null));
	h.cleanup();
});

test('useDeleteNode: a retracted node drops from other nodes neighbor lists', async () => {
	const h = await setup();
	const a = await mkNode(h, h.editor, 'person', { name: 'a' });
	const b = await mkNode(h, h.editor, 'person', { name: 'b' });
	await mkEdge(h, h.editor, 'knows', b, a); // b -> a, so a is b's neighbor
	const { Wrapper } = makeWrapper(h, h.editor);

	const nbrs = renderHook(() => hooks.useNeighbors(b), { wrapper: Wrapper });
	const del = renderHook(() => hooks.useDeleteNode(), { wrapper: Wrapper });
	await waitFor(() =>
		expect(nbrs.result.current.data!.pages.flatMap((p) => p.rows.map((r) => r.id))).toContain(a),
	);

	await act(async () => {
		await del.result.current.mutateAsync({ id: a });
	});
	await waitFor(() =>
		expect(
			nbrs.result.current.data!.pages.flatMap((p) => p.rows.map((r) => r.id)),
		).not.toContain(a),
	);
	h.cleanup();
});

test('useUpdateNode: invalidates listNodes so list views show the new data', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'device', { type: 'router' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const list = renderHook(() => hooks.useListNodes(), { wrapper: Wrapper });
	const upd = renderHook(() => hooks.useUpdateNode(), { wrapper: Wrapper });
	const crit = () =>
		list.result.current
			.data!.pages.flatMap((p) => p.nodes)
			.find((n) => n.id === id)?.data.crit;
	await waitFor(() => expect(crit()).toBe(1));

	await act(async () => {
		await upd.result.current.mutateAsync({ id, patch: { data: { crit: 9 } } });
	});
	await waitFor(() => expect(crit()).toBe(9));
	h.cleanup();
});

test('useCommunity: returns a label per node', async () => {
	const h = await setup();
	const a = await mkNode(h, h.editor, 'person', { name: 'a' });
	const b = await mkNode(h, h.editor, 'person', { name: 'b' });
	await mkEdge(h, h.editor, 'knows', a, b);
	const { Wrapper } = makeWrapper(h, h.editor);
	const { result } = renderHook(() => hooks.useCommunity(), { wrapper: Wrapper });

	let out: any;
	await act(async () => {
		out = await result.current.mutateAsync({});
	});
	expect(Object.keys(out.scores).length).toBe(2);
	h.cleanup();
});

test('useCentrality: returns degree scores', async () => {
	const h = await setup();
	const a = await mkNode(h, h.editor, 'person', { name: 'a' });
	const b = await mkNode(h, h.editor, 'person', { name: 'b' });
	await mkEdge(h, h.editor, 'knows', a, b);
	const { Wrapper } = makeWrapper(h, h.editor);
	const { result } = renderHook(() => hooks.useCentrality(), { wrapper: Wrapper });

	let out: any;
	await act(async () => {
		out = await result.current.mutateAsync({ type: 'out' });
	});
	expect(out.scores[a]).toBe(1);
	expect(out.scores[b]).toBe(0);
	h.cleanup();
});
