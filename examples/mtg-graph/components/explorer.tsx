'use client';
import { useEffect, useRef, useState } from 'react';
import type { Card, DeckRecord, Entry } from '@/src/schema';
import { formats } from '@/src/schema';
import { boardCounts, colorNames, money, roles, usdPrice } from '@/src/workbench';
import { api, Icon, Mana, Colors, CardImage, Skeleton, useCardMap, Modal } from './ui';
import { isStringList, usePreference } from './preferences';
import CardCompare from './card-compare';

type Filters = {
	q: string;
	format: string;
	color: string;
	type: string;
	role: string;
	maxPrice: string;
	sort: string;
	deckOnly: boolean;
	favoriteOnly: boolean;
};
const defaults: Filters = {
	q: '',
	format: '',
	color: '',
	type: '',
	role: '',
	maxPrice: '',
	sort: 'rank',
	deckOnly: false,
	favoriteOnly: false,
};
type SavedSearch = { name: string; filters: Filters; deckId?: string };
const validSaved = (value: unknown): value is SavedSearch[] =>
	Array.isArray(value) &&
	value.length <= 20 &&
	value.every(
		(v) =>
			v &&
			typeof v.name === 'string' &&
			v.filters &&
			Object.keys(defaults).every(
				(k) => typeof v.filters[k] === typeof defaults[k as keyof Filters],
			),
	);
