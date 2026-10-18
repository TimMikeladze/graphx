'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
	filterBoardCards,
	getDeckBoards,
	libraryHref,
	librarySectionLabel,
	safeLibraryReturnTo,
	type LibraryRecordKind,
} from '@/src/library-navigation';
import { formats, type DeckRecord } from '@/src/schema';
import { api, Icon, Mana } from './ui';

type Source = Record<string, any>;
type LoadedRecord = { key: string; source: Source | null; error: string; loading: boolean };

const display = (value: unknown): string =>
	typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const label = (value: string) =>
	value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
const isSource = (value: unknown): value is Source =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const safeExternal = (value: unknown): string | null => {
	if (typeof value !== 'string') return null;
	try {
		const url = new URL(value);
		return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
			? url.href
			: null;
	} catch {
		return null;
	}
};

export default function LibraryRecord({
	kind,
	id,
	name,
	onCopy,
	notify,
}: {
	kind: LibraryRecordKind;
	id: string;
	name?: string;
	onCopy: (deck: DeckRecord) => void;
	notify: (message: string) => void;
}) {
	const params = useSearchParams();
	const back = safeLibraryReturnTo(params.get('from'), libraryHref(kind));
	const recordKey = `${kind}:${id}`;
	const [loaded, setLoaded] = useState<LoadedRecord>({
		key: '',
		source: null,
		error: '',
		loading: true,
	});
	const [retry, setRetry] = useState(0);
	const [format, setFormat] = useState<string>('modern');
	const [copying, setCopying] = useState(false);
	const [copyError, setCopyError] = useState('');
	useEffect(() => {
		const controller = new AbortController();
		setLoaded({ key: recordKey, source: null, error: '', loading: true });
		setCopyError('');
		api<Source | null>(`/library/${kind}/${encodeURIComponent(id)}`, { signal: controller.signal })
			.then((source) => {
				if (controller.signal.aborted) return;
				setLoaded({ key: recordKey, source, error: '', loading: false });
				const sourceFormat = String(source?.format ?? source?.type ?? '').toLowerCase();
				setFormat(
					formats.find((f) => sourceFormat.includes(f)) ??
						(source?.commander?.length ? 'commander' : 'modern'),
				);
			})
			.catch((error: Error) => {
				if (!controller.signal.aborted)
					setLoaded({ key: recordKey, source: null, error: error.message, loading: false });
			});
		return () => controller.abort();
	}, [kind, id, recordKey, retry]);
	const source = loaded.key === recordKey ? loaded.source : null;
	const loading = loaded.key !== recordKey || loaded.loading;
	const error = loaded.key === recordKey ? loaded.error : '';
	const faces: Source[] = source
		? kind === 'atomic' && Array.isArray(source.data)
			? source.data.filter(isSource)
			: [source]
		: [];
	const primary = faces[0] ?? source ?? {};
	const title = display(primary.name) || name || id;
	const boards = source && kind === 'decks' ? getDeckBoards(source) : [];
	const board = boards.find((item) => item.key === params.get('board')) ?? boards[0];
	const query = params.get('cardSearch') ?? '';
	const queryString = params.toString();
	const currentHref = `${libraryHref(kind, id)}${queryString ? `?${queryString}` : ''}`;
	const stateHref = (key: string, value: string) => {
		const next = new URLSearchParams(params.toString());
		if (value) next.set(key, value);
		else next.delete(key);
		const search = next.toString();
		return `${libraryHref(kind, id)}${search ? `?${search}` : ''}`;
	};
	const copy = async () => {
		setCopying(true);
		setCopyError('');
		try {
			const deck = await api<DeckRecord>(`/library/decks/${encodeURIComponent(id)}/copy`, {
				method: 'POST',
				body: JSON.stringify({ format }),
			});
			onCopy(deck);
			notify(`Copied ${deck.name} to your decks`);
		} catch (error) {
			setCopyError((error as Error).message);
		} finally {
			setCopying(false);
		}
	};
	return (
		<article className="catalog-record">
			<nav className="catalog-record-breadcrumb" aria-label="Breadcrumb">
				<Link href="/library">Library</Link>
				<span aria-hidden="true">/</span>
				<Link href={libraryHref(kind)}>{librarySectionLabel(kind)}</Link>
				<span aria-hidden="true">/</span>
				<span aria-current="page">{title}</span>
			</nav>
			<Link href={back} className="catalog-record-back">
				<span aria-hidden="true">←</span> Back to library
			</Link>
			<header className="catalog-record-heading">
				<span className="eyebrow">{librarySectionLabel(kind)}</span>
				<h1>{loading ? 'Loading record…' : error || !source ? 'Record unavailable' : title}</h1>
				{source && (
					<div className="catalog-record-actions">
						{kind === 'decks' && (
							<>
								<label>
									Format
									<select
										aria-label="Copied deck format"
										value={format}
										disabled={copying}
										onChange={(e) => setFormat(e.target.value)}
									>
										{formats.map((value) => (
											<option key={value} value={value}>
												{value}
											</option>
										))}
									</select>
								</label>
								<button className="button dark" onClick={copy} disabled={copying}>
									<Icon name="copy" size={14} />
									{copying ? 'Copying…' : 'Copy and open deck'}
								</button>
							</>
						)}
						<a
							className="catalog-record-json-link"
							href={`/api/v1/library/${kind}/${encodeURIComponent(id)}`}
							target="_blank"
							rel="noreferrer"
						>
							<Icon name="code" size={14} /> Source JSON
						</a>
					</div>
				)}
				{copyError && (
					<p className="error-text" role="alert">
						{copyError}
					</p>
				)}
			</header>
			{loading ? (
				<p className="catalog-record-status" role="status">
					Loading source record…
				</p>
			) : error ? (
				<div className="error-box" role="alert">
					<p>{error}</p>
					<button className="button small" onClick={() => setRetry((n) => n + 1)}>
						Retry
					</button>
				</div>
			) : !source ? (
				<p className="catalog-record-status">This record was not found in the installed catalog.</p>
			) : (
				<div className="catalog-record-layout">
					<div className="catalog-record-main">
						{kind === 'decks' &&
							(board ? (
								<section className="catalog-deck" aria-label="Deck cards">
									<nav className="catalog-board-tabs" aria-label="Deck boards">
										{boards.map((item) => (
											<Link
												key={item.key}
												href={stateHref('board', item.key)}
												scroll={false}
												aria-current={item.key === board.key ? 'page' : undefined}
											>
												{item.label}
												<span>{item.quantity.toLocaleString()}</span>
											</Link>
										))}
									</nav>
									<div className="catalog-board-toolbar">
										<label className="catalog-board-search">
											<Icon name="search" size={16} />
											<input
												aria-label={`Search ${board.label.toLowerCase()}`}
												placeholder="Search cards by name, type or rules…"
												value={query}
												onChange={(e) =>
													window.history.replaceState(
														null,
														'',
														stateHref('cardSearch', e.target.value),
													)
												}
											/>
										</label>
										<span className="muted">
											{board.cards.length.toLocaleString()} card entries
										</span>
									</div>
									<CardTable
										cards={filterBoardCards(board.cards, query)}
										tokenBoard={/token/i.test(board.key)}
										from={currentHref}
									/>
								</section>
							) : (
								<p className="catalog-record-status">No cards are included in this source deck.</p>
							))}
						{['printings', 'tokens', 'identifiers', 'atomic'].includes(kind) && (
							<div className="catalog-card-faces">
								{faces.map((face, index) => (
									<CardSource key={index} source={face} showName={faces.length > 1} />
								))}
							</div>
						)}
						{kind === 'sets' && (
							<section className="catalog-set-browse">
								<h2>Browse this set</h2>
								<p className="muted">View the cards, products and published decks in {title}.</p>
								<div>
									{(['printings', 'tokens', 'sealed', 'decks'] as const).map((next) => (
										<Link
											className="button"
											key={next}
											href={`${libraryHref(next)}?${new URLSearchParams({ set: display(source.code ?? source.setCode) || id })}`}
										>
											{librarySectionLabel(next)}
											<Icon name="arrow" size={14} />
										</Link>
									))}
								</div>
							</section>
						)}
						<SourceDetails source={source} />
					</div>
					<Overview source={primary} kind={kind} boards={boards} from={currentHref} />
				</div>
			)}
		</article>
	);
}

