'use client';
import {
	relationLabel,
	type GraphData,
	type GraphNode,
	type GraphEdge,
	type GraphPath,
} from '@/src/graph-model';
import type { Card } from '@/src/schema';
import { CardImage, Icon, Mana } from './ui';

export default function GraphInspector({
	graph,
	node,
	edge,
	path,
	root,
	expanded,
	busy,
	onNode,
	onRoot,
	onExpand,
	onDetails,
	onClose,
	onClearPath,
}: {
	graph: GraphData;
	node: GraphNode | undefined;
	edge: GraphEdge | null;
	path: GraphPath | null;
	root: string;
	expanded: Set<string>;
	busy: boolean;
	onNode: (node: GraphNode) => void;
	onRoot: (card: Card) => void;
	onExpand: (node: GraphNode) => void;
	onDetails: (card: Card) => void;
	onClose: () => void;
	onClearPath: () => void;
}) {
	const connections = node ? graph.edges.filter((e) => e.src === node.id || e.dst === node.id) : [];
	const otherNode = (e: GraphEdge) =>
		graph.nodes.find((n) => n.id === (e.src === node?.id ? e.dst : e.src));
	return (
		<aside className="mtg-inspector" aria-label="Graph inspector">
			<header>
				<span className="eyebrow">{edge ? 'CONNECTION' : 'INSPECTOR'}</span>
				<button className="icon-btn" aria-label="Hide inspector" onClick={onClose}>
					<Icon name="close" size={14} />
				</button>
			</header>
			{path && (
				<section className="mtg-path-result" aria-live="polite">
					<div className="mtg-inspector-section-title">
						<strong>{path.path.length ? `${path.hops} hops` : 'No path found'}</strong>
						<button className="text-btn" onClick={onClearPath}>
							Clear path
						</button>
					</div>
					{path.path.length ? (
						<ol>
							{path.path.map((n) => (
								<li key={n.id}>
									<button
										onClick={() => {
											const found = path.nodes.find((node) => node.id === n.id);
											if (found) onNode(found);
										}}
									>
										{n.name}
									</button>
								</li>
							))}
						</ol>
					) : (
						<p>
							{path.truncated
								? 'Traversal reached the 10,000-node limit.'
								: 'These cards are not connected within six hops.'}
						</p>
					)}
					<small>{path.explored.toLocaleString()} nodes explored · roles, keywords, subtypes</small>
				</section>
			)}
			{edge ? (
				<>
					<h2>{edge.evidence ? 'Shared features' : relationLabel(edge.rel)}</h2>
					<div className="mtg-edge-endpoints">
						{[edge.src, edge.dst].map((id) => {
							const target = graph.nodes.find((n) => n.id === id);
							return target ? (
								<button key={id} onClick={() => onNode(target)}>
									<Icon name={target.card ? 'deck' : 'graph'} size={14} />
									{target.name}
									<Icon name="arrow" size={13} />
								</button>
							) : null;
						})}
					</div>
					<p className="mtg-inspector-note">
						{edge.evidence
							? 'Cards connected through shared graph features. Shared features do not establish a combo.'
							: 'A persisted relationship from the imported catalog.'}
					</p>
					{edge.evidence?.map((e) => (
						<div className="mtg-evidence" key={`${e.rel}:${e.id}`}>
							<span>{relationLabel(e.rel)}</span>
							<strong>{e.name}</strong>
						</div>
					))}
					{typeof edge.data.evidence === 'string' && (
						<blockquote className="mtg-rule-evidence">{edge.data.evidence}</blockquote>
					)}
				</>
			) : node ? (
				<>
					{node.card && (
						<div className="mtg-inspector-preview">
							<CardImage card={node.card} />
						</div>
					)}
					<div className="mtg-inspector-heading">
						<span className="mtg-type-tag">{node.id === root ? 'Root card' : node.type}</span>
						<h2>{node.name}</h2>
						{node.card && (
							<>
								<Mana cost={node.card.manaCost} />
								<p>{node.card.type}</p>
							</>
						)}
					</div>
					{node.card && (
						<>
							<div className="mtg-inspector-actions">
								<button className="button dark" onClick={() => onDetails(node.card!)}>
									Card details
									<Icon name="arrow" size={14} />
								</button>
								<button
									className="button"
									disabled={busy || expanded.has(node.id)}
									onClick={() => onExpand(node)}
								>
									<Icon name="plus" size={14} />
									{expanded.has(node.id) ? 'Expanded' : 'Expand connections'}
								</button>
								{node.id !== root && (
									<button className="text-btn" onClick={() => onRoot(node.card!)}>
										Make root card
										<Icon name="arrow" size={13} />
									</button>
								)}
							</div>
							<p className="mtg-inspector-oracle">{node.card.text}</p>
						</>
					)}
					<div className="mtg-inspector-section-title">
						<span className="eyebrow">CONNECTIONS</span>
						<span className="mono">{connections.length}</span>
					</div>
					<div className="mtg-connection-list">
						{connections.map((e) => {
							const other = otherNode(e);
							return other ? (
								<button key={e.id} onClick={() => onNode(other)}>
									<span>
										<strong>{other.name}</strong>
										<small>
											{e.evidence
												? e.evidence.map((item) => item.name).join(' · ')
												: relationLabel(e.rel)}
										</small>
									</span>
									<Icon name="chevron" size={12} />
								</button>
							) : null;
						})}
					</div>
					{!connections.length && (
						<p className="mtg-inspector-note">
							No visible connections. Adjust the graph filters to see more.
						</p>
					)}
				</>
			) : (
				<p className="mtg-inspector-note">
					Select a card or connection to inspect its graph evidence.
				</p>
			)}
		</aside>
	);
}
