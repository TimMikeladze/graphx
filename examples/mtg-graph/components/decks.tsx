'use client';
import { useEffect, useState } from 'react';
import type { Card, Deck, DeckRecord, Entry } from '@/src/schema';
import { formats } from '@/src/schema';
import { changeDeckFormat } from '@/src/deck-format';
import { deckBudget, groupEntries, money } from '@/src/workbench';
import { api, Icon, Mana, Modal, Copy, useCardMap, Empty } from './ui';
interface Props {
	decks: DeckRecord[];
	deck: DeckRecord | null;
	onChoose: (s: string) => void;
	onRefresh: () => Promise<void>;
	onSave: (d: DeckRecord) => Promise<DeckRecord>;
	onSelect: (c: Card) => void;
	onAnalyze: () => void;
	notify: (s: string) => void;
	busy: boolean;
	onUndo: () => void;
	onRedo: () => void;
	canUndo: boolean;
	canRedo: boolean;
}
export default function Decks({
	decks,
	deck,
	onChoose,
	onRefresh,
	onSave,
	onSelect,
	onAnalyze,
	notify,
	busy,
	onUndo,
	onRedo,
	canUndo,
	canRedo,
}: Props) {
	const [modal, setModal] = useState<'new' | 'import' | 'export' | 'history' | 'duplicate' | null>(
		null,
	);
	const [query, setQuery] = useState('');
	const [group, setGroup] = useState('type');
	const [sort, setSort] = useState('name');
	const [name, setName] = useState('');
	const [format, setFormat] = useState<string>('modern');
	const [text, setText] = useState('');
	const [board, setBoard] = useState<Entry['board']>('main');
	const [parsed, setParsed] = useState<any>(null);
	const [error, setError] = useState('');
	const [history, setHistory] = useState<any[]>([]);
	const [comparison, setComparison] = useState<any>(null);
	const [nameDraft, setNameDraft] = useState('');
	const [working, setWorking] = useState(false);
	const cards = useCardMap(
		deck?.entries.map((e) => e.cardId).concat(deck.commanderId ? [deck.commanderId] : []) ?? [],
	);
	useEffect(() => setNameDraft(deck?.name ?? ''), [deck?.id, deck?.name]);
	useEffect(() => {
		setQuery('');
		setBoard('main');
	}, [deck?.id]);
	const open = async (m: typeof modal) => {
		setModal(m);
		setName(m === 'duplicate' ? `${deck?.name ?? 'Deck'} copy`.slice(0, 120) : '');
		setParsed(null);
		setError('');
		setFormat(deck?.format ?? 'modern');
		if (m === 'import') setText('');
		if (m === 'export' && deck) {
			try {
				const r = await api(`/decks/${deck.id}/export`);
				setText(r.text);
			} catch (e) {
				setError((e as Error).message);
			}
		}
		if (m === 'history' && deck) {
			setHistory([]);
			setComparison(null);
			try {
				setHistory(await api(`/decks/${deck.id}/history`));
			} catch (e) {
				setError((e as Error).message);
			}
		}
	};
	const create = async () => {
		setWorking(true);
		try {
			if (parsed?.unknown?.length) throw new Error('Resolve unrecognized lines before importing');
			const d = await api<DeckRecord>('/decks', {
				method: 'POST',
				body: JSON.stringify({
					name: name.trim() || 'Untitled deck',
					format,
					entries: modal === 'duplicate' ? (deck?.entries ?? []) : (parsed?.entries ?? []),
					commanderId:
						modal === 'duplicate' && format === 'commander'
							? deck?.commanderId
							: (parsed?.commanderId ?? null),
				}),
			});
			await onRefresh();
			onChoose(d.id);
			setModal(null);
			notify(modal === 'duplicate' ? 'Deck duplicated' : 'Deck created');
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setWorking(false);
		}
	};
	const change = async (cardId: string, quantity: number) => {
		if (!deck) return;
		const entries = deck.entries
			.map((e) => (e.cardId === cardId && e.board === board ? { ...e, quantity } : e))
			.filter((e) => e.quantity > 0);
		await onSave({ ...deck, entries }).catch(() => {});
	};
	const move = async (e: Entry, to: Entry['board']) => {
		if (!deck || to === e.board) return;
		const entries = deck.entries
			.filter((x) => !(x.cardId === e.cardId && x.board === e.board))
			.map((x) => ({ ...x }));
		const old = entries.find((x) => x.cardId === e.cardId && x.board === to);
		if (old) old.quantity += e.quantity;
		else entries.push({ ...e, board: to });
		await onSave({ ...deck, entries }).catch(() => {});
	};
	const setCommander = async (cardId: string) => {
		if (!deck) return;
		const entries = deck.entries
			.map((e) =>
				e.cardId === cardId && e.board === 'main' ? { ...e, quantity: e.quantity - 1 } : e,
			)
			.filter((e) => e.quantity > 0);
		if (deck.commanderId) {
			const old = entries.find((e) => e.cardId === deck.commanderId && e.board === 'main');
			if (old) old.quantity++;
			else entries.push({ cardId: deck.commanderId, quantity: 1, board: 'main' });
		}
		await onSave({ ...deck, commanderId: cardId, entries }).catch(() => {});
	};
	const total = (b: string) =>
		deck?.entries.filter((e) => e.board === b).reduce((n, e) => n + e.quantity, 0) ?? 0;
	const groups = groupEntries(deck?.entries ?? [], cards, { board, query, group, sort });
	const entries = groups.flatMap(([, entries]) => entries);
	const budget = deck ? deckBudget(deck, cards) : null;
	return (
		<>
			<div className="page-heading">
				<div>
					<div className="eyebrow">WORKSPACE / LIBRARY</div>
					<h1>
						Decks<span className="heading-count">{decks.length}</span>
					</h1>
					<p className="page-description">Build, compare revisions, and keep track of your list.</p>
				</div>
				<div className="button-group">
					<button className="button" onClick={() => open('import')}>
						<Icon name="download" />
						Import
					</button>
					<button className="button dark" onClick={() => open('new')}>
						<Icon name="plus" />
						New deck
					</button>
				</div>
			</div>
			<div className="deck-layout">
				<aside className="deck-library">
					<div className="eyebrow">SAVED DECKS</div>
					{decks.map((d) => (
						<button
							key={d.id}
							onClick={() => {
								onChoose(d.id);
								setBoard('main');
							}}
							className={`library-item ${deck?.id === d.id ? 'selected' : ''}`}
						>
							<Icon name="deck" />
							<span>
								{d.name}
								<small className="capitalize">
									{d.format} ·{' '}
									{d.entries.filter((e) => e.board === 'main').reduce((n, e) => n + e.quantity, 0)}{' '}
									cards
								</small>
							</span>
							<Icon name="chevron" size={12} />
						</button>
					))}
				</aside>
				{deck ? (
					<section className="deck-editor">
						<div className="deck-title-row">
							<input
								aria-label="Deck name"
								className="deck-name-input"
								value={nameDraft}
								onChange={(e) => setNameDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') e.currentTarget.blur();
								}}
								onBlur={() => {
									if (nameDraft.trim() && nameDraft !== deck.name)
										onSave({ ...deck, name: nameDraft.trim() })
											.then(() => notify('Deck renamed'))
											.catch(() => {});
								}}
							/>
							<select
								aria-label="Deck format"
								value={deck.format}
								disabled={busy}
								onChange={(e) =>
									onSave({
										...deck,
										...changeDeckFormat(deck, e.target.value as Deck['format']),
									}).catch(() => {})
								}
							>
								{formats.map((f) => (
									<option key={f} value={f}>
										{f[0]!.toUpperCase() + f.slice(1)}
									</option>
								))}
							</select>
						</div>
						<div className="deck-tools">
							<span className="muted mono">
								{total('main')} main · {total('side')} side
							</span>
							<div>
								<button className="text-btn" disabled={busy} onClick={() => open('duplicate')}>
									<Icon name="copy" size={14} />
									Duplicate
								</button>
								<button className="text-btn" onClick={() => open('history')}>
									<Icon name="refresh" size={14} />
									History
								</button>
								<button className="text-btn" onClick={() => open('export')}>
									<Icon name="download" size={14} />
									Export
								</button>
								<button className="button dark small" onClick={onAnalyze}>
									<Icon name="chart" size={14} />
									Analyze
								</button>
							</div>
						</div>
						{budget && (
							<div className="deck-budget">
								<div>
									<span className="eyebrow">Estimated printing cost · USD</span>
									<div>
										<strong>{budget.priced ? money(budget.usd) : 'Unavailable'}</strong>
										{budget.missing > 0 && budget.priced > 0 && (
											<span className="badge">Partial total</span>
										)}
									</div>
									<small>Main + side + commander · Maybeboard excluded</small>
								</div>
								<span>
									{budget.priced}/{budget.total} copies priced
									<small>
										{budget.missing
											? `${budget.missing} copies without a price`
											: 'All copies priced'}
										<br />
										{budget.dates.length
											? `Snapshot ${budget.dates.join(' · ')}`
											: 'No price snapshot available'}
									</small>
								</span>
							</div>
						)}
						<div className="deck-edit-toolbar">
							<input
								aria-label="Search this deck"
								placeholder="Find a card in this deck…"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
							/>
							<select
								aria-label="Group deck cards"
								value={group}
								onChange={(e) => setGroup(e.target.value)}
							>
								<option value="type">Group: card type</option>
								<option value="mana">Group: mana value</option>
								<option value="none">No grouping</option>
							</select>
							<select
								aria-label="Sort deck cards"
								value={sort}
								onChange={(e) => setSort(e.target.value)}
							>
								<option value="name">Sort: name</option>
								<option value="mana">Sort: mana value</option>
								<option value="quantity">Sort: quantity</option>
								<option value="price">Sort: price ↓</option>
							</select>
							<button
								className="button small"
								aria-label="Undo deck edit"
								title="Undo last edit"
								disabled={busy || !canUndo}
								onClick={onUndo}
							>
								<Icon name="undo" size={14} />
							</button>
							<button
								className="button small"
								aria-label="Redo deck edit"
								title="Redo last edit"
								disabled={busy || !canRedo}
								onClick={onRedo}
							>
								<Icon name="redo" size={14} />
							</button>
						</div>
						{deck.format === 'commander' && (
							<div className="commander-slot">
								<span className="eyebrow">COMMANDER</span>
								{deck.commanderId ? (
									<button
										className="text-btn"
										onClick={() => {
											const c = cards.get(deck.commanderId!);
											if (c) onSelect(c);
										}}
									>
										{cards.get(deck.commanderId)?.name ?? 'Loading…'}
									</button>
								) : (
									<span className="muted">Choose a legendary creature using its row menu.</span>
								)}
							</div>
						)}
						<div className="mini-tabs board-tabs">
							{[
								['main', 'Mainboard'],
								['side', 'Sideboard'],
								['maybe', 'Maybeboard'],
							].map(([b, label]) => (
								<button
									key={b}
									className={board === b ? 'active' : ''}
									onClick={() => setBoard(b as Entry['board'])}
								>
									{label}
									<span>{total(b!)}</span>
								</button>
							))}
						</div>
						{!entries.length ? (
							<Empty>
								<Icon name="deck" size={28} />
								<h3>
									{query
										? 'No cards match your search'
										: `No cards in ${board === 'main' ? 'mainboard' : board === 'side' ? 'sideboard' : 'maybeboard'}`}
								</h3>
								{query ? (
									<button className="button" onClick={() => setQuery('')}>
										Clear deck search
									</button>
								) : (
									<a className="button" href="#cards">
										Search cards
										<Icon name="arrow" size={14} />
									</a>
								)}
							</Empty>
						) : (
							groups.map(([group, es]) => (
								<div className="deck-card-group" key={group}>
									<div className="group-label">
										<span>{group}</span>
										<span className="mono">{es.reduce((n, e) => n + e.quantity, 0)}</span>
									</div>
									{es.map((e) => {
										const c = cards.get(e.cardId);
										return (
											<div className="deck-card-row" key={e.cardId}>
												<div className="quantity-stepper">
													<button
														disabled={busy}
														aria-label={`Remove one ${c?.name}`}
														onClick={() => change(e.cardId, e.quantity - 1)}
													>
														−
													</button>
													<span className="mono">{e.quantity}</span>
													<button
														disabled={busy || e.quantity >= 999}
														aria-label={`Add one ${c?.name}`}
														onClick={() => change(e.cardId, e.quantity + 1)}
													>
														+
													</button>
												</div>
												<button className="deck-card-name" onClick={() => c && onSelect(c)}>
													{c?.name ?? 'Loading…'}
												</button>
												<Mana cost={c?.manaCost ?? ''} />
												<select
													value=""
													aria-label={`Move ${c?.name}`}
													disabled={busy}
													className="row-menu"
													onChange={(ev) => {
														if (ev.target.value === 'commander') setCommander(e.cardId);
														else if (ev.target.value === 'remove') change(e.cardId, 0);
														else move(e, ev.target.value as Entry['board']);
													}}
												>
													<option value="">···</option>
													{['main', 'side', 'maybe']
														.filter((b) => b !== board)
														.map((b) => (
															<option key={b} value={b}>
																Move to {b}
															</option>
														))}
													{deck.format === 'commander' && c?.leadershipSkills?.commander && (
														<option value="commander">Set commander</option>
													)}
													<option value="remove">Remove card</option>
												</select>
											</div>
										);
									})}
								</div>
							))
						)}
						<div className="editor-status">
							<span className="status-dot ready" />
							{busy ? 'Saving…' : 'Saved to GraphX'}
							<span className="mono">rev {deck.revision}</span>
						</div>
					</section>
				) : (
					<Empty>Create a deck to start.</Empty>
				)}
			</div>
			{modal && (
				<Modal
					title={
						{
							new: 'New deck',
							import: 'Import deck',
							export: 'Export deck',
							history: 'Version history',
							duplicate: 'Duplicate deck',
						}[modal]
					}
					onClose={() => setModal(null)}
				>
					<div className="modal-body">
						{(modal === 'new' || modal === 'import' || modal === 'duplicate') && (
							<>
								<label className="field">
									Deck name
									<input
										value={name}
										onChange={(e) => setName(e.target.value)}
										placeholder="Untitled deck"
										aria-label="New deck name"
										maxLength={120}
									/>
								</label>
								<label className="field">
									Format
									<select
										aria-label="New deck format"
										disabled={modal === 'duplicate'}
										value={format}
										onChange={(e) => setFormat(e.target.value)}
									>
										{formats.map((f) => (
											<option key={f} value={f}>
												{f}
											</option>
										))}
									</select>
								</label>
							</>
						)}
						{modal === 'import' && (
							<>
								<label className="field">
									Decklist
									<textarea
										rows={10}
										value={text}
										onChange={(e) => {
											setText(e.target.value);
											setParsed(null);
										}}
										placeholder={'4 Counterspell\n4 Consider\n\nSideboard\n2 Spell Pierce'}
									/>
								</label>
								<button
									className="button"
									disabled={!text.trim()}
									onClick={async () => {
										try {
											setParsed(
												await api('/import', { method: 'POST', body: JSON.stringify({ text }) }),
											);
											setError('');
										} catch (e) {
											setError((e as Error).message);
										}
									}}
								>
									Parse decklist
								</button>
								{parsed && (
									<div className="import-result">
										<p>
											{parsed.entries.reduce((n: number, e: Entry) => n + e.quantity, 0)} cards
											recognized
										</p>
										{parsed.unknown.length > 0 && (
											<>
												<p className="error-text">
													Unrecognized lines. Correct them before importing.
												</p>
												<pre>{parsed.unknown.join('\n')}</pre>
											</>
										)}
									</div>
								)}
							</>
						)}
						{(modal === 'new' || modal === 'import' || modal === 'duplicate') && (
							<button
								className="button dark full"
								disabled={working || (modal === 'import' && (!parsed || parsed.unknown.length > 0))}
								onClick={create}
							>
								{working ? 'Saving…' : modal === 'duplicate' ? 'Duplicate deck' : 'Create deck'}
							</button>
						)}
						{modal === 'export' && (
							<>
								<textarea
									className="export-text"
									readOnly
									value={text}
									rows={15}
									aria-label="Exported decklist"
								/>
								<div className="button-group">
									<Copy text={text} />
									<button
										className="button"
										onClick={() => {
											const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
											const a = document.createElement('a');
											a.href = url;
											a.download = `${deck?.name ?? 'deck'}.txt`;
											a.click();
											URL.revokeObjectURL(url);
										}}
									>
										<Icon name="download" />
										Download .txt
									</button>
								</div>
							</>
						)}
						{modal === 'history' && (
							<div className="history-list">
								{[...history].reverse().map((h, i) => (
									<article key={h.revision}>
										<div>
											<strong>{h.data.name}</strong>
											<small>
												{new Date(h.at).toLocaleString()} ·{' '}
												{h.data.entries.reduce((n: number, e: Entry) => n + e.quantity, 0)} cards
											</small>
										</div>
										{i === 0 ? (
											<span className="badge">Current</span>
										) : (
											<div className="button-group">
												<button
													className="button small"
													onClick={async () => {
														try {
															setComparison(
																await api(`/decks/${deck!.id}/compare?revision=${h.revision}`),
															);
														} catch (e) {
															setError((e as Error).message);
														}
													}}
												>
													Compare
												</button>
												<button
													className="button small"
													disabled={busy}
													onClick={async () => {
														if (deck) {
															await onSave({ ...deck, ...h.data });
															setModal(null);
															notify('Version restored');
														}
													}}
												>
													Restore
												</button>
											</div>
										)}
									</article>
								))}
							</div>
						)}
						{comparison && (
							<div className="revision-comparison">
								<h3>Changes since revision {comparison.from}</h3>
								{comparison.name.before !== comparison.name.after && (
									<p>
										{comparison.name.before} → {comparison.name.after}
									</p>
								)}
								{comparison.format.before !== comparison.format.after && (
									<p>
										{comparison.format.before} → {comparison.format.after}
									</p>
								)}
								{comparison.added.map((e: any) => (
									<p key={`add:${e.board}:${e.cardId}`}>
										<code>+{e.quantity}</code> {e.name} <span className="muted">({e.board})</span>
									</p>
								))}
								{comparison.removed.map((e: any) => (
									<p key={`remove:${e.board}:${e.cardId}`}>
										<code>−{e.quantity}</code> {e.name} <span className="muted">({e.board})</span>
									</p>
								))}
								{!comparison.added.length && !comparison.removed.length && (
									<p className="muted">Card quantities unchanged.</p>
								)}
							</div>
						)}
						{error && (
							<p className="error-text" role="alert">
								{error}
							</p>
						)}
					</div>
				</Modal>
			)}
		</>
	);
}
