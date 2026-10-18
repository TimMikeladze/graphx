'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
	ReactFlow,
	Background,
	BackgroundVariant,
	MiniMap,
	Handle,
	Position,
	useNodesState,
	type Node,
	type NodeProps,
	type Edge,
	type ReactFlowInstance,
} from '@xyflow/react';
import {
	layoutGraph,
	relationColor,
	relationLabel,
	type GraphData,
	type GraphNode,
	type GraphEdge,
} from '@/src/graph-model';
import { CardImage, Icon, Mana } from './ui';

type CanvasNode = Node<{ node: GraphNode; root: boolean; images: boolean }, 'mtg'>;
const handles = [Position.Top, Position.Right, Position.Bottom, Position.Left];
const CardNode = memo(function CardNode({ data, selected }: NodeProps<CanvasNode>) {
	const { node, root, images } = data;
	return (
		<div
			className={`${node.card ? 'mtg-card-node' : 'mtg-feature-node'} ${root ? 'is-root' : ''} ${selected ? 'is-selected' : ''} ${!images ? 'is-compact' : ''}`}
		>
			{handles.map((position) => (
				<span key={position}>
					<Handle type="source" id={`s-${position}`} position={position} isConnectable={false} />
					<Handle type="target" id={`t-${position}`} position={position} isConnectable={false} />
				</span>
			))}
			{node.card ? (
				<>
					{root && <span className="mtg-root-tag">ROOT CARD</span>}
					{images && <CardImage card={node.card} />}
					<div className="mtg-node-caption">
						<strong>{node.name}</strong>
						<span>{node.card.type}</span>
						{!images && <Mana cost={node.card.manaCost} />}
					</div>
				</>
			) : (
				<>
					<span className="mtg-feature-kind">{node.type}</span>
					<strong>{node.name}</strong>
				</>
			)}
		</div>
	);
});
const nodeTypes = { mtg: CardNode };

