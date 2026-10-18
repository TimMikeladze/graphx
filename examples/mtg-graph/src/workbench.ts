import type { Card, Deck, Entry } from './schema';
import { probability } from './analysis';

export const roles = [
	'Card draw',
	'Ramp',
	'Removal',
	'Interaction',
	'Graveyard',
	'Tokens',
	'Tutor',
	'Sacrifice',
	'Lifegain',
	'Win condition',
];
export const colorNames: Record<string, string> = {
	W: 'White',
	U: 'Blue',
	B: 'Black',
	R: 'Red',
	G: 'Green',
	C: 'Colorless',
};
export const usdPrice = (card?: Card) => {
	const value = card?.prices?.usd;
	return value !== null &&
		value !== undefined &&
		value.trim() !== '' &&
		Number.isFinite(Number(value)) &&
		Number(value) >= 0
		? Number(value)
		: null;
};
export const money = (value: number | null) =>
	value === null
		? '—'
		: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
export function boardCounts(deck: Deck | null, cardId: string) {
	const counts = { main: 0, side: 0, maybe: 0 };
	for (const entry of deck?.entries ?? [])
		if (entry.cardId === cardId) counts[entry.board] += entry.quantity;
	return counts;
}
export function deckBudget(deck: Deck, catalog: Map<string, Card>) {
	const entries = deck.entries.filter((e) => e.board !== 'maybe');
	if (deck.commanderId) entries.push({ cardId: deck.commanderId, quantity: 1, board: 'main' });
	let usd = 0,
		priced = 0,
		missing = 0;
	const dates = new Set<string>();
	for (const entry of entries) {
		const card = catalog.get(entry.cardId),
			price = usdPrice(card);
		if (price === null) missing += entry.quantity;
		else {
			usd += price * entry.quantity;
			priced += entry.quantity;
			if (card?.prices) dates.add(card.prices.asOf);
		}
	}
	return {
		usd: Math.round(usd * 100) / 100,
		priced,
		missing,
		total: priced + missing,
		dates: [...dates].sort(),
	};
}
export function groupEntries(
	entries: Entry[],
	catalog: Map<string, Card>,
	options: { board: Entry['board']; query: string; group: string; sort: string },
): [string, Entry[]][] {
	const visible = entries.filter(
		(e) =>
			e.board === options.board &&
			(!options.query ||
				catalog.get(e.cardId)?.name.toLowerCase().includes(options.query.toLowerCase())),
	);
	visible.sort((a, b) => {
		const ca = catalog.get(a.cardId),
			cb = catalog.get(b.cardId);
		const fallback = (ca?.name ?? '').localeCompare(cb?.name ?? '');
		if (options.sort === 'mana') return (ca?.manaValue ?? 0) - (cb?.manaValue ?? 0) || fallback;
		if (options.sort === 'quantity') return b.quantity - a.quantity || fallback;
		if (options.sort === 'price') return (usdPrice(cb) ?? -1) - (usdPrice(ca) ?? -1) || fallback;
		return fallback;
	});
	const groups = new Map<string, Entry[]>();
	for (const entry of visible) {
		const card = catalog.get(entry.cardId);
		const name =
			options.group === 'none'
				? 'All cards'
				: options.group === 'mana'
					? `MV ${card?.manaValue ?? 0}`
					: card?.faces[0]?.type.includes('Land')
						? 'Land'
						: (card?.types.find((t) => !['Tribal', 'Kindred'].includes(t)) ?? 'Cards');
		groups.set(name, [...(groups.get(name) ?? []), entry]);
	}
	return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
}
export function landDropOdds(total: number, lands: number, onDraw: boolean) {
	return Array.from({ length: 5 }, (_, index) => {
		const turn = index + 1,
			draws = Math.min(total, 7 + turn - (onDraw ? 0 : 1));
		return { turn, draws, chance: probability(total, lands, draws, turn).atLeast };
	});
}
