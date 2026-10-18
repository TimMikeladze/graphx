'use client';
import { useEffect, useState } from 'react';
import type { Card } from '@/src/schema';
import { formats } from '@/src/schema';
import { api, Modal, Icon, CardImage, Mana, Colors } from './ui';
export default function CardDetail({
	card,
	onClose,
	onSelect,
	onAdd,
	onGraph,
	busy,
}: {
	card: Card;
	onClose: () => void;
	onSelect: (c: Card) => void;
	onAdd: (c: Card, board?: 'main' | 'side' | 'maybe') => void;
	onGraph: (c: Card) => void;
	busy: boolean;
}) {
	const [tab, setTab] = useState('Oracle');
	const [face, setFace] = useState(0);
	const [detail, setDetail] = useState<any>(null);
	const [similar, setSimilar] = useState<any[]>([]);
	const [error, setError] = useState('');
	const [board, setBoard] = useState<'main' | 'side' | 'maybe'>('main');
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		let active = true;
		setDetail(null);
		setFace(0);
		setError('');
		setCopied(false);
		Promise.all([
			api(`/cards/${encodeURIComponent(card.id)}`),
			api<any[]>(`/cards/${encodeURIComponent(card.id)}/similar`),
		])
			.then(([d, s]) => {
				if (active) {
					setDetail(d);
					setSimilar(s);
				}
			})
			.catch((e) => {
				if (active) setError(e.message);
			});
		return () => {
			active = false;
		};
	}, [card.id]);
	const current = card.faces[face] ?? card.faces[0]!;
	return (
		<Modal title={card.name} onClose={onClose} wide>
			<div className="card-detail">
				<div className="detail-art">
					<CardImage card={card} face={face === 0 ? 'front' : 'back'} />
					{card.faces.length > 1 && (
						<button
							className="button full small"
							onClick={() => setFace((f) => (f + 1) % card.faces.length)}
						>
							<Icon name="refresh" />
							Face {face + 1} / {card.faces.length}
						</button>
					)}
					<button className="button full" onClick={() => onGraph(card)}>
						<Icon name="graph" />
						Explore graph
					</button>
					<button
						className="button full"
						onClick={async () => {
							try {
								const url = new URL(location.href);
								url.searchParams.set('card', card.id);
								url.hash = 'cards';
								await navigator.clipboard.writeText(url.toString());
								setCopied(true);
							} catch {
								setError('Clipboard unavailable. Copy the card URL from the address bar.');
							}
						}}
					>
						<Icon name={copied ? 'check' : 'copy'} />
						{copied ? 'Link copied' : 'Copy card link'}
					</button>
					{card.scryfallId && (
						<a
							className="text-btn external-link"
							href={`https://scryfall.com/card/${card.scryfallId}`}
							target="_blank"
							rel="noreferrer"
						>
							Scryfall
							<Icon name="external" size={12} />
						</a>
					)}
				</div>
				<div className="detail-content">
					<div className="detail-card-heading">
						<h2>{current.name}</h2>
						<Mana cost={current.manaCost} />
					</div>
					<p className="card-type">{current.type}</p>
					<div className="mini-tabs">
						{['Oracle', 'Rulings', 'Printings'].map((t) => (
							<button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
								{t}
								{t === 'Rulings' && <span>{card.rulings.length}</span>}
								{t === 'Printings' && <span>{card.printings.length}</span>}
							</button>
						))}
					</div>
					{tab === 'Oracle' && (
						<>
							<p className="oracle-text">{current.text || 'No oracle text.'}</p>
							{current.power !== undefined && (
								<div className="power mono">
									{current.power} / {current.toughness}
								</div>
							)}
							{current.loyalty && <div className="power mono">Loyalty {current.loyalty}</div>}
							<div className="detail-facts">
								<div>
									<span>Mana value</span>
									<span className="mono">{card.manaValue}</span>
								</div>
								<div>
									<span>Color identity</span>
									<Colors colors={card.colorIdentity} />
								</div>
								<div>
									<span>EDHREC rank</span>
									<span className="mono">
										{card.edhrecRank ? `#${card.edhrecRank.toLocaleString()}` : '—'}
									</span>
								</div>
								{card.prices && (
									<div>
										<span>USD · {card.prices.asOf}</span>
										<span className="mono">
											{card.prices.usd ? `$${card.prices.usd}` : 'Unavailable'}
										</span>
									</div>
								)}
								<div>
									<span>Layout</span>
									<span>{card.layout.replaceAll('_', ' ')}</span>
								</div>
							</div>
							{detail?.roles?.length > 0 && (
								<div className="role-tags">
									{detail.roles.map((r: any) => (
										<span
											key={r.name}
											className="badge"
											title={`Rule v${r.ruleVersion}: ${r.evidence}`}
										>
											{r.name}
										</span>
									))}
								</div>
							)}
							<div className="legalities">
								{formats.map((f) => (
									<div key={f}>
										<span className="capitalize">{f}</span>
										<span
											className={
												['Legal', 'Restricted'].includes(card.legalities[f] ?? '')
													? 'legal'
													: 'muted'
											}
										>
											{card.legalities[f] === 'Legal' ? <Icon name="check" size={12} /> : null}
											{card.legalities[f] ?? 'Not legal'}
										</span>
									</div>
								))}
							</div>
						</>
					)}
					{tab === 'Rulings' && (
						<div className="rulings">
							{card.rulings.length ? (
								card.rulings.map((r, i) => (
									<article key={i}>
										<time className="mono">{r.date}</time>
										<p>{r.text}</p>
									</article>
								))
							) : (
								<p className="muted">No rulings in this release.</p>
							)}
						</div>
					)}
					{tab === 'Printings' && (
						<div className="printings">
							{card.printings.map((s) => (
								<a
									key={s}
									href={`https://scryfall.com/search?q=${encodeURIComponent(`!"${card.name}" set:${s}`)}`}
									target="_blank"
									rel="noreferrer"
								>
									<span className="mono">{s}</span>
									<Icon name="external" size={12} />
								</a>
							))}
						</div>
					)}
					{error && <p className="error-text">{error}</p>}
					<div className="detail-actions">
						<select
							aria-label="Add to board"
							value={board}
							onChange={(e) => setBoard(e.target.value as typeof board)}
						>
							<option value="main">Mainboard</option>
							<option value="side">Sideboard</option>
							<option value="maybe">Maybeboard</option>
						</select>
						<button className="button dark" disabled={busy} onClick={() => onAdd(card, board)}>
							<Icon name="plus" />
							Add to deck
						</button>
					</div>
				</div>
			</div>
			{similar.length > 0 && (
				<div className="similar-section">
					<div className="section-heading">
						<h3>Related cards</h3>
						<span className="muted">Shared graph neighbors</span>
					</div>
					<div className="similar-list">
						{similar.slice(0, 6).map((s) => (
							<button key={s.card.id} onClick={() => onSelect(s.card)}>
								<span>
									{s.card.name}
									<small>
										{s.evidence
											.slice(0, 3)
											.map((e: any) => e.name)
											.join(' · ')}
									</small>
								</span>
								<Icon name="chevron" size={13} />
							</button>
						))}
					</div>
				</div>
			)}
		</Modal>
	);
}
