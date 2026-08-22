import { Graph, layout as dagreLayout } from '@dagrejs/dagre';
import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from 'd3-force';
import type { Edge, Node } from '@xyflow/react';
import { shortId } from './format';
import { colorForType, KIND_PALETTE } from './graph-style';
import type { FlowLayout, GraphSlice } from './types';

/**
 * Pure adapter: a server {@link GraphSlice} → the `{nodes, edges}` xyflow renders, plus the two
 * layouts that place them. xyflow ships no layout of its own, and unlike Cosmograph it draws real
 * DOM per node — so both the placement and the size ceiling live here, where they can be tested
 * without a canvas.
 */

/**
 * How many nodes the xyflow renderer will draw. Every node is a DOM card and every edge an SVG
 * path, so this is a hard ceiling rather than a soft one: past it the renderer refuses and points
 * back at Cosmograph instead of locking up the tab.
 */
export const FLOW_MAX_NODES = 500;

/** Above this many edges, rel names are dropped — labelled hairball reads as noise. */
export const FLOW_EDGE_LABEL_MAX = 150;

/** Card geometry. Fixed, so dagre's ranks stay even and the organic layout can pack against it. */
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 48;

/** How many force ticks the organic layout runs before it is frozen (sub-10ms at the cap). */
const ORGANIC_TICKS = 300;

/** What each card renders. Index signature: xyflow constrains node data to a record. */
export interface FlowNodeData {
	type: string;
	color: string;
	/** The node's name/title, falling back to its type when its data carries neither. */
	label: string;
	/** Abbreviated id, for when the name is ambiguous and the identity is what matters. */
	labelId: string;
	/** Name and type together. */
	labelBoth: string;
	/** Edges touching this node, within the slice — shown on the card and sizing nothing else. */
	degree: number;
	/** Avatar/thumbnail URL, when the node's data carries one. */
	image?: string;
	[key: string]: unknown;
}

export type GraphFlowNode = Node<FlowNodeData, 'graphNode'>;

/** The `{nodes, edges}` pair `<ReactFlow>` consumes. */
export interface FlowData {
	nodes: GraphFlowNode[];
	edges: Edge[];
}

export interface ToFlowOpts {
	palette?: readonly string[];
}

/** True when a slice is too big for the DOM renderer to draw. */
export function exceedsFlowCap(slice: GraphSlice): boolean {
	return slice.nodes.length > FLOW_MAX_NODES;
}

/**
 * Build the xyflow graph for a slice. Positions are left at the origin — {@link layoutFlow} places
 * them — so switching layouts does not rebuild the cards. Links whose endpoints are missing from
 * the node set are dropped, as they are for Cosmograph.
 */
export function toFlow(slice: GraphSlice, opts: ToFlowOpts = {}): FlowData {
	const palette = opts.palette ?? KIND_PALETTE;
	const present = new Set(slice.nodes.map((n) => n.id));

	const kept = slice.links.filter((l) => present.has(l.source) && present.has(l.target));
	const degree = new Map<string, number>();
	for (const l of kept) {
		degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
		degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
	}

	const nodes: GraphFlowNode[] = slice.nodes.map((n) => {
		const label = n.label ?? n.type;
		return {
			id: n.id,
			type: 'graphNode',
			position: { x: 0, y: 0 },
			data: {
				type: n.type,
				color: colorForType(n.type, palette),
				label,
				labelId: shortId(n.id, 6, 4),
				labelBoth: `${label} · ${n.type}`,
				degree: degree.get(n.id) ?? 0,
				image: n.image,
			},
		};
	});

	const edges: Edge[] = kept.map((l) => ({
		id: l.id,
		source: l.source,
		target: l.target,
		data: { rel: l.rel, weight: l.weight },
	}));

	return { nodes, edges };
}

/**
 * Put the rel name on each edge, or take it off. Separate from {@link toFlow} on purpose: a
 * caption is a property of the edge, not of the graph's structure, so toggling it must not
 * invalidate the layout — recomputing dagre and re-fitting the viewport to turn labels on would
 * throw away where the user was looking.
 *
 * Above {@link FLOW_EDGE_LABEL_MAX} edges the labels are dropped: a dense graph renders them as an
 * unreadable smear over the canvas.
 */
export function withEdgeLabels(edges: Edge[], show: boolean): Edge[] {
	const labelled = show && edges.length <= FLOW_EDGE_LABEL_MAX;
	return edges.map((e) => {
		const rel = labelled ? String((e.data as { rel?: string } | undefined)?.rel ?? '') : undefined;
		return e.label === rel ? e : { ...e, label: rel };
	});
}

