import { describe, expect, test } from 'bun:test';
import { probability, analyzeDeck, validateDeck } from '../src/analysis';
import { normalizeCard, deriveRoles } from '../src/catalog';
import { searchCards } from '../src/search';
import type { Card, Deck } from '../src/schema';
const card = normalizeCard('Island', [
	{
		name: 'Island',
		types: ['Land'],
		supertypes: ['Basic'],
		type: 'Basic Land — Island',
		subtypes: ['Island'],
		text: '{T}: Add {U}.',
		colorIdentity: ['U'],
		colors: [],
		manaValue: 0,
		legalities: { modern: 'Legal', commander: 'Legal' },
	},
]);
const bolt = normalizeCard('Lightning Bolt', [
	{
		name: 'Lightning Bolt',
		types: ['Instant'],
		type: 'Instant',
		subtypes: [],
		text: 'Lightning Bolt deals 3 damage to any target.',
		colorIdentity: ['R'],
		colors: ['R'],
		manaCost: '{R}',
		manaValue: 1,
		legalities: { modern: 'Legal', commander: 'Legal' },
	},
]);
const deck: Deck = {
	name: 'Test',
	format: 'modern',
	entries: [
		{ cardId: card.id, quantity: 24, board: 'main' },
		{ cardId: bolt.id, quantity: 4, board: 'main' },
	],
	commanderId: null,
};
describe('probability', () => {
	test('exact hypergeometric example', () =>
		expect(probability(60, 4, 7, 1).atLeast).toBeCloseTo(0.3994996257, 8));
	test('zero and guaranteed hits', () => {
		expect(probability(60, 0, 7, 1).atLeast).toBe(0);
		expect(probability(10, 10, 7, 1).atLeast).toBe(1);
		expect(probability(0, 0, 0, 0).atLeast).toBe(1);
	});
	test('rejects impossible input', () => {
		expect(() => probability(60, 61, 7, 1)).toThrow();
		expect(() => probability(60, 4, 61, 1)).toThrow();
		expect(() => probability(60, 4, 7, -1)).toThrow();
	});
});
describe('normalization', () => {
	test('preserves faces under one oracle identity', () => {
		const c = normalizeCard('Front // Back', [
			{ ...bolt, identifiers: { scryfallOracleId: 'oracle' }, side: 'a', faceName: 'Front' },
			{ ...card, identifiers: { scryfallOracleId: 'oracle' }, side: 'b', faceName: 'Back' },
		]);
		expect(c.id).toBe('card:oracle');
		expect(c.faces).toHaveLength(2);
	});
	test('roles contain evidence', () => {
		const roles = deriveRoles({ ...bolt, text: 'Draw two cards. Destroy target creature.' });
		expect(roles.map((r) => r.name)).toContain('Card draw');
		expect(roles.every((r) => r.evidence.length > 0)).toBe(true);
	});
});
describe('search', () => {
	const cards = [card, bolt];
	test('combines syntax filters', () =>
		expect(searchCards(cards, 't:instant mv<=1 c:r', {}).cards.map((c) => c.name)).toEqual([
			'Lightning Bolt',
		]));
	test('quoted oracle text and negation', () =>
		expect(searchCards(cards, 'o:"any target" -t:land', {}).total).toBe(1));
	test('rejects unknown operators and invalid numbers', () => {
		expect(() => searchCards(cards, 'oops:yes', {})).toThrow();
		expect(() => searchCards(cards, 'mv>no', {})).toThrow();
	});
	test('colorless and exact identity are distinct', () => {
		expect(searchCards(cards, 'c:c', {}).cards[0]?.name).toBe('Island');
		expect(searchCards(cards, 'id=u', {}).cards[0]?.name).toBe('Island');
	});
});
describe('deck analysis', () => {
	const catalog = new Map<string, Card>([
		[card.id, card],
		[bolt.id, bolt],
	]);
	test('quantities weight curve and pips; lands excluded from average', () => {
		const a = analyzeDeck(deck, catalog);
		expect(a.total).toBe(28);
		expect(a.landCount).toBe(24);
		expect(a.averageManaValue).toBe(1);
		expect(a.pips.R).toBe(4);
	});
	test('copy limits exempt basics and exclude sideboard from curve', () => {
		expect(validateDeck(deck, catalog).some((i) => i.code === 'copies')).toBe(false);
		const d = {
			...deck,
			entries: [...deck.entries, { cardId: bolt.id, quantity: 2, board: 'side' as const }],
		};
		expect(validateDeck(d, catalog).some((i) => i.code === 'copies')).toBe(true);
		expect(analyzeDeck(d, catalog).total).toBe(28);
	});
	test('commander checks identity and singleton', () => {
		const d = { ...deck, format: 'commander' as const, commanderId: bolt.id };
		expect(validateDeck(d, catalog).some((i) => i.code === 'identity')).toBe(true);
	});
});
test('colored pips include castable alternate faces', () => {
	const c = normalizeCard('Fire // Ice', [
		{
			name: 'Fire // Ice',
			faceName: 'Fire',
			side: 'a',
			manaCost: '{1}{R}',
			manaValue: 4,
			type: 'Instant',
			types: ['Instant'],
			colors: ['R'],
			colorIdentity: ['U', 'R'],
		},
		{
			name: 'Fire // Ice',
			faceName: 'Ice',
			side: 'b',
			manaCost: '{1}{U}',
			manaValue: 4,
			type: 'Instant',
			types: ['Instant'],
			colors: ['U'],
			colorIdentity: ['U', 'R'],
		},
	]);
	const a = analyzeDeck(
		{ ...deck, entries: [{ cardId: c.id, quantity: 4, board: 'main' }] },
		new Map([[c.id, c]]),
	);
	expect(a.pips.U).toBe(4);
	expect(a.pips.R).toBe(4);
});
import { changeDeckFormat } from '../src/deck-format';
import { deckSchema } from '../src/schema';
test('switching formats returns the commander to the mainboard', () => {
	const changed = changeDeckFormat(
		{ ...deck, format: 'commander', commanderId: bolt.id },
		'modern',
	);
	expect(changed.commanderId).toBeNull();
	expect(changed.entries.find((e) => e.cardId === bolt.id)?.quantity).toBe(5);
	expect(() => deckSchema.parse({ ...deck, commanderId: bolt.id })).toThrow();
});
