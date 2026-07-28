import { expect, test } from 'bun:test';
import { localBackend, remoteBackend } from '../src/backend.ts';

test('backend: local dispatches through app.fetch with no socket', async () => {
	const seen: Request[] = [];
	const app = {
		fetch: (req: Request) => {
			seen.push(req);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		},
	};
	const backend = localBackend(app, { 'x-user': 'u', 'x-tenant': 't' });
	const res = await backend.call('GET', '/t/t/p/p/nodes', { query: { limit: '5' } });

	expect(res.status).toBe(200);
	expect(seen).toHaveLength(1);
	const url = new URL(seen[0]!.url);
	expect(url.pathname).toBe('/t/t/p/p/nodes');
	expect(url.searchParams.get('limit')).toBe('5');
	expect(seen[0]!.headers.get('x-user')).toBe('u');
});

test('backend: local sends a JSON body on writes', async () => {
	let body: unknown;
	const app = {
		fetch: async (req: Request) => {
			body = await req.json();
			return new Response(null, { status: 201 });
		},
	};
	const backend = localBackend(app);
	await backend.call('POST', '/t/t/p/p/nodes', { body: { type: 'person', data: { name: 'a' } } });
	expect(body).toEqual({ type: 'person', data: { name: 'a' } });
});

test('backend: local omits an empty query string', async () => {
	const seen: string[] = [];
	const app = {
		fetch: (req: Request) => {
			seen.push(req.url);
			return new Response('{}', { status: 200 });
		},
	};
	await localBackend(app).call('GET', '/t/t/p/p/nodes', { query: {} });
	expect(seen[0]).not.toContain('?');
});

test('backend: remote targets the base url and sends the bearer credential', async () => {
	const seen: Request[] = [];
	const backend = remoteBackend({
		url: 'https://api.example.com',
		apiKey: 'k1',
		fetch: (req) => {
			seen.push(req);
			return Promise.resolve(new Response('{}', { status: 200 }));
		},
	});
	await backend.call('GET', '/t/t/p/p/nodes', { query: { limit: '5' } });

	expect(seen[0]!.url).toBe('https://api.example.com/t/t/p/p/nodes?limit=5');
	expect(seen[0]!.headers.get('authorization')).toBe('Bearer k1');
});

test('backend: remote tolerates a base url with a trailing slash', async () => {
	const seen: Request[] = [];
	const backend = remoteBackend({
		url: 'https://api.example.com/',
		fetch: (req) => {
			seen.push(req);
			return Promise.resolve(new Response('{}', { status: 200 }));
		},
	});
	await backend.call('GET', '/t/t/p/p/nodes');
	expect(seen[0]!.url).toBe('https://api.example.com/t/t/p/p/nodes');
});
