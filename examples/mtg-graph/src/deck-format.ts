import type { Deck } from './schema';
export function changeDeckFormat(deck: Deck, format: Deck['format']): Deck {
	const entries = deck.entries.map((e) => ({ ...e }));
	if (format !== 'commander' && deck.commanderId) {
		const entry = entries.find((e) => e.cardId === deck.commanderId && e.board === 'main');
		if (entry) entry.quantity++;
		else entries.push({ cardId: deck.commanderId, quantity: 1, board: 'main' });
	}
	return {
		...deck,
		format,
		entries,
		commanderId: format === 'commander' ? deck.commanderId : null,
	};
}