/** Place the nodes. Pure: same input, same coordinates — nothing here reads the clock or random. */
export function layoutFlow(data: FlowData, layout: FlowLayout): FlowData {
	const positions = layout === 'layered' ? layered(data) : organic(data);
	return {
		nodes: data.nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } })),
		// Bezier curves read the ranked layout; the force layout is calmer with straight lines.
		edges: data.edges.map((e) => ({ ...e, type: layout === 'layered' ? 'default' : 'straight' })),
	};
}

/** Gap between grid cells, and between the ranked block and the grid of loose nodes below it. */
const GRID_GAP = 28;
const GRID_MARGIN = 80;

/**
 * Dagre ranks, left to right. Cycles are handled by dagre itself (it breaks them internally).
 *
 * Nodes with no edges are pulled out first and gridded underneath: dagre puts every one of them
 * in rank 0, which turns a type-filtered slice (say 89 teams, none linked to each other) into a
 * single column a mile tall and one card wide.
 */
function layered(data: FlowData): Map<string, { x: number; y: number }> {
	const linked = new Set(data.edges.flatMap((e) => [e.source, e.target]));
	const connected = data.nodes.filter((n) => linked.has(n.id));
	const loose = data.nodes.filter((n) => !linked.has(n.id));
	const out = new Map<string, { x: number; y: number }>();

	if (connected.length > 0) {
		// Multigraph: two nodes can be joined by several rels, and a simple graph would collapse them.
		const g = new Graph({ multigraph: true });
		g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 120, edgesep: 12, marginx: 40, marginy: 40 });
		g.setDefaultEdgeLabel(() => ({}));
		for (const n of connected) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
		for (const e of data.edges) g.setEdge(e.source, e.target, {}, e.id);
		dagreLayout(g);

		for (const n of connected) {
			const placed = g.node(n.id) as { x?: number; y?: number } | undefined;
			if (!placed || placed.x === undefined || placed.y === undefined) continue;
			// dagre reports centers; xyflow positions the top-left corner.
			out.set(n.id, { x: placed.x - NODE_WIDTH / 2, y: placed.y - NODE_HEIGHT / 2 });
		}
	}

	if (loose.length > 0) {
		const below = Math.max(0, ...[...out.values()].map((p) => p.y + NODE_HEIGHT));
		const originY = out.size > 0 ? below + GRID_MARGIN : 0;
		const columns = Math.ceil(Math.sqrt(loose.length));
		loose.forEach((n, i) => {
			out.set(n.id, {
				x: (i % columns) * (NODE_WIDTH + GRID_GAP),
				y: originY + Math.floor(i / columns) * (NODE_HEIGHT + GRID_GAP),
			});
		});
	}

	return out;
}

type SimNode = SimulationNodeDatum & { id: string };

/**
 * d3-force, ticked to a fixed budget and frozen — the same treatment Cosmograph's canvas gets,
 * except the result is a static coordinate list rather than a running simulation.
 *
 * Start positions are seeded on a golden-angle spiral rather than left to d3: distinct, spread,
 * and deterministic, which also keeps the forces off their `Math.random` jiggle path (it only
 * fires for exactly-coincident nodes).
 */
function organic(data: FlowData): Map<string, { x: number; y: number }> {
	const spread = 60 * Math.sqrt(Math.max(data.nodes.length, 1));
	const nodes: SimNode[] = data.nodes.map((n, i) => {
		const angle = i * 2.399963229728653; // golden angle, radians
		const radius = spread * Math.sqrt(i + 0.5);
		return { id: n.id, x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
	});
	const links: Array<SimulationLinkDatum<SimNode>> = data.edges.map((e) => ({
		source: e.source,
		target: e.target,
	}));

	const sim = forceSimulation(nodes)
		.force(
			'link',
			forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
				.id((d) => d.id)
				.distance(180)
				.strength(0.35),
		)
		.force('charge', forceManyBody().strength(-800).distanceMax(2500))
		.force('center', forceCenter(0, 0))
		.force('collide', forceCollide(NODE_WIDTH * 0.62))
		// Gravity toward the origin. Without it, a node with no edges has nothing pulling it back
		// against the charge and drifts off alone — which then forces the fit to zoom out on empty
		// space until every card is unreadable.
		.force('gravityX', forceX(0).strength(0.06))
		.force('gravityY', forceY(0).strength(0.06))
		.stop();
	sim.tick(ORGANIC_TICKS);

	const out = new Map<string, { x: number; y: number }>();
	for (const n of nodes) {
		out.set(n.id, { x: (n.x ?? 0) - NODE_WIDTH / 2, y: (n.y ?? 0) - NODE_HEIGHT / 2 });
	}
	return out;
}
