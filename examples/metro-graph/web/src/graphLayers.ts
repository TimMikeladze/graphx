import type { Layer } from '@deck.gl/core';
import { ArcLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type {
	GraphEdge,
	GraphNode,
	Hop,
	Neighbourhood,
	NodeType,
	PatternRow,
	StopRow,
} from './api.ts';

type Theme = 'dark' | 'light';
type RGB = [number, number, number];

/**
 * Node type is a category, so each type takes one of the `--ts-chart-*` slots in fixed order:
 * route 1, pattern 2, stop 3, trip 4, scenario 5. deck.gl can't read CSS variables, so the hex
 * values from styles.css are repeated here.
 */
export const TYPE_ORDER: NodeType[] = ['route', 'pattern', 'stop', 'trip', 'scenario'];
const SLOTS: Record<Theme, RGB[]> = {
	dark: [
		[57, 135, 229],
		[217, 89, 38],
		[25, 158, 112],
		[201, 133, 0],
		[213, 81, 129],
	],
	light: [
		[42, 120, 214],
		[235, 104, 52],
		[27, 175, 122],
		[237, 161, 0],
		[232, 123, 164],
	],
};
export const typeVar = (t: NodeType) => `var(--ts-chart-${TYPE_ORDER.indexOf(t) + 1})`;
export const typeRgb = (t: NodeType, theme: Theme): RGB => SLOTS[theme][TYPE_ORDER.indexOf(t)]!;

const ink = (theme: Theme): RGB => (theme === 'dark' ? [255, 255, 255] : [11, 11, 11]);
const rgba = (c: RGB, a: number): [number, number, number, number] => [...c, a];

export interface GraphLayerInput {
	hood: Neighbourhood | undefined;
	patterns: PatternRow[];
	patternById: Map<string, PatternRow>;
	stopById: Map<string, StopRow>;
	hops: Hop[] | undefined;
	theme: Theme;
}

/**
 * The spatial graph view. The whole network sits underneath in gray for context and stays
 * clickable. Edges run between node positions; `hop` edges fade from their source stop to the
 * next stop, so direction reads without arrowheads.
 */
export function graphLayers({
	hood,
	patterns,
	patternById,
	stopById,
	hops,
	theme,
}: GraphLayerInput): Layer[] {
	const base: RGB = theme === 'dark' ? [120, 120, 114] : [150, 149, 144];
	const out: Layer[] = [
		new PathLayer<PatternRow>({
			id: 'g-base',
			data: patterns,
			getPath: (p) => p.coords,
			getColor: rgba(base, 90),
			getWidth: 1.5,
			widthUnits: 'pixels',
			pickable: true,
			autoHighlight: true,
			highlightColor: rgba(typeRgb('pattern', theme), 200),
		}),
	];
	const hopColor = typeRgb('stop', theme);
	if (hops) {
		const placed = hops.filter((h) => stopById.has(h[0]) && stopById.has(h[1]));
		const at = (id: string) => {
			const s = stopById.get(id)!;
			return [s.lng, s.lat] as [number, number];
		};
		out.push(
			new ArcLayer<Hop>({
				id: 'g-hops',
				data: placed,
				getSourcePosition: (h) => at(h[0]),
				getTargetPosition: (h) => at(h[1]),
				getSourceColor: rgba(hopColor, 20),
				getTargetColor: rgba(hopColor, 220),
				getHeight: 0,
				getWidth: (h) => 1 + Math.min(h[3], 200) / 80,
				widthUnits: 'pixels',
				pickable: true,
				autoHighlight: true,
				highlightColor: rgba(ink(theme), 255),
			}),
		);
	}
	if (!hood) return out;

	const pos = new Map(hood.nodes.filter((n) => n.pos).map((n) => [n.id, n.pos!]));
	const placedEdges = hood.edges.filter((e) => pos.has(e.src) && pos.has(e.dst) && e.src !== e.dst);
	const hopEdges = placedEdges.filter((e) => e.rel === 'hop');
	const otherEdges = placedEdges.filter((e) => e.rel !== 'hop');
	const linePatterns = hood.nodes.filter(
		(n) => n.type === 'pattern' && !n.group && patternById.has(n.id),
	);

	out.push(
		new PathLayer<GraphNode>({
			id: 'g-patterns',
			data: linePatterns,
			getPath: (n) => patternById.get(n.id)!.coords,
			getColor: (n) => rgba(typeRgb('pattern', theme), n.hop === 0 ? 240 : 170),
			getWidth: (n) => (n.hop === 0 ? 5 : 3),
			widthUnits: 'pixels',
			capRounded: true,
			jointRounded: true,
			pickable: true,
			autoHighlight: true,
			highlightColor: rgba(ink(theme), 220),
		}),
		new LineLayer<GraphEdge>({
			id: 'g-edges',
			data: otherEdges,
			getSourcePosition: (e) => pos.get(e.src)!,
			getTargetPosition: (e) => pos.get(e.dst)!,
			getColor: rgba(ink(theme), 70),
			getWidth: 1,
			widthUnits: 'pixels',
		}),
		new ArcLayer<GraphEdge>({
			id: 'g-hop-edges',
			data: hopEdges,
			getSourcePosition: (e) => pos.get(e.src)!,
			getTargetPosition: (e) => pos.get(e.dst)!,
			getSourceColor: rgba(hopColor, 40),
			getTargetColor: rgba(hopColor, 255),
			getHeight: 0,
			getWidth: 3,
			widthUnits: 'pixels',
			pickable: true,
		}),
		new ScatterplotLayer<GraphNode>({
			id: 'g-nodes',
			data: hood.nodes.filter((n) => n.pos).sort((a, b) => b.hop - a.hop),
			getPosition: (n) => n.pos!,
			getRadius: (n) => (n.hop === 0 ? 9 : n.group ? 8 : n.type === 'stop' ? 4.5 : 5.5),
			radiusUnits: 'pixels',
			getFillColor: (n) => rgba(typeRgb(n.type, theme), n.group ? 90 : 240),
			stroked: true,
			getLineColor: (n) =>
				n.group ? rgba(typeRgb(n.type, theme), 255) : rgba(ink(theme), n.hop === 0 ? 255 : 120),
			getLineWidth: (n) => (n.group || n.hop === 0 ? 2 : 1),
			lineWidthUnits: 'pixels',
			pickable: true,
			autoHighlight: true,
			highlightColor: rgba(ink(theme), 200),
		}),
		new TextLayer<GraphNode>({
			id: 'g-labels',
			data: hood.nodes.filter((n) => n.pos && (n.hop === 0 || (n.group && n.hop === 1))),
			getPosition: (n) => n.pos!,
			getText: (n) => n.label,
			getSize: (n) => (n.hop === 0 ? 14 : 12),
			getColor: rgba(ink(theme), 235),
			getPixelOffset: [12, 0],
			getTextAnchor: 'start',
			getAlignmentBaseline: 'center',
			fontFamily: 'system-ui, -apple-system, sans-serif',
			outlineWidth: 3,
			outlineColor: theme === 'dark' ? [13, 13, 13, 220] : [249, 249, 247, 220],
			fontSettings: { sdf: true },
			characterSet: 'auto',
		}),
	);
	return out;
}

/** [[minLng, minLat], [maxLng, maxLat]] around the placed nodes, or null when none are placed. */
export function boundsOf(nodes: GraphNode[], patternById: Map<string, PatternRow>) {
	const pts: [number, number][] = [];
	for (const n of nodes) {
		if (n.type === 'pattern' && !n.group && patternById.has(n.id))
			pts.push(...patternById.get(n.id)!.coords);
		else if (n.pos) pts.push(n.pos);
	}
	if (!pts.length) return null;
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return [
		[Math.min(...xs), Math.min(...ys)],
		[Math.max(...xs), Math.max(...ys)],
	] as [[number, number], [number, number]];
}
