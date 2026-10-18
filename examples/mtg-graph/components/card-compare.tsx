'use client';
import type { Card } from '@/src/schema';
import { deriveRoles } from '@/src/catalog';
import { money, usdPrice } from '@/src/workbench';
import { CardImage, Colors, Mana, Modal } from './ui';

export default function CardCompare({
	cards,
	onClose,
	onAdd,
	busy,
}: {
	cards: Card[];
	onClose: () => void;
	onAdd: (card: Card) => void;
	busy: boolean;
}) {
	return (
		<Modal title="Compare cards" onClose={onClose} wide>
			<div
				className="comparison-grid"
				style={{ '--compare-columns': cards.length } as React.CSSProperties}
			>
				{cards.map((card) => (
					<article className="comparison-card" key={card.id}>
						<CardImage card={card} />
						<h3>{card.name}</h3>
						<Mana cost={card.manaCost} />
						<dl>
							<dt>Mana value</dt>
							<dd>{card.manaValue}</dd>
							<dt>Type</dt>
							<dd>{card.type}</dd>
							<dt>Identity</dt>
							<dd>
								<Colors colors={card.colorIdentity} />
							</dd>
							<dt>USD printing</dt>
							<dd>
								{money(usdPrice(card))}
								<small>{card.prices?.asOf ?? 'No price snapshot'}</small>
							</dd>
							<dt>Roles</dt>
							<dd>
								{deriveRoles(card)
									.map((r) => r.name)
									.join(', ') || 'No matching text rules'}
							</dd>
						</dl>
						<div className="oracle-text">
							{card.faces.map((face) => (
								<div key={face.name}>
									<strong>{face.name}</strong>
									<p>{face.text || 'No oracle text.'}</p>
								</div>
							))}
						</div>
						<button className="button dark full" disabled={busy} onClick={() => onAdd(card)}>
							Add to deck
						</button>
					</article>
				))}
			</div>
		</Modal>
	);
}
