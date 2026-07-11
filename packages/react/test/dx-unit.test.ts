import { expect, test } from 'bun:test';
import { MatchBuilder } from '../src/create-hooks.ts';
import { codeFromStatus, GraphError } from '../src/errors.ts';
import { appFetch, type RequestLike } from '../src/transport.ts';

// Minimal schema shape for the builder's type params (values are never read — types only).
type S = { nodes: { device: unknown; alert: unknown }; edges: { raised: unknown } };

test('codeFromStatus maps HTTP status → a stable GraphErrorCode', () => {
	expect(codeFromStatus(400)).toBe('validation');
	expect(codeFromStatus(422)).toBe('validation');
	expect(codeFromStatus(401)).toBe('unauthenticated');
	expect(codeFromStatus(403)).toBe('forbidden');
	expect(codeFromStatus(404)).toBe('not_found');
	expect(codeFromStatus(409)).toBe('conflict');
	expect(codeFromStatus(501)).toBe('unimplemented');
	expect(codeFromStatus(0)).toBe('network');
	expect(codeFromStatus(500)).toBe('server');
	expect(codeFromStatus(503)).toBe('server');
	expect(codeFromStatus(418)).toBe('unknown');
});

test('GraphError sets code from status', () => {
	expect(new GraphError(404, 'nope').code).toBe('not_found');
	expect(new GraphError(0, 'offline').code).toBe('network');
});

test('appFetch delegates to app.request', async () => {
	const seen: Array<[unknown, unknown]> = [];
	const app: RequestLike = {
		request(input, init) {
			seen.push([input, init]);
			return new Response('ok', { status: 200 });
		},
	};
	const f = appFetch(app);
	const res = await f('/t/a/p/b/nodes', { method: 'GET' });
	expect(res.status).toBe(200);
	expect(await res.text()).toBe('ok');
	expect(seen[0]?.[0]).toBe('/t/a/p/b/nodes');
});

test('MatchBuilder.select emits a spec with literal steps/select/where/asOf', () => {
	const spec = new MatchBuilder<S>()
		.node('d', 'device')
		.in('raised')
		.node('a', 'alert')
		.where('a', 'severity', 'critical')
		.asOf(123)
		.select('d', 'a');
	expect(spec.select).toEqual(['d', 'a']);
	expect(spec.steps).toEqual([
		{ node: { alias: 'd', kind: 'device' } },
		{ edge: { rel: 'raised', direction: 'in' } },
		{ node: { alias: 'a', kind: 'alert' } },
	]);
	expect(spec.where).toEqual([{ alias: 'a', key: 'severity', value: 'critical' }]);
	expect(spec.asOf).toBe(123);
});

test('MatchBuilder omits empty where/asOf/page', () => {
	const spec = new MatchBuilder<S>().node('d', 'device').select('d');
	expect(spec.where).toBeUndefined();
	expect(spec.asOf).toBeUndefined();
	expect(spec.page).toBeUndefined();
});

test('MatchBuilder.page sets keyset pagination on the spec', () => {
	const spec = new MatchBuilder<S>()
		.node('d', 'device')
		.page({ limit: 5, cursor: 'abc' })
		.select('d');
	expect(spec.page).toEqual({ limit: 5, cursor: 'abc' });
});