function CardTable({
	cards,
	tokenBoard,
	from,
}: {
	cards: Source[];
	tokenBoard: boolean;
	from: string;
}) {
	return (
		<div className="catalog-card-table-wrap">
			<table className="catalog-card-table">
				<thead>
					<tr>
						<th scope="col">Card</th>
						<th scope="col">Type</th>
						<th scope="col">Mana</th>
						<th scope="col">Qty</th>
					</tr>
				</thead>
				<tbody>
					{cards.length ? (
						cards.map((card, index) => {
							const uuid = display(card.uuid);
							const name = display(card.name);
							const href = uuid
								? libraryHref(tokenBoard ? 'tokens' : 'identifiers', uuid, from)
								: name
									? libraryHref('atomic', name, from)
									: null;
							return (
								<tr key={`${uuid || name}:${index}`}>
									<td>
										{href ? (
											<Link href={href} prefetch={false}>
												{name || uuid}
											</Link>
										) : (
											<span>Unnamed card</span>
										)}
										{card.setCode && (
											<small>
												{display(card.setCode)}
												{card.number ? ` · ${display(card.number)}` : ''}
											</small>
										)}
									</td>
									<td>{display(card.type) || '—'}</td>
									<td>
										{card.manaCost ? (
											<Mana cost={display(card.manaCost)} />
										) : (
											<span className="muted">—</span>
										)}
									</td>
									<td className="mono">{display(card.count ?? card.quantity ?? 1)}</td>
								</tr>
							);
						})
					) : (
						<tr>
							<td colSpan={4} className="catalog-no-cards">
								No cards match this search.
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}

function CardSource({ source, showName }: { source: Source; showName: boolean }) {
	const scryfallId = display(source.identifiers?.scryfallId ?? source.scryfallId);
	const [failedId, setFailedId] = useState('');
	return (
		<section className="catalog-card-source">
			{scryfallId && failedId !== scryfallId && (
				<img
					loading="lazy"
					src={`/api/image/${encodeURIComponent(scryfallId)}`}
					alt={display(source.name) || 'Card printing'}
					onError={() => setFailedId(scryfallId)}
				/>
			)}
			<div>
				{showName && <h2>{display(source.name) || 'Card face'}</h2>}
				{source.manaCost && <Mana cost={display(source.manaCost)} />}
				{source.type && <h3>{display(source.type)}</h3>}
				{source.text && <p className="catalog-rules-text">{display(source.text)}</p>}
				{source.flavorText && <p className="catalog-flavor-text">{display(source.flavorText)}</p>}
				{(source.power != null || source.toughness != null) && (
					<p className="mono">
						{display(source.power)} / {display(source.toughness)}
					</p>
				)}
				{source.loyalty != null && <p>Loyalty: {display(source.loyalty)}</p>}
				{source.defense != null && <p>Defense: {display(source.defense)}</p>}
				{!source.text && !source.type && (
					<p className="muted">Card details are available in the source fields below.</p>
				)}
			</div>
		</section>
	);
}

function Overview({
	source,
	kind,
	boards,
	from,
}: {
	source: Source;
	kind: LibraryRecordKind;
	boards: ReturnType<typeof getDeckBoards>;
	from: string;
}) {
	const setCode = display(source.setCode ?? source.code);
	const fields = [
		['Type', source.type ?? source.format],
		['Released', source.releaseDate],
		[
			'Cards',
			kind === 'decks'
				? boards.reduce((total, board) => total + board.quantity, 0).toLocaleString()
				: (source.totalSetSize ?? source.baseSetSize ?? source.cardCount),
		],
		['Collector number', source.number],
		['Rarity', source.rarity],
		['Artist', source.artist],
	].filter(([, value]) => value != null && value !== '');
	const links = Object.entries({
		...(isSource(source.purchaseUrls) ? source.purchaseUrls : {}),
		...(isSource(source.urls) ? source.urls : {}),
		...(source.sourceUrl ? { source: source.sourceUrl } : {}),
		...(source.url ? { website: source.url } : {}),
	}).flatMap(([name, value]) => {
		const href = safeExternal(value);
		return href ? [{ name, href }] : [];
	});
	return (
		<aside className="catalog-record-overview" aria-label="Record overview">
			<h2>Overview</h2>
			<dl>
				{setCode && (
					<div>
						<dt>Set</dt>
						<dd>
							<Link href={libraryHref('sets', setCode, from)}>{setCode.toUpperCase()}</Link>
						</dd>
					</div>
				)}
				{fields.map(([key, value]) => (
					<div key={key}>
						<dt>{key}</dt>
						<dd>{display(value)}</dd>
					</div>
				))}
				{boards.length > 0 && (
					<div>
						<dt>Boards</dt>
						<dd>{boards.length}</dd>
					</div>
				)}
			</dl>
			{links.length > 0 && (
				<div className="catalog-record-source-links">
					<h3>Sources</h3>
					{links.map(({ name, href }) => (
						<a href={href} key={name} target="_blank" rel="noreferrer">
							{label(name)}
							<Icon name="external" size={13} />
						</a>
					))}
				</div>
			)}
		</aside>
	);
}

function SourceDetails({ source }: { source: Source }) {
	const [showJson, setShowJson] = useState(false);
	const metadata = Object.entries(source).filter(
		([key, value]) => key !== '_catalog' && (value == null || typeof value !== 'object'),
	);
	return (
		<div className="catalog-record-disclosures">
			{metadata.length > 0 && (
				<details>
					<summary>Record metadata</summary>
					<dl className="catalog-record-metadata">
						{metadata.map(([key, value]) => (
							<div key={key}>
								<dt>{label(key)}</dt>
								<dd>{display(value) || '—'}</dd>
							</div>
						))}
					</dl>
				</details>
			)}
			<details onToggle={(e) => setShowJson(e.currentTarget.open)}>
				<summary>All source fields</summary>
				{showJson && <pre tabIndex={0}>{JSON.stringify(source, null, 2)}</pre>}
			</details>
		</div>
	);
}
