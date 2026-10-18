import { expect, test } from 'bun:test';
import {
	libraryHref,
	libraryListHref,
	readLibraryListState,
	parseLibraryPath,
	resolveLibraryRoute,
	safeLibraryReturnTo,
	getDeckBoards,
	filterBoardCards,
} from '../src/library-navigation';
test('record links encode Unicode and split card names and preserve the list URL', () => {
	expect(libraryHref('decks', 'Café // 日本', '/library/decks?q=Aether&page=3')).toBe(
		'/library/decks/Caf%C3%A9%20%2F%2F%20%E6%97%A5%E6%9C%AC?from=%2Flibrary%2Fdecks%3Fq%3DAether%26page%3D3',
	);
	expect(parseLibraryPath(['decks', 'Café // 日本'])).toEqual({
		kind: 'decks',
		id: 'Café // 日本',
	});
	expect(parseLibraryPath(['unknown'])).toBeNull();
	expect(parseLibraryPath(['coverage', 'id'])).toBeNull();
	expect(parseLibraryPath(['decks', 'a', 'b'])).toBeNull();
});
test('list URLs round-trip filters and pagination; invalid query numbers use defaults', () => {
	const href = libraryListHref('decks', {
		q: 'Aether Revolt',
		set: 'AER',
		type: 'MTGO Redemption',
		page: 3,
		limit: 25,
	});
	expect(href).toBe('/library/decks?q=Aether+Revolt&set=AER&type=MTGO+Redemption&page=3&limit=25');
	expect(readLibraryListState(new URL(href, 'http://localhost').searchParams)).toEqual({
		q: 'Aether Revolt',
		set: 'AER',
		type: 'MTGO Redemption',
		page: 3,
		limit: 25,
	});
	expect(readLibraryListState(new URLSearchParams('page=-4&limit=100000'))).toEqual({
		q: '',
		set: '',
		type: '',
		page: 1,
		limit: 50,
	});
	expect(libraryListHref('sets', {})).toBe('/library/sets');
});
test('return navigation accepts catalog records and rejects external or escaped destinations', () => {
	for (const bad of [
		'https://evil.example/library/decks',
		'//evil.example/library/decks',
		'/library/../api',
		'/library/unknown',
		'/library/decks/a/extra',
		'javascript:alert(1)',
		'/library\\evil',
	])
		expect(safeLibraryReturnTo(bad)).toBe('/library/decks');
	const record = '/library/decks/Example?board=sideBoard&from=%2Flibrary%2Fdecks%3Fpage%3D2';
	expect(safeLibraryReturnTo(record)).toBe(record);
	expect(safeLibraryReturnTo('/library/sets?q=AER&page=2')).toBe('/library/sets?q=AER&page=2');
});
test('deck navigation omits empty boards, prioritizes mainboard and retains custom card sections', () => {
	const boards = getDeckBoards({
		commander: [],
		displayCommander: [],
		mainBoard: [
			{ name: 'Aegis Automaton', count: 2 },
			{ name: 'Island', count: 4 },
		],
		sideBoard: [{ name: 'Negate', count: 1 }],
		tokens: [],
		specialBoard: [{ name: 'Special', count: 1 }],
		sealedProductUuids: ['box'],
		sourceSetCodes: ['AER'],
	});
	expect(boards.map((b) => [b.key, b.quantity])).toEqual([
		['mainBoard', 6],
		['sideBoard', 1],
		['specialBoard', 1],
	]);
	expect(filterBoardCards(boards[0]!.cards, 'island').map((c) => c.name)).toEqual(['Island']);
	expect(
		filterBoardCards(
			[{ name: 'Counterspell', type: 'Instant', text: 'Counter target spell.', count: 1 }],
			'target',
		).length,
	).toBe(1);
	expect(getDeckBoards({ mainBoard: [], sideBoard: [] })).toEqual([]);
});

test('server route resolution accepts encoded catch-all IDs without double decoding literal percent names', () => {
	const known = new Map([
		['Wear // Tear', { id: 'Wear // Tear', name: 'Wear // Tear' }],
		['Literal%2F', { id: 'Literal%2F', name: 'Literal percent' }],
	]);
	const lookup = (_kind: string, id: string) => known.get(id) ?? null;
	expect(resolveLibraryRoute(['atomic', 'Wear%20%2F%2F%20Tear'], lookup)).toEqual({
		kind: 'atomic',
		id: 'Wear // Tear',
		name: 'Wear // Tear',
	});
	expect(resolveLibraryRoute(['atomic', 'Wear // Tear'], lookup)).toEqual({
		kind: 'atomic',
		id: 'Wear // Tear',
		name: 'Wear // Tear',
	});
	expect(resolveLibraryRoute(['atomic', 'Literal%2F'], lookup)?.id).toBe('Literal%2F');
	expect(resolveLibraryRoute(['atomic', 'broken%zz'], lookup)).toBeNull();
});
