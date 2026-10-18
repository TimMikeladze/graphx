'use client';
import { useEffect, useState } from 'react';
import type { Card, DeckRecord } from '@/src/schema';
import { api, Icon, CardImage, Mana, Empty, useCardMap } from './ui';
import { landDropOdds } from '@/src/workbench';
import { Curve } from './charts';
export default function Analysis({
	deck,
	onSelect,
	onAdd,
	onDeck,
}: {
	deck: DeckRecord | null;
	onSelect: (c: Card) => void;
	onAdd: (c: Card) => void;
	onDeck: () => void;
}) {
	const [data, setData] = useState<any>(null);
	const [suggestions, setSuggestions] = useState<any[]>([]);
	const [error, setError] = useState('');
	const [tab, setTab] = useState('Overview');
	const [input, setInput] = useState({ population: 60, successes: 4, draws: 7, minimum: 1 });
	const [chance, setChance] = useState<any>(null);
	const [calcError, setCalcError] = useState('');
	const [hand, setHand] = useState<Card[]>([]);
	const [mulligans, setMulligans] = useState(0);
	const [bottom, setBottom] = useState<number[]>([]);
	const [kept, setKept] = useState(false);
	const [dealing, setDealing] = useState(false);
	const [onDraw, setOnDraw] = useState(false);
	const [issueFilter, setIssueFilter] = useState('');
	const cards = useCardMap(
		deck?.entries.map((e) => e.cardId).concat(deck.commanderId ? [deck.commanderId] : []) ?? [],
	);
	useEffect(() => {
		if (!deck) return;
		let active = true;
		setData(null);
		setError('');
		setHand([]);
		setMulligans(0);
		setKept(false);
		setBottom([]);
		setIssueFilter('');
		setOnDraw(deck.format === 'commander');
		Promise.all([
			api(`/decks/${deck.id}/analysis`),
			api<any[]>(`/decks/${deck.id}/recommendations`),
		])
			.then(([a, s]) => {
				if (active) {
					setData(a);
					setSuggestions(s);
					setInput((old) => ({
						...old,
						population: a.total,
						successes: Math.min(4, a.total),
						draws: Math.min(7, a.total),
					}));
				}
			})
			.catch((e) => {
				if (active) setError(e.message);
			});
		return () => {
			active = false;
		};
	}, [deck?.id, deck?.revision]);
	useEffect(() => {
		let active = true;
		api('/probability', { method: 'POST', body: JSON.stringify(input) })
			.then((p) => {
				if (active) {
					setChance(p);
					setCalcError('');
				}
			})
			.catch((e) => {
				if (active) setCalcError(e.message);
			});
		return () => {
			active = false;
		};
	}, [input]);
	const deal = async (m = 0) => {
		if (!deck) return;
		setDealing(true);
		try {
			const r = await api(`/decks/${deck.id}/hand`);
			setHand(r.hand);
			setMulligans(m);
			setBottom([]);
			setKept(false);
			setError('');
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setDealing(false);
		}
	};
	const visibleHand = hand.filter((_, index) => kept || !bottom.includes(index));
	const handLands = visibleHand.filter((card) => card.faces[0]?.type.includes('Land')).length;
	const handSpells = visibleHand.filter((card) => !card.faces[0]?.type.includes('Land'));
	const handAverage = handSpells.length
		? handSpells.reduce((sum, card) => sum + card.manaValue, 0) / handSpells.length
		: 0;
	if (!deck)
		return (
			<Empty>
				<h3>No active deck</h3>
				<button className="button" onClick={onDeck}>
					Create a deck
				</button>
			</Empty>
		);
	return (
		<>
			<div className="page-heading">
				<div>
					<div className="eyebrow">WORKSPACE / {deck.name.toUpperCase()}</div>
					<h1>Analysis</h1>
					<p className="page-description">Check your curve, mana, and opening-hand consistency.</p>
				</div>
				<button className="button" onClick={onDeck}>
					<Icon name="deck" />
					Edit deck
					<Icon name="arrow" size={14} />
				</button>
			</div>
			<div className="analysis-heading">
				<span className="badge capitalize">{deck.format}</span>
				<span>{deck.name}</span>
				<span className="muted mono">rev {deck.revision}</span>
			</div>
			<div className="mini-tabs analysis-tabs">
				{['Overview', 'Probabilities', 'Opening hand', 'Suggestions'].map((t) => (
					<button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
						{t}
					</button>
				))}
			</div>
			{error && (
				<div className="error-box" role="alert">
					{error}
				</div>
			)}
			{tab === 'Overview' && data && (
				<>
					<div className="stats-grid">
						{[
							['Mainboard', data.total, 'cards'],
							['Average mana value', data.averageManaValue.toFixed(2), 'nonland'],
							[
								'Lands',
								data.landCount,
								`${data.total ? ((100 * data.landCount) / data.total).toFixed(1) : 0}% of mainboard`,
							],
							[
								'Opening ≥2 lands',
								data.openingLandProbability === null
									? '—'
									: `${(data.openingLandProbability * 100).toFixed(1)}%`,
								'first 7 cards',
							],
						].map(([label, value, caption]) => (
							<div key={label} className="stat">
								<span>{label}</span>
								<strong className="mono">{value}</strong>
								<small>{caption}</small>
							</div>
						))}
					</div>
					<div className="analysis-grid">
						<section className="panel">
							<div className="panel-heading">
								<h3>Mana curve</h3>
								<span className="muted">{data.spellCount} nonland cards</span>
							</div>
							<Curve rows={data.curve} />
						</section>
						<section className="panel">
							<div className="panel-heading">
								<h3>Card types</h3>
								<span className="muted">Mainboard</span>
							</div>
							<div className="type-breakdown">
								{Object.entries(data.types as Record<string, number>)
									.sort((a, b) => b[1] - a[1])
									.map(([type, count]) => (
										<div key={type}>
											<div>
												<span>{type}</span>
												<span className="mono">{count}</span>
											</div>
											<div className="bar-track">
												<span
													style={{ width: `${data.total ? (count / data.total) * 100 : 0}%` }}
												/>
											</div>
										</div>
									))}
							</div>
						</section>
						<section className="panel">
							<div className="panel-heading">
								<h3>Colored mana</h3>
								<span className="muted">Pips / land identities</span>
							</div>
							<div className="mana-analysis">
								{'WUBRG'.split('').map((c) => (
									<div key={c}>
										<span className="mana-symbol">{c}</span>
										<strong className="mono">{data.pips[c]}</strong>
										<small>{data.sources[c]} lands</small>
									</div>
								))}
							</div>
							<p className="panel-note">
								Castable face costs; hybrid pips count in each color. Land identity does not
								guarantee untapped production.
							</p>
						</section>
						<section className="panel">
							<div className="panel-heading">
								<h3>Roles</h3>
								<span className="muted">Text rules v1</span>
							</div>
							<div className="role-breakdown">
								{Object.entries(data.roles as Record<string, number>)
									.sort((a, b) => b[1] - a[1])
									.map(([role, count]) => (
										<div key={role}>
											<span>{role}</span>
											<span className="mono">{count}</span>
										</div>
									))}
								{!Object.keys(data.roles).length && (
									<span className="muted">No matching role rules.</span>
								)}
							</div>
						</section>
					</div>
					<section className="panel legality-panel">
						<div className="panel-heading">
							<h3>Deck validation</h3>
							<select
								className="validation-filter"
								aria-label="Filter validation issues"
								value={issueFilter}
								onChange={(e) => setIssueFilter(e.target.value)}
							>
								<option value="">All issue types</option>
								{[...new Set<string>(data.issues.map((issue: any) => issue.code))].map((code) => (
									<option key={code} value={code}>
										{code}
									</option>
								))}
							</select>
							<span className="badge">
								{data.issues.length ? `${data.issues.length} issues` : 'Checks passed'}
							</span>
						</div>
						{data.issues.length ? (
							<div className="validation-list">
								{data.issues
									.filter((issue: any) => !issueFilter || issue.code === issueFilter)
									.map((issue: any, i: number) => (
										<div key={i}>
											<span className="issue-marker">!</span>
											{issue.cardId && cards.has(issue.cardId) ? (
												<button
													className="validation-card"
													onClick={() => onSelect(cards.get(issue.cardId)!)}
												>
													{issue.message}
												</button>
											) : (
												<span>{issue.message}</span>
											)}
											<code>{issue.code}</code>
										</div>
									))}
							</div>
						) : (
							<p className="validation-ok">
								<Icon name="check" />
								Size, copy limits and card legality pass for {deck.format}.
							</p>
						)}
					</section>
				</>
			)}
			{tab === 'Overview' && !data && !error && (
				<div className="empty">Computing deck analysis…</div>
			)}
			{tab === 'Probabilities' && (
				<>
					<div className="probability-layout">
						<section className="panel">
							<div className="panel-heading">
								<h3>Draw probability</h3>
								<span className="muted">Hypergeometric</span>
							</div>
							<div className="prob-inputs">
								{[
									['population', 'Deck size'],
									['successes', 'Copies in deck'],
									['draws', 'Cards seen'],
									['minimum', 'Minimum hits'],
								].map(([key, label]) => (
									<label className="field" key={key}>
										{label}
										<input
											type="number"
											min="0"
											max="2000"
											value={input[key as keyof typeof input]}
											onChange={(e) =>
												setInput((old) => ({ ...old, [key!]: Number(e.target.value) }))
											}
										/>
									</label>
								))}
							</div>
							<div className="button-group presets">
								<button
									className="button small"
									onClick={() =>
										setInput({ population: data?.total ?? 60, successes: 4, draws: 7, minimum: 1 })
									}
								>
									4-of in opener
								</button>
								<button
									className="button small"
									onClick={() =>
										setInput({
											population: data?.total ?? 60,
											successes: data?.landCount ?? 24,
											draws: Math.min(7, data?.total ?? 60),
											minimum: 2,
										})
									}
								>
									≥2 opening lands
								</button>
								<button
									className="button small"
									onClick={() =>
										setInput((old) => ({ ...old, draws: Math.min(old.population, 10) }))
									}
								>
									10 cards seen
								</button>
							</div>
							{calcError ? (
								<p className="error-text">{calcError}</p>
							) : (
								chance && (
									<div className="prob-result">
										<span>
											Probability of at least {input.minimum} hit{input.minimum !== 1 ? 's' : ''}
										</span>
										<strong className="mono">
											{(chance.atLeast * 100).toFixed(2)}
											<small>%</small>
										</strong>
										<span className="muted">Expected hits: {chance.expected.toFixed(3)}</span>
									</div>
								)
							)}
							<p className="panel-note">
								Uniform sampling without replacement. No mulligan or sequencing assumptions.
							</p>
						</section>
						<section className="panel">
							<div className="panel-heading">
								<h3>Exact distribution</h3>
							</div>
							{chance && !calcError && (
								<div className="distribution">
									{chance.distribution.map((d: any) => (
										<div key={d.hits}>
											<span className="mono">{d.hits} hits</span>
											<div className="bar-track">
												<span style={{ width: `${d.probability * 100}%` }} />
											</div>
											<span className="mono">{(d.probability * 100).toFixed(2)}%</span>
										</div>
									))}
								</div>
							)}
						</section>
					</div>
					{data && (
						<section className="panel land-odds">
							<div className="panel-heading">
								<h3>Hit your land drops</h3>
								<select
									aria-label="Play or draw"
									value={onDraw ? 'draw' : 'play'}
									onChange={(e) => setOnDraw(e.target.value === 'draw')}
								>
									<option value="play">On the play · skip first draw</option>
									<option value="draw">On the draw / multiplayer Commander</option>
								</select>
							</div>
							<p className="panel-note">
								{data.landCount} lands in {data.total} cards. Seven-card opener, no mulligans or
								extra draw effects. Chance to see at least this many lands by the indicated turn.
							</p>
							<table className="odds-table">
								<thead>
									<tr>
										<th>Turn</th>
										<th>Cards seen</th>
										<th>Lands needed</th>
										<th>Probability</th>
									</tr>
								</thead>
								<tbody>
									{landDropOdds(data.total, data.landCount, onDraw).map((row) => (
										<tr key={row.turn}>
											<td>Turn {row.turn}</td>
											<td>{row.draws}</td>
											<td>≥ {row.turn}</td>
											<td>{(row.chance * 100).toFixed(1)}%</td>
										</tr>
									))}
								</tbody>
							</table>
							<p className="panel-note">
								Counts first-face lands. Modal land faces and sequencing are not modeled.
							</p>
						</section>
					)}
				</>
			)}
			{tab === 'Opening hand' && (
				<section className="panel hand-panel">
					<div className="panel-heading">
						<h3>Opening hand</h3>
						<span className="muted">
							London mulligan · {mulligans} mulligan{mulligans !== 1 ? 's' : ''}
						</span>
					</div>
					<div className="hand-controls">
						<button className="button dark" disabled={dealing} onClick={() => deal(0)}>
							<Icon name="refresh" />
							{hand.length ? 'New hand' : 'Draw seven'}
						</button>
						{hand.length > 0 && !kept && (
							<>
								<button
									className="button"
									disabled={dealing || mulligans >= 7}
									onClick={() => deal(mulligans + 1)}
								>
									Mulligan
								</button>
								<button
									className="button"
									disabled={bottom.length !== mulligans}
									onClick={() => {
										setHand((h) => h.filter((_, i) => !bottom.includes(i)));
										setKept(true);
									}}
								>
									Keep {7 - mulligans}
								</button>
							</>
						)}
						<span className="muted">
							{kept
								? 'Hand kept'
								: mulligans
									? `Select ${mulligans} card${mulligans !== 1 ? 's' : ''} to bottom`
									: hand.length
										? 'Seven cards. Keep or mulligan.'
										: ''}
						</span>
					</div>
					{hand.length > 0 && (
						<div className="hand-summary" role="status">
							<span className="badge">{handLands} lands</span>
							<span className="badge">{handSpells.length} spells</span>
							<span className="badge">{handAverage.toFixed(2)} average spell MV</span>
							<span className="badge success">
								{visibleHand.length} cards {kept ? 'kept' : 'selected to keep'}
							</span>
						</div>
					)}
					{hand.length ? (
						<div className="hand-cards">
							{hand.map((c, i) => (
								<div key={`${c.id}:${i}`} className={bottom.includes(i) ? 'bottomed' : ''}>
									<button
										className="image-button"
										onClick={() => {
											if (mulligans && !kept)
												setBottom((b) =>
													b.includes(i)
														? b.filter((x) => x !== i)
														: b.length < mulligans
															? [...b, i]
															: b,
												);
											else onSelect(c);
										}}
									>
										<CardImage card={c} />
									</button>
									<span>{c.name}</span>
									{bottom.includes(i) && <span className="badge">Bottom</span>}
								</div>
							))}
						</div>
					) : (
						<Empty>Draw seven cards from the saved mainboard.</Empty>
					)}
				</section>
			)}
			{tab === 'Suggestions' && (
				<>
					<div className="section-heading">
						<h3>Graph suggestions</h3>
						<span className="muted">Shared keywords, subtypes and roles · frequency weighted</span>
					</div>
					<div className="suggestions">
						{suggestions.map((s) => (
							<article className="panel" key={s.card.id}>
								<button className="suggestion-title" onClick={() => onSelect(s.card)}>
									{s.card.name}
									<Icon name="arrow" size={14} />
								</button>
								<Mana cost={s.card.manaCost} />
								<p className="muted">{s.connections} deck-card connections</p>
								<div className="role-tags">
									{s.evidence.slice(0, 4).map((e: string) => (
										<span className="badge" key={e}>
											{e}
										</span>
									))}
								</div>
								<button className="button small" onClick={() => onAdd(s.card)}>
									<Icon name="plus" size={14} />
									Add to deck
								</button>
							</article>
						))}
					</div>
					{!suggestions.length && (
						<Empty>No additional legal cards share the selected deck features.</Empty>
					)}
				</>
			)}
		</>
	);
}