export default function GraphCanvas({
	graph,
	root,
	selectedId,
	selectedEdge,
	onNode,
	onEdge,
	onClear,
	images,
	labels,
	minimap,
	layoutKey,
	loading,
	empty,
	onResetFilters,
}: {
	graph: GraphData;
	root: string;
	selectedId: string | null;
	selectedEdge: GraphEdge | null;
	onNode: (node: GraphNode) => void;
	onEdge: (edge: GraphEdge) => void;
	onClear: () => void;
	images: boolean;
	labels: boolean;
	minimap: boolean;
	layoutKey: string;
	loading: boolean;
	empty: boolean;
	onResetFilters: () => void;
}) {
	const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
	const [flow, setFlow] = useState<ReactFlowInstance<CanvasNode> | null>(null);
	const [zoom, setZoom] = useState(1);
	const positions = useRef(new Map<string, { x: number; y: number }>());
	const previousLayout = useRef(layoutKey);
	const linked = useMemo(() => {
		if (selectedEdge) return new Set([selectedEdge.src, selectedEdge.dst]);
		if (!selectedId) return null;
		return new Set([
			selectedId,
			...graph.edges.flatMap((e) =>
				e.src === selectedId ? [e.dst] : e.dst === selectedId ? [e.src] : [],
			),
		]);
	}, [graph, selectedId, selectedEdge]);
	useEffect(() => {
		if (previousLayout.current !== layoutKey) {
			positions.current.clear();
			previousLayout.current = layoutKey;
		}
		const layout = layoutGraph(graph.nodes, root);
		const sizes = new Map(graph.nodes.map((n) => [n.id, n.type === 'card' && images ? 290 : 90]));
		for (const node of graph.nodes)
			if (!positions.current.has(node.id)) {
				let point = layout.get(node.id) ?? { x: 0, y: 0 };
				let attempts = 0;
				while (
					[...positions.current].some(
						([id, p]) =>
							Math.abs(p.x - point.x) < 190 &&
							Math.abs(p.y - point.y) < Math.max(sizes.get(id) ?? 290, sizes.get(node.id) ?? 290),
					) &&
					attempts++ < 240
				)
					point = { x: point.x + 205, y: point.y + 40 };
				positions.current.set(node.id, point);
			}
		setNodes(
			graph.nodes.map((node) => ({
				id: node.id,
				type: 'mtg',
				position: positions.current.get(node.id)!,
				data: { node, root: node.id === root, images },
				selected: node.id === selectedId,
				ariaLabel: `Select ${node.name}`,
				style: { opacity: linked && !linked.has(node.id) ? 0.25 : 1 },
			})),
		);
	}, [graph, root, layoutKey, images, selectedId, linked, setNodes]);
	useEffect(() => {
		const timer = setTimeout(
			() => flow?.fitView({ padding: 0.15, minZoom: 0.12, maxZoom: 0.9 }),
			100,
		);
		return () => clearTimeout(timer);
	}, [graph, root, layoutKey, images, flow]);
	const edges: Edge[] = useMemo(
		() =>
			graph.edges.map((edge) => {
				const a = positions.current.get(edge.src),
					b = positions.current.get(edge.dst);
				const side = a && b && Math.abs(b.x - a.x) > Math.abs(b.y - a.y) * 0.65;
				const direction = side
					? b!.x > a!.x
						? Position.Right
						: Position.Left
					: b && a && b.y > a.y
						? Position.Bottom
						: Position.Top;
				const opposite = {
					[Position.Right]: Position.Left,
					[Position.Left]: Position.Right,
					[Position.Top]: Position.Bottom,
					[Position.Bottom]: Position.Top,
				};
				const active = selectedEdge
					? selectedEdge.id === edge.id
					: selectedId
						? edge.src === selectedId || edge.dst === selectedId
						: false;
				const label = edge.evidence
					? `${edge.evidence
							.slice(0, 2)
							.map((e) => e.name)
							.join(' · ')}${edge.evidence.length > 2 ? ` +${edge.evidence.length - 2}` : ''}`
					: relationLabel(edge.rel);
				return {
					id: edge.id,
					selected: selectedEdge?.id === edge.id,
					source: edge.src,
					target: edge.dst,
					sourceHandle: `s-${direction}`,
					targetHandle: `t-${opposite[direction]}`,
					type: 'default',
					label: labels ? label : undefined,
					ariaLabel: edge.evidence ? `Shared ${label}` : label,
					style: {
						stroke: active ? '#263f33' : relationColor(edge.evidence?.[0]?.rel ?? edge.rel),
						strokeWidth: active ? 2.6 : 1.5,
						opacity: (selectedId || selectedEdge) && !active ? 0.16 : 0.8,
					},
					labelStyle: { fill: '#555c57', fontSize: 10, fontWeight: 500 },
					labelBgStyle: { fill: '#fff', fillOpacity: 0.96 },
					labelBgPadding: [7, 4] as [number, number],
					labelBgBorderRadius: 4,
					interactionWidth: 22,
					zIndex: active ? 1 : 0,
				};
			}),
		[graph, labels, selectedId, selectedEdge, nodes],
	);
	return (
		<div className="mtg-flow" aria-label="Card relationship canvas" aria-busy={loading}>
			<ReactFlow<CanvasNode>
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				onNodesChange={(changes) => {
					onNodesChange(changes);
					for (const change of changes) {
						if (change.type === 'position' && change.position)
							positions.current.set(change.id, change.position);
						if (change.type === 'select' && change.selected) {
							const node = graph.nodes.find((n) => n.id === change.id);
							if (node) onNode(node);
						}
					}
				}}
				onInit={setFlow}
				onEdgesChange={(changes) => {
					for (const change of changes)
						if (change.type === 'select' && change.selected) {
							const edge = graph.edges.find((edge) => edge.id === change.id);
							if (edge) onEdge(edge);
						}
				}}
				onNodeClick={(_, node) => onNode(node.data.node)}
				onNodeDragStop={(_, node) => positions.current.set(node.id, node.position)}
				onEdgeClick={(_, edge) => {
					const found = graph.edges.find((e) => e.id === edge.id);
					if (found) onEdge(found);
				}}
				onPaneClick={onClear}
				onMove={(_, viewport) => setZoom(viewport.zoom)}
				fitView
				fitViewOptions={{ padding: 0.15, maxZoom: 0.9 }}
				minZoom={0.08}
				maxZoom={2.5}
				nodesConnectable={false}
				edgesReconnectable={false}
				deleteKeyCode={null}
				nodeDragThreshold={5}
				panOnScroll
				zoomOnScroll={false}
				zoomOnPinch
				zoomOnDoubleClick
				selectionOnDrag={false}
			>
				<Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#d6dad6" />
				{minimap && (
					<MiniMap<CanvasNode>
						pannable
						zoomable
						nodeColor={(node) =>
							node.data.root ? '#53826b' : node.data.node.type === 'card' ? '#a8b7ac' : '#d6d9d6'
						}
						maskColor="#f7f9f7ba"
					/>
				)}
			</ReactFlow>
			<div className="mtg-canvas-tools">
				<button aria-label="Zoom out" title="Zoom out" onClick={() => flow?.zoomOut()}>
					−
				</button>
				<button
					className="mtg-zoom-label"
					aria-label="Reset zoom to 100 percent"
					onClick={() => flow?.zoomTo(1)}
				>
					{Math.round(zoom * 100)}%
				</button>
				<button aria-label="Zoom in" title="Zoom in" onClick={() => flow?.zoomIn()}>
					+
				</button>
				<span className="mtg-tool-divider" />
				<button
					aria-label="Fit graph to view"
					title="Fit graph to view"
					onClick={() => flow?.fitView({ padding: 0.15, maxZoom: 0.9 })}
				>
					<Icon name="expand" />
				</button>
			</div>
			<div className="mtg-canvas-hint">
				Drag to pan <span>·</span> Scroll to move <span>·</span> Pinch to zoom
			</div>
			{loading && (
				<div className="mtg-canvas-loading" role="status">
					<span className="mtg-loading-dot" />
					Loading connections…
				</div>
			)}
			{empty && !loading && (
				<div className="mtg-canvas-empty">
					<Icon name="graph" size={24} />
					<strong>No connections match</strong>
					<span>Try fewer filters or explore another card.</span>
					<button className="button" onClick={onResetFilters}>
						Reset filters
					</button>
				</div>
			)}
		</div>
	);
}
