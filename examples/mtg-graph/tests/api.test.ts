import { test, expect } from 'bun:test';
import { app } from '../src/api';
import { openMemoryDb } from 'graphx/local';
import { init, Graph } from 'graphx';
import { schema } from '../src/schema';
import { syncRelease, planRelease } from '../src/ingest';
import { DeckStore } from '../src/decks';
import type { Runtime } from '../src/runtime';
const base = {
	name: 'Island',
	type: 'Basic Land — Island',
	types: ['Land'],
	supertypes: ['Basic'],
	subtypes: ['Island'],
	colorIdentity: ['U'],
	colors: [],
	manaValue: 0,
	legalities: { modern: 'Legal' },
	identifiers: { scryfallOracleId: 'island' },
	printings: ['LEA'],
};
test('canonicalizes reversible printings without duplicating the oracle identity', () => {
	const p = planRelease({
		meta: { date: '2026-10-18', version: 'test' },
		data: {
			Island: [base],
			'Island // Island': [
				{ ...base, name: 'Island // Island', layout: 'reversible_card', printings: ['SLD'] },
			],
		},
	});
	expect(p.cards).toHaveLength(1);
	expect(p.cards[0]?.name).toBe('Island');
	expect(p.cards[0]?.aliases).toContain('Island // Island');
	expect(p.cards[0]?.printings).toEqual(['LEA', 'SLD']);
	expect(p.metadata.cards).toBe(1);
});
test('HTTP validates queries, JSON bodies, origin, revisions and generated OpenAPI', async () => {
	const db = await openMemoryDb();
	await init(db);
	const p = await syncRelease(db, {
		meta: { date: '2026-10-18', version: 'test' },
		data: { Island: [base] },
	});
	const graph = new Graph(db, schema);
	const catalog = new Map(p.cards.map((c) => [c.id, c]));
	const decks = new DeckStore(graph, catalog);
	const global = globalThis as typeof globalThis & { __mtg?: Promise<Runtime> };
	global.__mtg = Promise.resolve({
		db,
		graph,
		cards: p.cards,
		catalog,
		decks,
		status: async () => ({ dataset: p.metadata }),
	});
	const request = (path: string, method = 'GET', body?: unknown, origin?: string) =>
		app.request(`http://localhost/api${path}`, {
			method,
			headers: {
				...(body ? { 'Content-Type': 'application/json' } : {}),
				...(origin ? { origin } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	try {
		expect((await request('/v1/cards?q=t:land')).status).toBe(200);
		expect((await request('/v1/cards?q=oops:no')).status).toBe(400);
		expect((await request('/v1/cards?limit=1000')).status).toBe(400);
		expect((await request('/v1/cards?maxPrice=-1')).status).toBe(400);
		expect((await request('/v1/cards?role=invalid')).status).toBe(400);
		expect((await request('/v1/cards?sort=price')).status).toBe(200);
		expect((await (await request('/v1/cards?ids=')).json()).total).toBe(0);
		expect((await (await request('/v1/cards?ids=card:island')).json()).total).toBe(1);
		expect((await (await request('/v1/cards?maxPrice=5')).json()).total).toBe(0);
		expect((await request('/v1/cards?deckId=missing')).status).toBe(404);
		const probability = await request('/v1/probability', 'POST', {
			population: 60,
			successes: 4,
			draws: 7,
			minimum: 1,
		});
		expect(probability.status).toBe(200);
		expect((await probability.json()).atLeast).toBeCloseTo(0.3994996, 6);
		expect(
			(
				await request('/v1/probability', 'POST', {
					population: 60,
					successes: 4,
					draws: 61,
					minimum: 1,
				})
			).status,
		).toBe(400);
		expect(
			(
				await request(
					'/v1/decks',
					'POST',
					{ name: 'Test', format: 'modern', entries: [] },
					'https://attacker.example',
				)
			).status,
		).toBe(403);
		const created = await request(
			'/v1/decks',
			'POST',
			{ name: 'Test', format: 'modern', entries: [], commanderId: null },
			'http://localhost',
		);
		expect(created.status).toBe(200);
		const deck = await created.json();
		expect((await (await request(`/v1/cards?deckId=${deck.id}`)).json()).total).toBe(1);
		expect(
			(await (await request(`/v1/cards?deckId=${deck.id}&format=commander`)).json()).total,
		).toBe(1);
		const saved = await request(`/v1/decks/${deck.id}`, 'PUT', { ...deck, name: 'Saved' });
		expect(saved.status).toBe(200);
		expect((await request(`/v1/decks/${deck.id}`, 'PUT', { ...deck, name: 'Stale' })).status).toBe(
			409,
		);
		const imported = await request('/v1/import', 'POST', { text: '24 Island\n1 Missing' });
		expect((await imported.json()).unknown).toEqual(['1 Missing']);
		const spec = await request('/openapi.json');
		expect(spec.status).toBe(200);
		expect(Object.keys((await spec.json()).paths).length).toBeGreaterThan(12);
	} finally {
		delete global.__mtg;
		await db.close();
	}
});
