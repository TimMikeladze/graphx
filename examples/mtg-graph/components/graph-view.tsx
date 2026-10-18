'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '@/src/schema';
import { formats } from '@/src/schema';
import { colorNames } from '@/src/workbench';
import {
	defaultGraphFilters,
	emptyGraph,
	filterGraph,
	graphRelations,
	mergeGraph,
	projectCards,
	type GraphData,
	type GraphNode,
	type GraphEdge,
	type GraphPath,
} from '@/src/graph-model';
import { api, Icon } from './ui';
import GraphCanvas from './graph-canvas';
import GraphInspector from './graph-inspector';

export default function GraphView({
	card,
	onCard,
	onSelect,
}: {
	card: Card | null;
	onCard: (card: Card) => void;
	onSelect: (card: Card) => void;
}) {
	const [graph, setGraph] = useState<GraphData>(emptyGraph);
	const [filters, setFilters] = useState(defaultGraphFilters);
	const [query, setQuery] = useState('');
	const [matches, setMatches] = useState<Card[]>([]);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState('');
	const [searched, setSearched] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [edge, setEdge] = useState<GraphEdge | null>(null);
	const [loading, setLoading] = useState(true);
	const [working, setWorking] = useState(false);
	const [pathLoading, setPathLoading] = useState(false);
	const [error, setError] = useState('');
	const [retry, setRetry] = useState(0);
	const [limit, setLimit] = useState(8);
	const [mode, setMode] = useState<'cards' | 'features'>('cards');
	const [images, setImages] = useState(true);
	const [labels, setLabels] = useState(true);
	const [minimap, setMinimap] = useState(true);
	const [inspector, setInspector] = useState(true);
	const [moreFilters, setMoreFilters] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [pathMode, setPathMode] = useState(false);
	const [path, setPath] = useState<GraphPath | null>(null);
	const [layoutVersion, setLayoutVersion] = useState(0);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const generation = useRef(0);
	const pathRequest = useRef<AbortController | null>(null);
	const clearPath = useCallback(() => {
		pathRequest.current?.abort();
		pathRequest.current = null;
		setPath(null);
		setPathLoading(false);
	}, []);
	useEffect(() => () => pathRequest.current?.abort(), []);
	const rootId = card?.id ?? '';
	const relationsKey = filters.relations.join(',');
	useEffect(() => {
		if (card) return;
		let active = true;
		api<{ cards: Card[] }>('/cards?q=name:psychic%20frog&limit=1')
			.then((result) => {
				if (!active) return;
				if (result.cards[0]) onCard(result.cards[0]);
				else {
					setLoading(false);
					setError('Search for a card to start exploring.');
				}
			})
			.catch((e) => {
				if (active) {
					setError(e.message);
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [card, onCard, retry]);
	useEffect(() => {
		if (!rootId) return;
		const controller = new AbortController();
		generation.current++;
		setLoading(true);
		setWorking(false);
		setError('');
		clearPath();
		setSelected(null);
		setEdge(null);
		setExpanded(new Set([rootId]));
		setGraph({
			nodes: [{ id: rootId, name: card!.name, type: 'card', card: card! }],
			edges: [],
			truncated: false,
		});
		if (!relationsKey) {
			setLoading(false);
			return;
		}
		api<GraphData>(`/graph/${encodeURIComponent(rootId)}?rel=${relationsKey}&limit=${limit}`, {
			signal: controller.signal,
		})
			.then((result) => {
				if (!controller.signal.aborted) setGraph(result);
			})
			.catch((e) => {
				if (!controller.signal.aborted) setError(e.message);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => {
			controller.abort();
			generation.current++;
		};
	}, [rootId, relationsKey, limit, retry, clearPath]);
	useEffect(() => {
		setMatches([]);
		setSearched(false);
		setSearchError('');
		if (!query.trim()) {
			setSearching(false);
			return;
		}
		const controller = new AbortController();
		setSearching(true);
		const timer = setTimeout(
			() =>
				api<{ cards: Card[] }>(`/cards?q=${encodeURIComponent(query)}&limit=7&sort=rank`, {
					signal: controller.signal,
				})
					.then((result) => {
						if (controller.signal.aborted) return;
						setMatches(result.cards);
						setSearched(true);
					})
					.catch((e) => {
						if (!controller.signal.aborted) setSearchError(e.message);
					})
					.finally(() => {
						if (!controller.signal.aborted) setSearching(false);
					}),
			220,
		);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [query]);
	useEffect(() => {
		const close = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setQuery('');
				setFullscreen(false);
			}
		};
		window.addEventListener('keydown', close);
		return () => window.removeEventListener('keydown', close);
	}, []);
	const filtered = useMemo(() => filterGraph(graph, rootId, filters), [graph, rootId, filters]);
	const visible = useMemo(
		() =>
			path?.path.length
				? path
				: mode === 'cards'
					? projectCards(filtered, expanded, rootId)
					: filtered,
		[filtered, mode, expanded, path, rootId],
	);
	const selectedNode = visible.nodes.find((n) => n.id === (selected ?? rootId));
	const cardsCount = visible.nodes.filter((n) => n.type === 'card').length;
	const loadedCards = graph.nodes.filter((n) => n.type === 'card').length;
	const activeFilters = [
		filters.query,
		filters.color,
		filters.type,
		filters.format,
		filters.maxMana,
	].filter(Boolean).length;
	const selectNode = (node: GraphNode) => {
		setSelected(node.id);
		setEdge(null);
		setInspector(true);
	};
	const makeRoot = (next: Card) => {
		setQuery('');
		clearPath();
		setPathMode(false);
		if (next.id === rootId) setRetry((previous) => previous + 1);
		onCard(next);
	};
	const choose = async (next: Card) => {
		setQuery('');
		if (!pathMode || !card) {
			makeRoot(next);
			return;
		}
		clearPath();
		const controller = new AbortController();
		pathRequest.current = controller;
		const current = generation.current;
		setPathLoading(true);
		setError('');
		try {
			const result = await api<GraphPath>(
				`/path?from=${encodeURIComponent(rootId)}&to=${encodeURIComponent(next.id)}`,
				{ signal: controller.signal },
			);
			if (
				controller.signal.aborted ||
				pathRequest.current !== controller ||
				current !== generation.current
			)
				return;
			setPath(result);
			setInspector(true);
			setEdge(null);
			setSelected(null);
		} catch (e) {
			if (!controller.signal.aborted && current === generation.current)
				setError((e as Error).message);
		} finally {
			if (pathRequest.current === controller) {
				pathRequest.current = null;
				setPathLoading(false);
			}
		}
	};

	const expand = async (node: GraphNode) => {
		if (working || pathLoading || loading || expanded.has(node.id) || graph.nodes.length >= 240)
			return;
		if (path?.path.length) {
			setGraph((previous) => mergeGraph(previous, path));
			setMode('features');
		}
		clearPath();
		const current = generation.current;
		setWorking(true);
		setError('');
		try {
			const next = await api<GraphData>(
				`/graph/${encodeURIComponent(node.id)}?rel=${relationsKey}&limit=${limit}`,
			);
			if (current !== generation.current) return;
			setGraph((previous) => mergeGraph(previous, next));
			setExpanded((previous) => new Set([...previous, node.id]));
		} catch (e) {
			if (current === generation.current) setError((e as Error).message);
		} finally {
			if (current === generation.current) setWorking(false);
		}
	};
	const resetFilters = () => {
		setFilters(defaultGraphFilters);
		clearPath();
		setEdge(null);
		setSelected(null);
	};
	const toggleRelation = (id: string) => {
		clearPath();
		setFilters((previous) => ({
			...previous,
			relations: previous.relations.includes(id)
				? previous.relations.filter((rel) => rel !== id)
				: [...previous.relations, id],
		}));
	};
	return (
		<div className={`mtg-graph-workspace ${fullscreen ? 'is-fullscreen' : ''}`}>
			<div className="page-heading mtg-graph-heading">
				<div>
					<div className="eyebrow">WORKSPACE / RELATIONSHIPS</div>
					<h1>Graph explorer</h1>
					<p className="page-description">Follow the connections between cards.</p>
				</div>
				<span className="mtg-graph-badge">
					<span className="status-dot ready" />
					GraphX
				</span>
			</div>
			<div className="mtg-graph-workbench">
				<div className="mtg-graph-toolbar">
					<div className="mtg-root-search">
						<div className="search-box">
							<Icon name="search" />
							<input
								aria-label={pathMode ? 'Find path to card' : 'Find graph card'}
								placeholder={pathMode ? 'Find a destination card…' : 'Search for a root card…'}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && matches[0]) {
										e.preventDefault();
										choose(matches[0]);
									}
								}}
							/>
							<kbd>↵</kbd>
						</div>
						{query.trim() && (
							<div className="mtg-root-results">
								{searching ? (
									<p role="status">Searching cards…</p>
								) : searchError ? (
									<p role="alert">{searchError}</p>
								) : matches.length ? (
									matches.map((match) => (
										<button key={match.id} onClick={() => choose(match)}>
											<span>
												<strong>{match.name}</strong>
												<small>
													{match.type} · MV {match.manaValue}
												</small>
											</span>
											<Icon name="arrow" size={14} />
										</button>
									))
								) : searched ? (
									<p>No cards found. Try a name or a search query.</p>
								) : null}
							</div>
						)}
					</div>
					<div className="mtg-mode-switch" aria-label="Graph display">
						<button
							aria-pressed={mode === 'cards'}
							onClick={() => {
								setMode('cards');
								clearPath();
								setEdge(null);
							}}
						>
							<Icon name="deck" size={14} />
							Cards
						</button>
						<button
							aria-pressed={mode === 'features'}
							onClick={() => {
								setMode('features');
								clearPath();
								setEdge(null);
							}}
						>
							<Icon name="graph" size={14} />
							Features
						</button>
					</div>
					<button
						className={`button mtg-path-toggle ${pathMode ? 'dark' : ''}`}
						aria-pressed={pathMode}
						onClick={() => {
							setPathMode(!pathMode);
							clearPath();
						}}
					>
						<Icon name="graph" size={14} />
						Find path
					</button>
					<div className="mtg-toolbar-end">
						<button
							className="icon-btn"
							title="Toggle inspector"
							aria-label="Toggle graph inspector"
							aria-pressed={inspector}
							onClick={() => setInspector(!inspector)}
						>
							<Icon name="panel" />
						</button>
						<button
							className="icon-btn"
							title={fullscreen ? 'Exit expanded workspace' : 'Expand workspace'}
							aria-label={fullscreen ? 'Exit expanded workspace' : 'Expand workspace'}
							onClick={() => setFullscreen(!fullscreen)}
						>
							<Icon name={fullscreen ? 'collapse' : 'expand'} />
						</button>
					</div>
				</div>
				<div className="mtg-graph-filters">
					<span className="mtg-filter-label">
						<Icon name="filter" size={13} />
						Relationships
					</span>
					<div className="mtg-relation-filters">
						{graphRelations.map((rel) => (
							<button
								key={rel.id}
								aria-pressed={filters.relations.includes(rel.id)}
								onClick={() => toggleRelation(rel.id)}
							>
								<i style={{ background: rel.color }} />
								{rel.label}
							</button>
						))}
					</div>
					<button
						className="mtg-more-filters"
						aria-expanded={moreFilters}
						onClick={() => setMoreFilters(!moreFilters)}
					>
						<Icon name="filter" size={13} />
						Filters{activeFilters > 0 && <span>{activeFilters}</span>}
					</button>
				</div>
				{moreFilters && (
					<div className="mtg-filter-panel">
						<label className="mtg-text-filter">
							Filter loaded cards
							<input
								aria-label="Filter graph cards"
								placeholder="Name, type, or rules text"
								value={filters.query}
								onChange={(e) => setFilters({ ...filters, query: e.target.value })}
							/>
						</label>
						<label>
							Color
							<select
								aria-label="Graph card color"
								value={filters.color}
								onChange={(e) => setFilters({ ...filters, color: e.target.value })}
							>
								<option value="">All colors</option>
								{Object.entries(colorNames).map(([id, name]) => (
									<option key={id} value={id}>
										{name}
									</option>
								))}
							</select>
						</label>
						<label>
							Type
							<select
								aria-label="Graph card type"
								value={filters.type}
								onChange={(e) => setFilters({ ...filters, type: e.target.value })}
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
								].map((type) => (
									<option key={type}>{type}</option>
								))}
							</select>
						</label>
						<label>
							Format
							<select
								aria-label="Graph card format"
								value={filters.format}
								onChange={(e) => setFilters({ ...filters, format: e.target.value })}
							>
								<option value="">All formats</option>
								{formats.map((format) => (
									<option key={format} value={format}>
										{format}
									</option>
								))}
							</select>
						</label>
						<label>
							Max. mana value
							<input
								aria-label="Graph maximum mana value"
								type="number"
								min={0}
								max={30}
								value={filters.maxMana}
								placeholder="Any"
								onChange={(e) => setFilters({ ...filters, maxMana: e.target.value })}
							/>
						</label>
						<button className="text-btn" onClick={resetFilters}>
							Reset filters
						</button>
						<small>Filters apply to loaded cards. The root stays visible.</small>
					</div>
				)}
				{pathMode && (
					<div className="mtg-path-notice">
						<Icon name="graph" size={14} />
						<span>
							Find a path from <strong>{card?.name}</strong>. Search above to choose the
							destination.
						</span>
						<button
							className="icon-btn"
							aria-label="Exit path finding"
							onClick={() => {
								setPathMode(false);
								clearPath();
							}}
						>
							<Icon name="close" size={13} />
						</button>
					</div>
				)}
				{error && (
					<div className="mtg-graph-error" role="alert">
						<span>{error}</span>
						<button className="button" onClick={() => setRetry(retry + 1)}>
							Retry
						</button>
					</div>
				)}
				<div className={`mtg-graph-body ${inspector ? 'has-inspector' : ''}`}>
					<div className="mtg-canvas-column">
						<div className="mtg-canvas-title">
							<div>
								<span className="mtg-root-indicator" />
								<strong>{card?.name ?? 'Choose a card'}</strong>
								<span className="mtg-canvas-title-label">
									{path?.path.length
										? 'Shortest path'
										: mode === 'cards'
											? 'Shared connections'
											: 'Feature neighborhood'}
								</span>
							</div>
							<span className="mono" aria-live="polite">
								{cardsCount} cards · {visible.edges.length} edges
							</span>
						</div>
						<GraphCanvas
							graph={visible}
							root={rootId}
							selectedId={selected}
							selectedEdge={edge}
							onNode={selectNode}
							onEdge={(next) => {
								setEdge(next);
								setSelected(null);
								setInspector(true);
							}}
							onClear={() => {
								setSelected(null);
								setEdge(null);
							}}
							images={images}
							labels={labels}
							minimap={minimap}
							layoutKey={`${rootId}:${mode}:${layoutVersion}`}
							loading={loading || working || pathLoading}
							empty={visible.nodes.length <= 1 && Boolean(card) && !path?.path.length}
							onResetFilters={resetFilters}
						/>
					</div>
					{inspector && (
						<GraphInspector
							graph={visible}
							node={selectedNode}
							edge={edge}
							path={path}
							root={rootId}
							expanded={expanded}
							busy={loading || working || pathLoading || graph.nodes.length >= 240}
							onNode={selectNode}
							onRoot={makeRoot}
							onExpand={expand}
							onDetails={onSelect}
							onClose={() => setInspector(false)}
							onClearPath={() => {
								clearPath();
								setSelected(null);
								setEdge(null);
							}}
						/>
					)}
				</div>
				<div className="mtg-graph-footer">
					<div className="mtg-display-options">
						<label>
							<input
								type="checkbox"
								checked={images}
								onChange={(e) => setImages(e.target.checked)}
							/>
							Card images
						</label>
						<label>
							<input
								type="checkbox"
								checked={labels}
								onChange={(e) => setLabels(e.target.checked)}
							/>
							Edge labels
						</label>
						<label>
							<input
								type="checkbox"
								checked={minimap}
								onChange={(e) => setMinimap(e.target.checked)}
							/>
							Minimap
						</label>
					</div>
					<div className="mtg-footer-actions">
						<label>
							Neighbors
							<select
								aria-label="Related card limit"
								value={limit}
								onChange={(e) => setLimit(Number(e.target.value))}
							>
								{[8, 16, 24, 40].map((value) => (
									<option key={value} value={value}>
										{value}
									</option>
								))}
							</select>
						</label>
						<button
							title="Reset node positions"
							onClick={() => setLayoutVersion(layoutVersion + 1)}
						>
							<Icon name="undo" size={13} />
							Re-layout
						</button>
					</div>
				</div>
			</div>
			<div className="mtg-graph-caption">
				<span>
					{path?.path.length
						? 'Path view shows persisted relationships; card filters are paused.'
						: `${cardsCount} of ${loadedCards} loaded cards${mode === 'cards' ? ' · Edges show shared features' : ' · Edges show persisted relationships'}`}
				</span>
				<span>
					{graph.nodes.length >= 240
						? 'Canvas limit reached: 240 nodes. Choose a new root to continue.'
						: graph.truncated
							? 'Feature neighborhood capped. Narrow the relationships.'
							: graph.moreCards
								? `Showing up to ${limit} neighbors per expansion. Increase Neighbors to load more.`
								: 'Select a card to inspect or expand'}
				</span>
			</div>
		</div>
	);
}
