import './dom-setup.ts';
import { expect, test } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { type Harness, hooks, makeWrapper, mkEdge, mkNode, setup, vec } from './harness.tsx';

/** Render a query hook as the given user, wait for success, return its data. */
async function read<T>(h: Harness, user: string, hookFn: () => { isSuccess: boolean; data: T }) {
	const { Wrapper } = makeWrapper(h, user);
	const { result } = renderHook(hookFn, { wrapper: Wrapper });
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	return result.current.data;
}

test('useHistory: returns the version trail for a node', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'device', { type: 'router' });
	const versions = await read<any[]>(h, h.viewer, () => hooks.useHistory(id));
	expect(versions.length).toBe(1);
	expect(versions[0].id).toBe(id);
	h.cleanup();
});

test('useGraphSlice: returns the canvas slice (nodes + links)', async () => {
	const h = await setup();
	const p1 = await mkNode(h, h.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(h, h.editor, 'person', { name: 'p2' });
	await mkEdge(h, h.editor, 'knows', p1, p2);
	const slice = await read<{ nodes: unknown[]; links: unknown[] }>(h, h.viewer, () =>
		hooks.useGraphSlice(),
	);
	expect(slice.nodes.length).toBe(2);
	expect(slice.links.length).toBe(1);
	h.cleanup();
});

test('useRetrieve: ANN search returns the matching node', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'person', { name: 'a' }, { body: 'gateway', emb: vec(7) });
	const rows = await read<Array<{ id: string }>>(h, h.viewer, () =>
		hooks.useRetrieve({ query: 'gateway' }),
	); // 'gateway'.length === 7 → embed vec(7) matches the node
	expect(rows.some((r) => r.id === id)).toBe(true);
	h.cleanup();
});

test('useHybrid: FTS leg returns body matches', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'person', { name: 'a' }, { body: 'alpha gateway' });
	const rows = await read<Array<{ id: string }>>(h, h.viewer, () =>
		hooks.useHybrid({ query: 'gateway', maxDepth: 0 }),
	);
	expect(rows.some((r) => r.id === id)).toBe(true);
	h.cleanup();
});

test('useJourney: reaches a downstream node', async () => {
	const h = await setup();
	const p1 = await mkNode(h, h.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(h, h.editor, 'person', { name: 'p2' });
	await mkEdge(h, h.editor, 'knows', p1, p2);
	const rows = await read<Array<{ id: string }>>(h, h.viewer, () =>
		hooks.useJourney({ start: p1, from: 0 }),
	);
	expect(rows.some((r) => r.id === p2)).toBe(true);
	h.cleanup();
});

test('useMatch: 2-hop pattern returns typed rows', async () => {
	const h = await setup();
	const ada = await mkNode(h, h.editor, 'person', { name: 'ada' });
	const router = await mkNode(h, h.editor, 'device', { type: 'router' });
	await mkEdge(h, h.editor, 'owns', ada, router, { since: 1 });
	const out = await read<{ rows: Array<{ a: { id: string }; b: { id: string } }> }>(
		h,
		h.viewer,
		() =>
			hooks.useMatch({
				steps: [
					{ node: { alias: 'a', kind: 'person' } },
					{ edge: { rel: 'owns', direction: 'out' } },
					{ node: { alias: 'b', kind: 'device' } },
				],
				select: ['a', 'b'],
			}),
	);
	expect(out.rows.length).toBe(1);
	expect(out.rows[0]!.b.id).toBe(router);
	h.cleanup();
});

test('useDiff: returns versions opened in the window', async () => {
	const h = await setup();
	await mkNode(h, h.editor, 'person', { name: 'p1' });
	const d = await read<{ nodes: unknown[]; edges: unknown[] }>(h, h.viewer, () =>
		hooks.useDiff(0, 9_000_000_000_000),
	);
	expect(d.nodes.length).toBe(1);
	h.cleanup();
});

test('useShortestPath: returns the weighted route', async () => {
	const h = await setup();
	const a = await mkNode(h, h.editor, 'person', { name: 'a' });
	const b = await mkNode(h, h.editor, 'person', { name: 'b' });
	await mkEdge(h, h.editor, 'knows', a, b);
	const r = await read<{ path: string[]; cost: number } | null>(h, h.viewer, () =>
		hooks.useShortestPath({ src: a, dst: b }),
	);
	expect(r!.path).toEqual([a, b]);
	h.cleanup();
});

test('useTopNodes: returns an array (smoke)', async () => {
	const h = await setup();
	await mkNode(h, h.editor, 'person', { name: 'a' });
	const rows = await read<unknown[]>(h, h.viewer, () => hooks.useTopNodes({ by: 'degree' }));
	expect(Array.isArray(rows)).toBe(true);
	h.cleanup();
});
