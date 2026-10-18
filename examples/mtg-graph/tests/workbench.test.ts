import { describe, expect, test } from 'bun:test';
import { normalizeCard } from '../src/catalog';
import { searchCards } from '../src/search';
import { boardCounts, deckBudget, groupEntries, landDropOdds } from '../src/workbench';
import type { Card, Deck } from '../src/schema';

const make = (name: string, props: Partial<Card> = {}) => ({
	...normalizeCard(name, [
		{
			name,
			type: 'Instant',
			types: ['Instant'],
			text: 'Draw two cards.',
			manaValue: 2,
			legalities: { modern: 'Legal', commander: 'Legal' },
			colorIdentity: ['U'],
			colors: ['U'],
		},
	]),
	...props,
});
const a = make('Alpha', {
	prices: { usd: '2.50', eur: null, asOf: '2026-10-18', source: 'Scryfall' },
});
const b = make('Beta', {
	prices: { usd: null, eur: null, asOf: '2026-10-18', source: 'Scryfall' },
});
const c = make('Gamma', { colorIdentity: ['R'], text: 'Haste' });
const deck: Deck = {
	name: 'Test',
	format: 'commander',
	commanderId: c.id,
	entries: [
		{ cardId: a.id, quantity: 4, board: 'main' },
		{ cardId: a.id, quantity: 2, board: 'side' },
		{ cardId: b.id, quantity: 3, board: 'main' },
		{ cardId: c.id, quantity: 1, board: 'maybe' },
	],
};
const catalog = new Map([a, b, c].map((card) => [card.id, card]));

describe('workbench search', () => {
	test('price ceiling excludes missing prices, including zero ceiling', () => {
		expect(searchCards([a, b], '', { maxPrice: 3 }).cards).toEqual([a]);
		expect(searchCards([a, b], '', { maxPrice: 0 }).total).toBe(0);
		expect(() => searchCards([a], '', { maxPrice: -1 })).toThrow();
	});
	test('role, identity and favorites filter before pagination', () => {
		expect(
			searchCards([a, b, c], '', { role: 'Card draw', identity: ['U'], ids: [b.id], limit: 1 })
				.cards,
		).toEqual([b]);
		expect(searchCards([a, b, c], '', { ids: [] }).total).toBe(0);
		expect(searchCards([a, b, c], '', { identity: [] }).total).toBe(0);
		expect(() => searchCards([a], '', { role: 'invalid' })).toThrow();
	});
	test('sorts priced cards before cards without a price', () => {
		expect(searchCards([b, a], '', { sort: 'price' }).cards[0]?.id).toBe(a.id);
	});
});
describe('deck workbench', () => {
	test('counts all boards without merging them', () => {
		expect(boardCounts(deck, a.id)).toEqual({ main: 4, side: 2, maybe: 0 });
	});
	test('budget weights quantities, includes commander, excludes maybe and reports gaps', () => {
		expect(deckBudget(deck, catalog)).toEqual({
			usd: 15,
			priced: 6,
			missing: 4,
			total: 10,
			dates: ['2026-10-18'],
		});
	});
	test('does not silently price unloaded cards at zero', () => {
		expect(deckBudget(deck, new Map()).missing).toBe(10);
	});
	test('filters and sorts grouped deck entries', () => {
		const groups = groupEntries(deck.entries, catalog, {
			board: 'main',
			query: 'alpha',
			group: 'mana',
			sort: 'quantity',
		});
		expect(groups).toEqual([['MV 2', [deck.entries[0]!]]]);
	});
	test('land-drop odds distinguish play from draw and clamp tiny libraries', () => {
		expect(landDropOdds(60, 24, false)[0]?.draws).toBe(7);
		expect(landDropOdds(60, 24, true)[0]?.draws).toBe(8);
		expect(landDropOdds(3, 1, true).at(-1)?.draws).toBe(3);
		expect(landDropOdds(0, 0, false)[0]?.chance).toBe(0);
	});
});
