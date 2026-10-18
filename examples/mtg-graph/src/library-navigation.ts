export const librarySections = [
	['sets', 'Sets'],
	['decks', 'Published decks'],
	['printings', 'Printings'],
	['tokens', 'Tokens'],
	['sealed', 'Sealed products'],
	['atomic', 'Oracle cards'],
	['identifiers', 'Identifiers'],
	['prices', 'Price history'],
	['pricesToday', 'Current prices'],
	['skus', 'TCGplayer SKUs'],
	['cardmarket', 'Cardmarket identifiers'],
	['reference', 'Reference data'],
	['coverage', 'Coverage'],
] as const;
export type LibrarySection = (typeof librarySections)[number][0];
export type LibraryRecordKind = Exclude<LibrarySection, 'coverage'>;
export const librarySectionLabel = (kind: string) =>
	librarySections.find(([id]) => id === kind)?.[1] ?? kind;
export function parseLibraryPath(
	segments: string[] = [],
): { kind: LibrarySection; id?: string } | null {
	const [kind = 'sets', id] = segments;
	if (
		segments.length > 2 ||
		!librarySections.some(([key]) => key === kind) ||
		(id !== undefined &&
			(!id || id.length > 300 || kind === 'coverage' || [...id].some((c) => c.charCodeAt(0) < 32)))
	)
		return null;
	return { kind: kind as LibrarySection, ...(id ? { id } : {}) };
}
export function libraryHref(kind: string, id?: string, from?: string) {
	const path = `/library/${encodeURIComponent(kind)}${id ? `/${encodeURIComponent(id)}` : ''}`;
	return from
		? `${path}?${new URLSearchParams({ from: safeLibraryReturnTo(from, `/library/${kind}`) })}`
		: path;
}
export interface LibraryListState {
	q: string;
	set: string;
	type: string;
	page: number;
	limit: number;
}
export function readLibraryListState(params: Pick<URLSearchParams, 'get'>): LibraryListState {
	const page = Number(params.get('page') ?? 1),
		limit = Number(params.get('limit') ?? 50);
	return {
		q: params.get('q') ?? '',
		set: params.get('set') ?? '',
		type: params.get('type') ?? '',
		page: Number.isInteger(page) && page > 0 && page <= 100000000 ? page : 1,
		limit: Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 50,
	};
}
export function libraryListHref(kind: LibrarySection, state: Partial<LibraryListState> = {}) {
	const params = new URLSearchParams();
	for (const key of ['q', 'set', 'type'] as const) if (state[key]) params.set(key, state[key]!);
	if (state.page && state.page !== 1) params.set('page', String(state.page));
	if (state.limit && state.limit !== 50) params.set('limit', String(state.limit));
	return `/library/${kind}${params.size ? `?${params}` : ''}`;
}
export function safeLibraryReturnTo(value: string | null, fallback = '/library/decks') {
	if (
		!value ||
		value.length > 8000 ||
		!value.startsWith('/') ||
		value.startsWith('//') ||
		value.includes('\\') ||
		[...value].some((c) => c.charCodeAt(0) < 32)
	)
		return fallback;
	try {
		const url = new URL(value, 'http://local.invalid');
		if (url.origin !== 'http://local.invalid' || !/^\/library(?:\/|$)/.test(url.pathname))
			return fallback;
		const path = url.pathname.split('/').slice(2).filter(Boolean).map(decodeURIComponent);
		if (!parseLibraryPath(path)) return fallback;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return fallback;
	}
}
type SourceCard = Record<string, any>;
export function getDeckBoards(
	source: Record<string, any>,
): { key: string; label: string; cards: SourceCard[]; quantity: number }[] {
	const known = [
		'mainBoard',
		'commander',
		'sideBoard',
		'displayCommander',
		'tokens',
		'planes',
		'schemes',
		'planarDeck',
		'schemeDeck',
		'attractions',
		'contraptions',
	];
	const labels: Record<string, string> = {
		mainBoard: 'Mainboard',
		sideBoard: 'Sideboard',
		commander: 'Commander',
		displayCommander: 'Display commander',
		tokens: 'Tokens',
		planes: 'Planes',
		schemes: 'Schemes',
	};
	const keys = [
		...new Set([
			...known,
			...Object.keys(source).filter(
				(key) =>
					Array.isArray(source[key]) &&
					source[key].some(
						(v: unknown) => !!v && typeof v === 'object' && ('name' in v || 'uuid' in v),
					),
			),
		]),
	];
	return keys.flatMap((key) =>
		Array.isArray(source[key]) && source[key].length
			? [
					{
						key,
						label:
							labels[key] ??
							key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
						cards: source[key],
						quantity: source[key].reduce(
							(n: number, c: SourceCard) => n + Number(c.count ?? c.quantity ?? 1),
							0,
						),
					},
				]
			: [],
	);
}
export function filterBoardCards(cards: SourceCard[], query: string) {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return cards;
	return cards.filter((card) => {
		const text = [card.name, card.type, card.text, card.setCode, card.number]
			.filter(Boolean)
			.join(' ')
			.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}
export function resolveLibraryRoute(
	segments: string[] | undefined,
	lookup: (kind: LibrarySection, id: string) => { id: string; name: string } | null,
): { kind: LibrarySection; id?: string; name?: string } | null {
	const route = parseLibraryPath(segments);
	if (!route || !route.id) return route;
	let summary = lookup(route.kind, route.id);
	if (!summary) {
		try {
			const decoded = decodeURIComponent(route.id);
			if (decoded !== route.id) summary = lookup(route.kind, decoded);
		} catch {}
	}
	return summary ? { kind: route.kind, id: summary.id, name: summary.name } : null;
}
