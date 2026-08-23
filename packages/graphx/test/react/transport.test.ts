import { expect, test } from 'bun:test';
import { GraphError } from '../../src/react/errors.ts';
import { type GraphTransport, request } from '../../src/react/transport.ts';

/** A capturing fake fetch that returns a scripted Response. */
function fakeFetch(
	res: Response,
	captured: { url?: string; init?: RequestInit } = {},
): typeof fetch {
	return (async (input: string, init?: RequestInit) => {
		captured.url = String(input);
		captured.init = init;
		return res;
	}) as unknown as typeof fetch;
}

function t(fetch: typeof fetch, headers?: GraphTransport['headers']): GraphTransport {
	return { baseUrl: 'http://x', tenant: 'tn', project: 'pr', fetch, headers };
}

test('request: builds the /t/:tenant/p/:project URL with method + JSON body', async () => {
	const cap: { url?: string; init?: RequestInit } = {};
	const f = fakeFetch(new Response(JSON.stringify({ ok: 1 }), { status: 200 }), cap);
	const out = await request<{ ok: number }>(t(f), {
		method: 'POST',
		path: '/nodes',
		body: { type: 'x' },
	});
	expect(out).toEqual({ ok: 1 });
	expect(cap.url).toBe('http://x/t/tn/p/pr/nodes');
	expect(cap.init?.method).toBe('POST');
	expect(JSON.parse(String(cap.init?.body))).toEqual({ type: 'x' });
	expect(new Headers(cap.init?.headers).get('content-type')).toBe('application/json');
});

test('request: appends defined query params, omits undefined', async () => {
	const cap: { url?: string; init?: RequestInit } = {};
	const f = fakeFetch(new Response('[]', { status: 200 }), cap);
	await request(t(f), { method: 'GET', path: '/changes', query: { limit: 2, nodes: undefined } });
	expect(cap.url).toBe('http://x/t/tn/p/pr/changes?limit=2');
});

test('request: merges auth headers from the headers getter', async () => {
	const cap: { url?: string; init?: RequestInit } = {};
	const f = fakeFetch(new Response('{}', { status: 200 }), cap);
	await request(
		t(f, () => ({ authorization: 'Bearer z' })),
		{ method: 'GET', path: '/x' },
	);
	expect(new Headers(cap.init?.headers).get('authorization')).toBe('Bearer z');
});

test('request: non-2xx throws GraphError with status, message, issues', async () => {
	const f = fakeFetch(
		new Response(JSON.stringify({ error: 'validation', issues: [{ path: ['k'] }] }), {
			status: 400,
		}),
	);
	const err = await request(t(f), { method: 'POST', path: '/nodes', body: {} }).catch((e) => e);
	expect(err).toBeInstanceOf(GraphError);
	expect(err.status).toBe(400);
	expect(err.message).toBe('validation');
	expect(err.issues).toEqual([{ path: ['k'] }]);
});

test('request: a plain-text error body (Hono HTTPException) becomes the GraphError message', async () => {
	const f = fakeFetch(new Response('node not found', { status: 404 }));
	const err = await request(t(f), { method: 'GET', path: '/nodes/x' }).catch((e) => e);
	expect(err).toBeInstanceOf(GraphError);
	expect(err.status).toBe(404);
	expect(err.message).toBe('node not found');
});

test('request: 204 No Content resolves to undefined', async () => {
	const f = fakeFetch(new Response(null, { status: 204 }));
	expect(await request(t(f), { method: 'DELETE', path: '/edges/e1' })).toBeUndefined();
});