const presets = [
	{ label: 'Cheap creatures', query: 't:creature mv<=2' },
	{ label: 'Card draw', query: 'o:"draw a card"' },
	{ label: 'Countermagic', query: 'o:"counter target"' },
	{ label: 'Mana rocks', query: 't:artifact o:"add" mv<=2' },
	{ label: 'Legendary creatures', query: 't:legendary t:creature' },
];
interface Props {
	deck: DeckRecord | null;
	decks: DeckRecord[];
	onChoose: (id: string) => void;
	status: any;
	onSelect: (card: Card) => void;
	onAdd: (card: Card, board?: Entry['board']) => void;
	onDeck: () => void;
	busy: boolean;
}
export default function Explorer({
	deck,
	decks,
	onChoose,
	status,
	onSelect,
	onAdd,
	onDeck,
	busy,
}: Props) {
	const [filters, setFilters] = useState<Filters>(defaults);
	const [ready, setReady] = useState(false);
	const [requestedDeckId, setRequestedDeckId] = useState<string | null>(null);
	const [contextNotice, setContextNotice] = useState('');
	const [view, setView] = usePreference(
		'mtg-view',
		'list',
		(v): v is string => v === 'list' || v === 'grid',
	);
	const [density, setDensity] = usePreference(
		'mtg-density',
		'comfortable',
		(v): v is string => v === 'comfortable' || v === 'compact',
	);
	const [favorites, setFavorites] = usePreference<string[]>('mtg-favorites', [], isStringList);
	const [saved, setSaved] = usePreference<SavedSearch[]>('mtg-searches', [], validSaved);
	const [saveModal, setSaveModal] = useState(false);
	const [searchName, setSearchName] = useState('');
	const [board, setBoard] = useState<Entry['board']>('main');
	const [compare, setCompare] = useState<Card[]>([]);
	const [comparing, setComparing] = useState(false);
	const [page, setPage] = useState(1);
	const [result, setResult] = useState<{ cards: Card[]; total: number; pages: number } | null>(
		null,
	);
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(true);
	const input = useRef<HTMLInputElement>(null);
	const { q, format, color, type, role, maxPrice, sort, deckOnly, favoriteOnly } = filters;
	const change = (key: keyof Filters, value: string | boolean) => {
		setFilters((old) => ({ ...old, [key]: value }));
		setPage(1);
	};
	const restoreURL = () => {
		const params = new URLSearchParams(location.search);
		const restored = { ...defaults };
		for (const key of Object.keys(defaults) as (keyof Filters)[]) {
			if (typeof defaults[key] === 'boolean')
				(restored as Record<string, unknown>)[key] = params.get(key) === '1';
			else (restored as Record<string, unknown>)[key] = params.get(key) ?? defaults[key];
		}
		setFilters(restored);
		setRequestedDeckId(restored.deckOnly ? params.get('deckId') : null);
		setPage(Math.max(1, Number(params.get('page')) || 1));
	};
	useEffect(() => {
		restoreURL();
		setReady(true);
		window.addEventListener('popstate', restoreURL);
		return () => window.removeEventListener('popstate', restoreURL);
	}, []);
	useEffect(() => {
		if (!ready || !requestedDeckId || !status) return;
		if (decks.some((d) => d.id === requestedDeckId)) onChoose(requestedDeckId);
		else {
			setFilters((old) => ({ ...old, deckOnly: false }));
			setContextNotice(
				'The deck saved in this search is unavailable. Choose an active deck to apply deck filters.',
			);
		}
		setRequestedDeckId(null);
	}, [ready, requestedDeckId, status, decks]);
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (document.querySelector('[role="dialog"]')) return;
			if (
				(event.key === '/' &&
					!['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)) ||
				((event.metaKey || event.ctrlKey) && event.key === 'k')
			) {
				event.preventDefault();
				input.current?.focus();
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);
	useEffect(() => {
		if (!ready || requestedDeckId || (deckOnly && !deck)) return;
		const controller = new AbortController();
		setLoading(true);
		const timer = setTimeout(() => {
			const query = new URLSearchParams({ q, sort, page: String(page), limit: '36' });
			for (const [key, value] of Object.entries({ format, color, type, role, maxPrice }))
				if (value !== '') query.set(key, value);
			if (deckOnly && deck) query.set('deckId', deck.id);
			if (favoriteOnly) query.set('ids', favorites.join(','));
			api(`/cards?${query}`, { signal: controller.signal })
				.then((r) => {
					if (controller.signal.aborted) return;
					if (r.pages > 0 && page > r.pages) {
						setPage(r.pages);
						return;
					}
					setResult(r);
					setError('');
				})
				.catch((e) => {
					if (!controller.signal.aborted) setError(e.message);
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
		}, 180);
		const url = new URL(location.href);
		for (const [key, value] of Object.entries(filters)) {
			if (value === defaults[key as keyof Filters]) url.searchParams.delete(key);
			else url.searchParams.set(key, typeof value === 'boolean' ? '1' : value);
		}
		if (deckOnly && deck) url.searchParams.set('deckId', deck.id);
		else url.searchParams.delete('deckId');
		if (page > 1) url.searchParams.set('page', String(page));
		else url.searchParams.delete('page');
		history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [
		ready,
		requestedDeckId,
		filters,
		page,
		favorites,
		deckOnly ? deck?.id : '',
		deckOnly ? deck?.revision : '',
	]);
	const deckCards = useCardMap(deck?.entries.map((e) => e.cardId) ?? []);
	const total =
		deck?.entries.filter((e) => e.board === 'main').reduce((n, e) => n + e.quantity, 0) ?? 0;
	const mainEntries = deck?.entries.filter((e) => e.board === 'main') ?? [];
	const reset = () => {
		setFilters(defaults);
		setPage(1);
	};
	const active = (Object.keys(defaults) as (keyof Filters)[]).filter(
		(k) => k !== 'sort' && filters[k] !== defaults[k],
	);
	const toggleFavorite = (card: Card) =>
		setFavorites((old) =>
			old.includes(card.id)
				? old.filter((id) => id !== card.id)
				: old.length < 100
					? [...old, card.id]
					: old,
		);
	const toggleCompare = (card: Card) =>
		setCompare((old) =>
			old.some((c) => c.id === card.id)
				? old.filter((c) => c.id !== card.id)
				: old.length < 3
					? [...old, card]
					: old,
		);
	const actions = (card: Card) => (
		<div className="result-actions">
			<button
				className={`icon-btn ${favorites.includes(card.id) ? 'favorite-on' : ''}`}
				aria-label={`${favorites.includes(card.id) ? 'Unfavorite' : 'Favorite'} ${card.name}`}
				aria-pressed={favorites.includes(card.id)}
				title={
					favorites.length >= 100 && !favorites.includes(card.id)
						? '100 favorites saved; remove one to add more'
						: 'Save favorite'
				}
				disabled={favorites.length >= 100 && !favorites.includes(card.id)}
				onClick={() => toggleFavorite(card)}
			>
				<Icon name="star" size={14} />
			</button>
			<button
				className="icon-btn"
				aria-label={`Compare ${card.name}`}
				aria-pressed={compare.some((c) => c.id === card.id)}
				title="Compare up to 3 cards"
				disabled={compare.length >= 3 && !compare.some((c) => c.id === card.id)}
				onClick={() => toggleCompare(card)}
			>
				<Icon name="compare" size={14} />
			</button>
			<button
				className="add-card"
				disabled={busy}
				title={`Add ${card.name} to ${board}board`}
				aria-label={`Add ${card.name}`}
				onClick={() => onAdd(card, board)}
			>
				<Icon name="plus" size={15} />
			</button>
		</div>
	);
	const copies = (card: Card) => {
		const counts = boardCounts(deck, card.id);
		return (['main', 'side', 'maybe'] as const)
			.filter((b) => counts[b])
			.map((b) => (
				<span className="copy-badge" key={b} title={`${counts[b]} in ${b}board`}>
					{counts[b]} {b}
				</span>
			));
	};
	return (
		<>
			<div className="page-heading">
				<div>
					<div className="eyebrow">Workspace / Card library</div>
					<h1>
						Card explorer{' '}
						<span className="heading-count">
							{status ? Number(status.dataset.cards).toLocaleString() : '…'}
						</span>
					</h1>
					<p className="page-description">
						Search cards, check legality, and build your next list.
					</p>
				</div>
				<button className="button dark" onClick={onDeck}>
					<Icon name="deck" />
					My decks
					<Icon name="arrow" size={14} />
				</button>
			</div>
			<div className="summary-tiles">
				<div className="summary-tile">
					<div>
						Card library
						<Icon name="layers" />
					</div>
					<strong>{status ? Number(status.dataset.cards).toLocaleString() : '—'}</strong>
					<small>
						{status?.dataset?.coverage === 'snapshot' ? 'Local snapshot' : 'Oracle identities'} ·
						MTGJSON
					</small>
				</div>
				<button className="summary-tile" onClick={onDeck}>
					<div>
						Saved decks
						<Icon name="deck" />
					</div>
					<strong>{decks.length}</strong>
					<small>{deck?.name ?? 'Create your first deck'}</small>
				</button>
				<button
					className="summary-tile"
					onClick={() => change('favoriteOnly', !favoriteOnly)}
					aria-pressed={favoriteOnly}
				>
					<div>
						Favorites
						<Icon name="star" />
					</div>
					<strong>{favorites.length}</strong>
					<small>{favoriteOnly ? 'Showing saved cards' : 'Your saved cards · view all'}</small>
				</button>
				<div className="summary-tile">
					<div>
						Catalog status<span className="mini-status">{status ? 'Ready' : 'Loading'}</span>
					</div>
					<strong>{status?.dataset?.date?.slice(5) ?? '—'}</strong>
					<small>Release {status?.dataset?.date ?? 'loading'}</small>
				</div>
			</div>
			<div className="explorer-layout">
				{contextNotice && (
					<div className="context-notice" role="status">
						{contextNotice}
						<button
							className="icon-btn"
							aria-label="Dismiss deck notice"
							onClick={() => setContextNotice('')}
						>
							<Icon name="close" size={14} />
						</button>
					</div>
				)}
				<section
					className="catalog"
					data-density={density}
					aria-label="Card search results"
					aria-busy={loading}
				>
					<div className="catalog-controls">
						<div className="search-box">
							<Icon name="search" size={18} />
							<input
								ref={input}
								value={q}
								onChange={(e) => change('q', e.target.value)}
								placeholder="Search names, oracle text, or use t:creature…"
								aria-label="Search cards"
								spellCheck={false}
								maxLength={500}
							/>
							{q ? (
								<button
									className="icon-btn"
									aria-label="Clear search"
									onClick={() => change('q', '')}
								>
									<Icon name="close" size={14} />
								</button>
							) : (
								<kbd>⌘K</kbd>
							)}
						</div>
						<div className="filters">
							<div className="filter-select">
								<Icon name="filter" size={14} />
								<select
									value={format}
									disabled={deckOnly}
									onChange={(e) => change('format', e.target.value)}
									aria-label="Format"
								>
									<option value="">All formats</option>
									{formats.map((f) => (
										<option key={f} value={f}>
											{f[0]!.toUpperCase() + f.slice(1)}
										</option>
									))}
								</select>
							</div>
							<select
								className="filter-select"
								value={type}
								onChange={(e) => change('type', e.target.value)}
								aria-label="Card type"
							>
								<option value="">All types</option>
								{[
									'Creature',
									'Instant',
									'Sorcery',
									'Artifact',
									'Enchantment',
									'Planeswalker',
									'Land',
									'Battle',
								].map((t) => (
									<option key={t}>{t}</option>
								))}
							</select>
							<div className="color-filters">
								{'WUBRGC'.split('').map((c) => (
									<button
										key={c}
										className={color === c ? 'selected' : ''}
										onClick={() => change('color', color === c ? '' : c)}
										aria-label={`Filter ${colorNames[c]}`}
										title={colorNames[c]}
										aria-pressed={color === c}
									>
										<Colors colors={c === 'C' ? [] : [c]} />
									</button>
								))}
							</div>
						</div>
						<div className="advanced-filters">
							<select
								value={role}
								onChange={(e) => change('role', e.target.value)}
								aria-label="Card role"
							>
								<option value="">All roles</option>
								{roles.map((r) => (
									<option key={r}>{r}</option>
								))}
							</select>
							<label className="price-filter">
								Max $
								<input
									type="number"
									min="0"
									max="1000000"
									step="0.5"
									value={maxPrice}
									placeholder="Any"
									aria-label="Maximum USD price"
									onChange={(e) => change('maxPrice', e.target.value)}
								/>
							</label>
							<button
								className="filter-toggle"
								disabled={!deck}
								aria-pressed={deckOnly}
								onClick={() => change('deckOnly', !deckOnly)}
								title="Imported format legality and commander identity; copy limits are checked in Analysis"
							>
								<Icon name="check" size={12} />
								Fits active deck
							</button>
							<button
								className="filter-toggle"
								aria-pressed={favoriteOnly}
								onClick={() => change('favoriteOnly', !favoriteOnly)}
							>
								<Icon name="star" size={12} />
								Favorites
							</button>
							<button
								className="text-btn"
								onClick={() => {
									setSearchName(q || role || 'My search');
									setSaveModal(true);
								}}
							>
								<Icon name="plus" size={12} />
								Save search
							</button>
						</div>
						<div className="query-presets">
							{presets.map((p) => (
								<button
									key={p.label}
									onClick={() => {
										setFilters({ ...defaults, q: p.query });
										setPage(1);
									}}
								>
									{p.label}
								</button>
							))}
						</div>
						{active.length > 0 && (
							<div className="active-filters" aria-label="Active filters">
								{active.map((key) => (
									<button
										key={key}
										aria-label={`Remove ${key} filter`}
										onClick={() => change(key, defaults[key])}
									>
										{key === 'deckOnly'
											? `Fits ${deck?.name ?? 'deck'}`
											: key === 'favoriteOnly'
												? 'Favorites'
												: key === 'maxPrice'
													? `≤ $${maxPrice}`
													: String(filters[key])}
										<Icon name="close" size={10} />
									</button>
								))}
								<button onClick={reset}>Clear all</button>
							</div>
						)}
					</div>
					<div className="result-toolbar">
						<span role="status">
							{loading ? 'Searching…' : `${result?.total.toLocaleString() ?? 0} cards`}
						</span>
						<div className="toolbar-right">
							<label>
								Sort{' '}
								<select
									value={sort}
									onChange={(e) => change('sort', e.target.value)}
									aria-label="Sort cards"
								>
									<option value="rank">EDHREC rank</option>
									<option value="name">Name</option>
									<option value="mana">Mana value</option>
									<option value="price">Price: low to high</option>
								</select>
							</label>
							<button
								className="text-btn density-control"
								onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
								title="Toggle row spacing"
								aria-label={`Use ${density === 'compact' ? 'comfortable' : 'compact'} density`}
							>
								<Icon name="filter" size={14} />
								{density === 'compact' ? 'Compact' : 'Comfortable'}
							</button>
							<div className="view-switch">
								{['list', 'grid'].map((v) => (
									<button
										key={v}
										aria-label={`${v === 'list' ? 'List' : 'Grid'} view`}
										aria-pressed={view === v}
										className={view === v ? 'selected' : ''}
										onClick={() => setView(v)}
									>
										<Icon name={v} size={14} />
									</button>
								))}
							</div>
						</div>
					</div>
					{error ? (
						<div className="error-box" role="alert">
							{error}
							<button className="text-btn" onClick={reset}>
								Clear filters
							</button>
						</div>
					) : !result && loading ? (
						<Skeleton />
					) : result?.total === 0 ? (
						<div className="empty">
							<Icon name={favoriteOnly ? 'star' : 'search'} size={28} />
							<h3>
								{favoriteOnly && !favorites.length
									? 'Save your first favorite'
									: 'No cards match these filters'}
							</h3>
							<p className="muted">
								{favoriteOnly && !favorites.length
									? 'Use the star beside a card to save it here.'
									: 'Remove a filter or try a broader query.'}
							</p>
							<button className="button" onClick={reset}>
								Clear filters
							</button>
						</div>
					) : view === 'list' ? (
						<div className={`card-table ${loading ? 'loading' : ''}`}>
							<div className="card-table-head">
								<span>Card</span>
								<span className="mana-col">Mana</span>
								<span className="type-col">Type</span>
								<span className="price-col">USD</span>
								<span />
							</div>
							{result?.cards.map((card) => (
								<div className="card-row" key={card.id}>
									<button className="card-name" onClick={() => onSelect(card)}>
										<span className="art-thumb">
											<CardImage card={card} />
										</span>
										<span>
											{card.name}
											{copies(card)}
											<small className="result-subtitle">
												{card.type}{' '}
												{card.edhrecRank ? `· #${card.edhrecRank.toLocaleString()}` : ''}
											</small>
										</span>
									</button>
									<span className="mana-col">
										<Mana cost={card.manaCost} />
									</span>
									<span className="type-col" title={card.type}>
										{card.type}
									</span>
									<span
										className="price-col"
										title={
											card.prices ? `Selected printing · ${card.prices.asOf}` : 'Price unavailable'
										}
									>
										{money(usdPrice(card))}
									</span>
									{actions(card)}
								</div>
							))}
						</div>
					) : (
						<div className={`card-grid ${loading ? 'loading' : ''}`}>
							{result?.cards.map((card) => (
								<article key={card.id}>
									<button className="image-button" onClick={() => onSelect(card)}>
										<CardImage card={card} />
									</button>
									<div className="grid-label">
										<button onClick={() => onSelect(card)}>{card.name}</button>
									</div>
									<small>
										{card.type.split(' — ')[0]} · MV {card.manaValue}
									</small>
									<div>{copies(card)}</div>
									<div className="grid-card-actions">
										<span className="price-col">{money(usdPrice(card))}</span>
										{actions(card)}
									</div>
								</article>
							))}
						</div>
					)}
					{result && result.pages > 1 && (
						<div className="pagination">
							<span>
								{(page - 1) * 36 + 1}–{Math.min(page * 36, result.total)} of{' '}
								{result.total.toLocaleString()}
							</span>
							<div>
								<button
									className="button small"
									disabled={page === 1 || loading}
									onClick={() => setPage((p) => p - 1)}
								>
									Previous
								</button>
								<span className="mono">
									{page} / {result.pages}
								</span>
								<button
									className="button small"
									disabled={page >= result.pages || loading}
									onClick={() => {
										setPage((p) => p + 1);
										input.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
									}}
								>
									Next
								</button>
							</div>
						</div>
					)}
				</section>
				<aside className="deck-rail">
					<div className="rail-title">
						<span className="eyebrow">Building with</span>
						<Icon name="deck" size={15} />
					</div>
					{deck ? (
						<>
							<select
								className="rail-deck-select"
								aria-label="Active deck"
								value={deck.id}
								onChange={(e) => {
									onChoose(e.target.value);
									setPage(1);
								}}
							>
								{decks.map((d) => (
									<option key={d.id} value={d.id}>
										{d.name}
									</option>
								))}
							</select>
							<div className="rail-meta">
								<span className="badge capitalize">{deck.format}</span>
								<span className="mono">
									{total}
									{deck.format === 'commander' ? '/99' : '/60'} main
								</span>
							</div>
							<select
								className="board-destination"
								value={board}
								aria-label="Destination board"
								onChange={(e) => setBoard(e.target.value as Entry['board'])}
							>
								<option value="main">Adding to mainboard</option>
								<option value="side">Adding to sideboard</option>
								<option value="maybe">Adding to maybeboard</option>
							</select>
							<div className="rail-divider" />
							<div className="rail-section-head">
								<span>Mainboard</span>
								<span className="mono">{total}</span>
							</div>
							<div className="rail-entries">
								{mainEntries.slice(0, 10).map((entry) => (
									<button
										key={entry.cardId}
										onClick={() => {
											const card = deckCards.get(entry.cardId);
											if (card) onSelect(card);
										}}
									>
										<span className="mono quantity">{entry.quantity}</span>
										<span>{deckCards.get(entry.cardId)?.name ?? 'Loading…'}</span>
									</button>
								))}
							</div>
							{mainEntries.length > 10 && (
								<button className="text-btn rail-more" onClick={onDeck}>
									View {mainEntries.length - 10} more cards
									<Icon name="arrow" size={12} />
								</button>
							)}
							<button className="button dark full" onClick={onDeck}>
								Open deck
								<Icon name="arrow" size={14} />
							</button>
							<p className="rail-hint">Use + to add a card. Changes save to your active deck.</p>
						</>
					) : (
						<button className="button" onClick={onDeck}>
							Create a deck
						</button>
					)}
					<details className="saved-search-section">
						<summary className="rail-heading">
							Saved searches <span className="muted">{saved.length}/20</span>
						</summary>
						{saved.length ? (
							<div className="saved-search-list">
								{saved.map((search, index) => (
									<div key={`${search.name}:${index}`}>
										<button
											className="saved-query"
											onClick={() => {
												setFilters(search.filters);
												setRequestedDeckId(
													search.filters.deckOnly ? (search.deckId ?? null) : null,
												);
												setPage(1);
											}}
										>
											{search.name}
										</button>
										<button
											className="icon-btn"
											aria-label={`Delete saved search ${search.name}`}
											onClick={() => setSaved((old) => old.filter((_, i) => i !== index))}
										>
											<Icon name="close" size={12} />
										</button>
									</div>
								))}
							</div>
						) : (
							<p className="rail-hint">Save a combination of filters to use it again.</p>
						)}
					</details>
					<div className="rail-source">
						<span className="status-dot ready" />
						<span>
							MTGJSON
							<br />
							<small>{status?.dataset?.date ?? 'Loading release'}</small>
						</span>
						<a
							href="https://mtgjson.com/faq/"
							target="_blank"
							rel="noreferrer"
							aria-label="MTGJSON data source"
						>
							<Icon name="external" size={13} />
						</a>
					</div>
				</aside>
			</div>
			{compare.length > 0 && (
				<div className="compare-tray" role="status">
					<span>{compare.length}/3 cards selected</span>
					<button
						className="button small"
						disabled={compare.length < 2}
						onClick={() => setComparing(true)}
					>
						Compare cards
						<Icon name="compare" size={12} />
					</button>
					<button aria-label="Clear comparison" onClick={() => setCompare([])}>
						<Icon name="close" size={14} />
					</button>
				</div>
			)}
			{comparing && (
				<CardCompare
					cards={compare}
					busy={busy}
					onAdd={(card) => onAdd(card, board)}
					onClose={() => setComparing(false)}
				/>
			)}
			{saveModal && (
				<Modal title="Save search" onClose={() => setSaveModal(false)}>
					<form
						className="modal-body"
						onSubmit={(e) => {
							e.preventDefault();
							if (!searchName.trim() || saved.length >= 20) return;
							setSaved((old) => [
								...old,
								{
									name: searchName.trim(),
									filters,
									...(filters.deckOnly && deck ? { deckId: deck.id } : {}),
								},
							]);
							setSaveModal(false);
						}}
					>
						<label className="field">
							Search name
							<input
								autoFocus
								value={searchName}
								maxLength={80}
								onChange={(e) => setSearchName(e.target.value)}
								required
							/>
						</label>
						<p className="muted">Saves the query, filters and sort order in this browser.</p>
						<button
							className="button dark full"
							disabled={!searchName.trim() || saved.length >= 20}
						>
							{saved.length >= 20 ? '20 searches saved; remove one first' : 'Save search'}
						</button>
					</form>
				</Modal>
			)}
		</>
	);
}
