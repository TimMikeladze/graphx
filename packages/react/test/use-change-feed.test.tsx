import './dom-setup.ts';
import { afterEach, expect, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { graphKeys } from '../src/keys.ts';
import { type Harness, hooks, makeWrapper, mkEdge, mkNode, setup } from './harness.tsx';

afterEach(cleanup);

// The CDC hook's job is: on each poll, invalidate exactly the affected keys + advance the keyset
// cursor. `refetchInterval` itself is RQ's (well-tested) feature and doesn't fire under happy-dom's
// frozen timers, so each poll is driven deterministically via `qc.refetchQueries(changes())`.
function poll(qc: { refetchQueries: (o: unknown) => Promise<unknown> }, h: Harness) {
	return act(async () => {
		await qc.refetchQueries({ queryKey: graphKeys(h.project).changes() });
	});
}

test('useChangeFeedSync: an out-of-band node update invalidates useNode', async () => {
	const h = await setup();
	const id = await mkNode(h, h.editor, 'device', { type: 'router' });
	const { Wrapper, qc } = makeWrapper(h, h.editor);

	const node = renderHook(() => hooks.useNode(id), { wrapper: Wrapper });
	const cdc = renderHook(() => hooks.useChangeFeedSync({ intervalMs: 10_000_000 }), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(node.result.current.data?.props.crit).toBe(1));
	await waitFor(() => expect(cdc.result.current.isSuccess).toBe(true)); // initial poll: consume INSERT

	// out-of-band update (NOT via a mutation hook) — only the feed can drive the invalidation
	await h.app.request(`/t/${h.tenant}/p/${h.project}/nodes/${id}`, {
		method: 'PATCH',
		headers: { 'x-user': h.editor, 'x-tenant': h.tenant, 'content-type': 'application/json' },
		body: JSON.stringify({ props: { crit: 7 } }),
	});
	await poll(qc, h);

	await waitFor(() => expect(node.result.current.data?.props.crit).toBe(7));
	h.cleanup();
});

test('useChangeFeedSync: an out-of-band edge add invalidates neighbors', async () => {
	const h = await setup();
	const p1 = await mkNode(h, h.editor, 'person', { name: 'p1' });
	const p2 = await mkNode(h, h.editor, 'person', { name: 'p2' });
	const { Wrapper, qc } = makeWrapper(h, h.editor);

	const nbrs = renderHook(() => hooks.useNeighbors(p1), { wrapper: Wrapper });
	const cdc = renderHook(() => hooks.useChangeFeedSync({ intervalMs: 10_000_000 }), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(nbrs.result.current.isSuccess).toBe(true));
	await waitFor(() => expect(cdc.result.current.isSuccess).toBe(true));
	expect(nbrs.result.current.data!.pages.flatMap((p) => p.rows).length).toBe(0);

	await mkEdge(h, h.editor, 'knows', p1, p2); // out-of-band
	await poll(qc, h);

	await waitFor(() => {
		const ids = nbrs.result.current.data!.pages.flatMap((p) => p.rows.map((r) => r.id));
		expect(ids).toContain(p2);
	});
	h.cleanup();
});

test('useChangeFeedSync: an out-of-band node insert refreshes useListNodes', async () => {
	const h = await setup();
	const { Wrapper, qc } = makeWrapper(h, h.editor);

	const list = renderHook(() => hooks.useListNodes(), { wrapper: Wrapper });
	const cdc = renderHook(() => hooks.useChangeFeedSync({ intervalMs: 10_000_000 }), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
	await waitFor(() => expect(cdc.result.current.isSuccess).toBe(true));
	expect(list.result.current.data!.pages.flatMap((p) => p.nodes).length).toBe(0);

	const id = await mkNode(h, h.editor, 'person', { name: 'x' }); // out-of-band insert
	await poll(qc, h);

	await waitFor(() => {
		const ids = list.result.current.data!.pages.flatMap((p) => p.nodes.map((n) => n.id));
		expect(ids).toContain(id);
	});
	h.cleanup();
});

test('useChangeFeedSync fromNow: skips the existing backlog, reacts to new writes', async () => {
	const h = await setup();
	await mkNode(h, h.editor, 'person', { name: 'old' }); // backlog written before mount
	const { Wrapper, qc } = makeWrapper(h, h.editor);

	const cdc = renderHook(() => hooks.useChangeFeedSync({ intervalMs: 10_000_000, fromNow: true }), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(cdc.result.current.isSuccess).toBe(true)); // prime poll
	expect(cdc.result.current.data!.nodes.length).toBe(0); // backlog skipped

	const id = await mkNode(h, h.editor, 'person', { name: 'new' });
	await poll(qc, h);
	await waitFor(() =>
		expect(cdc.result.current.data!.nodes.map((n) => String((n as { id: unknown }).id))).toContain(
			id,
		),
	);
	h.cleanup();
});

test('useChangeFeedSync: advances its keyset cursor (a quiet poll sees nothing new)', async () => {
	const h = await setup();
	await mkNode(h, h.editor, 'person', { name: 'p1' });
	const { Wrapper, qc } = makeWrapper(h, h.editor);

	const cdc = renderHook(() => hooks.useChangeFeedSync({ intervalMs: 10_000_000 }), {
		wrapper: Wrapper,
	});
	await waitFor(() => expect(cdc.result.current.isSuccess).toBe(true)); // poll 1: sees the node
	expect(cdc.result.current.data!.nodes.length).toBe(1);

	await poll(qc, h); // poll 2: nothing written since → empty (cursor advanced past poll 1)
	await waitFor(() => expect(cdc.result.current.data!.nodes.length).toBe(0));
	h.cleanup();
});
