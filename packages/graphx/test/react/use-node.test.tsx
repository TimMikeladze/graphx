import './dom-setup.ts';
import { expect, test } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { hooks, makeWrapper, mkNode, setup } from './harness.tsx';

test('useNode: fetches a node over HTTP and exposes typed data', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'device', { type: 'router' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const { result } = renderHook(() => hooks.useNode(id), { wrapper: Wrapper });
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(result.current.data?.id).toBe(id);
	expect(result.current.data?.data).toEqual({ type: 'router', crit: 1 });
	h.cleanup();
});

test('useNode(id, type): narrows to that type; a mismatched type resolves to null', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'device', { type: 'router' });
	const { Wrapper } = makeWrapper(h, h.editor);

	const right = renderHook(() => hooks.useNode(id, 'device'), { wrapper: Wrapper });
	await waitFor(() => expect(right.result.current.isSuccess).toBe(true));
	expect(right.result.current.data?.data.type).toBe('router'); // typed as NodeOf<S,'device'>

	const wrong = renderHook(() => hooks.useNode(id, 'person'), { wrapper: Wrapper });
	await waitFor(() => expect(wrong.result.current.isSuccess).toBe(true));
	expect(wrong.result.current.data).toBe(null); // runtime type guard
	h.cleanup();
});

test('useNode: a missing id resolves to null (not an error)', async () => {
	const h = await setup();
	const { Wrapper } = makeWrapper(h, h.editor);
	const { result } = renderHook(() => hooks.useNode('01ARZ3NDEKTSV4RRFFQ69G5FAV'), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(result.current.data).toBe(null);
	h.cleanup();
});
