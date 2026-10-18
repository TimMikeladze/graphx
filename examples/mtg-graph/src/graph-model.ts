import type { Card } from './schema';

export interface GraphNode {
	id: string;
	name: string;
	type: string;
	card?: Card;
}
export interface GraphEdge {
	id: string;
	src: string;
	dst: string;
	rel: string;
	data: Record<string, unknown>;
	evidence?: { id: string; name: string; rel: string }[];
}
export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	truncated: boolean;
	moreCards?: boolean;
}
export interface GraphPath extends GraphData {
	path: { id: string; name: string }[];
	hops: number | null;
	explored: number;
}
export const graphRelations = [
	{ id: 'fills_role', label: 'Roles', singular: 'Role', color: '#53826b' },
	{ id: 'has_keyword', label: 'Keywords', singular: 'Keyword', color: '#7b70a6' },
	{ id: 'has_subtype', label: 'Subtypes', singular: 'Subtype', color: '#a17d4b' },
	{ id: 'has_color', label: 'Colors', singular: 'Color', color: '#638fa5' },
	{ id: 'legal_in', label: 'Formats', singular: 'Format', color: '#8a8790' },
	{ id: 'printed_in', label: 'Sets', singular: 'Set', color: '#9a777d' },
];
export const relationLabel = (rel: string) =>
	graphRelations.find((r) => r.id === rel)?.singular ?? rel.replaceAll('_', ' ');
export const relationColor = (rel: string) =>
	graphRelations.find((r) => r.id === rel)?.color ?? '#868e96';
export const defaultGraphFilters = {
	relations: ['fills_role', 'has_keyword', 'has_subtype'],
	query: '',
	color: '',
	type: '',
	format: '',
	maxMana: '',
};
export type GraphFilters = typeof defaultGraphFilters;
export const emptyGraph: GraphData = { nodes: [], edges: [], truncated: false };

export function mergeGraph(a: GraphData, b: GraphData, limit = 240): GraphData {
	const all = new Map([...a.nodes, ...b.nodes].map((n) => [n.id, n]));
	const nodes = [...all.values()].slice(0, limit);
	const ids = new Set(nodes.map((n) => n.id));
	return {
		nodes,
		edges: [
			...new Map(
				[...a.edges, ...b.edges]
					.filter((e) => ids.has(e.src) && ids.has(e.dst))
					.map((e) => [e.id, e]),
			).values(),
		],
		truncated: a.truncated || b.truncated || all.size > limit,
		moreCards: a.moreCards || b.moreCards,
	};
}

export function filterGraph(data: GraphData, root: string, filters: GraphFilters): GraphData {
	const query = filters.query.trim().toLowerCase();
	const cards = new Set(
		data.nodes
			.filter((n) => {
				if (n.id === root) return true;
				if (n.type !== 'card' || !n.card) return false;
				const c = n.card;
				return (
					(!query || `${c.name} ${c.type} ${c.text}`.toLowerCase().includes(query)) &&
					(!filters.color ||
						(filters.color === 'C' ? !c.colors.length : c.colors.includes(filters.color))) &&
					(!filters.type || c.types.includes(filters.type)) &&
					(!filters.format ||
						['Legal', 'Restricted'].includes(c.legalities[filters.format] ?? '')) &&
					(filters.maxMana === '' || c.manaValue <= Number(filters.maxMana))
				);
			})
			.map((n) => n.id),
	);
	const allowed = new Set(filters.relations);
	const edges = data.edges.filter(
		(e) =>
			allowed.has(e.rel) &&
			cards.has(e.src) &&
			(!data.nodes.find((n) => n.id === e.dst)?.card || cards.has(e.dst)),
	);
	return rootComponent({ ...data, edges }, root);
}

function rootComponent(data: GraphData, root: string): GraphData {
	const connected = new Set([root]);
	for (let changed = true; changed; ) {
		changed = false;
		for (const edge of data.edges)
			if (connected.has(edge.src) || connected.has(edge.dst)) {
				if (!connected.has(edge.src) || !connected.has(edge.dst)) changed = true;
				connected.add(edge.src);
				connected.add(edge.dst);
			}
	}
	return {
		...data,
		nodes: data.nodes.filter((n) => connected.has(n.id)),
		edges: data.edges.filter((e) => connected.has(e.src) && connected.has(e.dst)),
	};
}

export function projectCards(data: GraphData, hubs: Set<string>, root: string): GraphData {
	const cards = data.nodes.filter((n) => n.type === 'card');
	const names = new Map(data.nodes.map((n) => [n.id, n.name]));
	const byFeature = new Map<string, GraphEdge[]>();
	for (const edge of data.edges) {
		const key = `${edge.rel}:${edge.dst}`;
		byFeature.set(key, [...(byFeature.get(key) ?? []), edge]);
	}
	const links = new Map<string, GraphEdge>();
	for (const group of byFeature.values())
		for (let a = 0; a < group.length; a++)
			for (let b = a + 1; b < group.length; b++) {
				const left = group[a]!,
					right = group[b]!;
				if (left.src === right.src || (!hubs.has(left.src) && !hubs.has(right.src))) continue;
				const [src, dst] = hubs.has(left.src) ? [left.src, right.src] : [right.src, left.src];
				const id = `shared:${[src, dst].sort().join('|')}`;
				const old = links.get(id);
				const evidence = { id: left.dst, name: names.get(left.dst) ?? left.dst, rel: left.rel };
				if (old) old.evidence!.push(evidence);
				else links.set(id, { id, src, dst, rel: 'shared', data: {}, evidence: [evidence] });
			}
	return rootComponent({ ...data, nodes: cards, edges: [...links.values()] }, root);
}

export function layoutGraph(nodes: GraphNode[], root: string) {
	const positions = new Map<string, { x: number; y: number }>();
	positions.set(root, { x: 0, y: 0 });
	const cards = nodes.filter((n) => n.type === 'card' && n.id !== root);
	// Elliptical rings reserve enough vertical space for full-height card images.
	for (let start = 0, ring = 0; start < cards.length; ring++) {
		const count = Math.min(8 + ring * 4, cards.length - start);
		const radius = 490 + ring * 380;
		cards.slice(start, start + count).forEach((n, i) => {
			const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
			positions.set(n.id, { x: Math.cos(angle) * radius * 1.14, y: Math.sin(angle) * radius });
		});
		start += count;
	}
	const features = nodes.filter((n) => n.type !== 'card');
	features.forEach((n, i) => {
		const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.min(features.length, 8);
		const radius = 250 + Math.floor(i / 8) * 340;
		positions.set(n.id, {
			x: Math.cos(angle) * radius * 1.1 + 10,
			y: Math.sin(angle) * radius + 90,
		});
	});
	return positions;
}
