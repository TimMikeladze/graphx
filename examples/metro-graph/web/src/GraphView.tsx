import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode, Neighbourhood, NodeType } from './api.ts';
import { TYPE_ORDER, typeVar } from './graphLayers.ts';
import { TypeDot } from './GraphPanel.tsx';

type XY = { x: number; y: number };

const radius = (n: GraphNode) => (n.hop === 0 ? 14 : n.group ? 13 : 7);

/**
 * Radial layout: the focus in the middle, hop-1 neighbours on a ring with a gap between each
 * rel group, and each hop-2 node fanned out beyond the hop-1 node it was reached from. Positions
 * depend only on the neighbourhood, so expanding a group or walking back redraws the same picture.
 */
function layout(h: Neighbourhood): Map<string, XY> {
	const pos = new Map<string, XY>();
	const focus = h.focus.id;
	pos.set(focus, { x: 0, y: 0 });
	const groupOf = (n: GraphNode) => {
		const e = h.edges.find(
			(e) => (e.src === focus && e.dst === n.id) || (e.dst === focus && e.src === n.id),
		);
		return e ? `${e.rel}:${e.src === focus ? 'out' : 'in'}` : '~';
	};
	const hop1 = h.nodes
		.filter((n) => n.hop === 1)
		.map((n) => ({ n, g: groupOf(n) }))
		.sort((a, b) => a.g.localeCompare(b.g) || Number(!!a.n.group) - Number(!!b.n.group));
	const slots: Array<GraphNode | null> = [];
	hop1.forEach((x, i) => {
		if (i > 0 && x.g !== hop1[i - 1]!.g) slots.push(null);
		slots.push(x.n);
	});
	if (hop1.length > 1 && new Set(hop1.map((x) => x.g)).size > 1) slots.push(null);
	const step = (2 * Math.PI) / Math.max(slots.length, 1);
	const r1 = Math.max(200, (slots.length * 40) / (2 * Math.PI));
	const angle = new Map<string, number>();
	slots.forEach((n, i) => {
		if (!n) return;
		const a = i * step - Math.PI / 2;
		angle.set(n.id, a);
		pos.set(n.id, { x: Math.cos(a) * r1, y: Math.sin(a) * r1 });
	});

	const hop1Ids = new Set(angle.keys());
	const children = new Map<string, GraphNode[]>();
	const orphans: GraphNode[] = [];
	for (const n of h.nodes.filter((x) => x.hop === 2)) {
		const e = h.edges.find(
			(e) => (e.dst === n.id && hop1Ids.has(e.src)) || (e.src === n.id && hop1Ids.has(e.dst)),
		);
		const parent = e ? (e.src === n.id ? e.dst : e.src) : null;
		if (!parent) orphans.push(n);
		else {
			if (!children.has(parent)) children.set(parent, []);
			children.get(parent)!.push(n);
		}
	}
	const r2 = r1 + 150;
	for (const [parent, kids] of children) {
		const a0 = angle.get(parent)!;
		const span = Math.min(step * 0.92, Math.PI / 1.5);
		kids.forEach((k, i) => {
			const a = kids.length === 1 ? a0 : a0 - span / 2 + (span * i) / (kids.length - 1);
			const r = r2 + (kids.length > 5 ? (i % 2) * 46 : 0);
			pos.set(k.id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
		});
	}
	orphans.forEach((k, i) => {
		const a = (2 * Math.PI * i) / orphans.length;
		pos.set(k.id, { x: Math.cos(a) * (r2 + 100), y: Math.sin(a) * (r2 + 100) });
	});
	return pos;
}

/** The neighbourhood as a node-link graph. Click a node to walk to it, a group to expand it. */
export function GraphView({
	hood,
	loading,
	onFocus,
	onExpand,
}: {
	hood: Neighbourhood | undefined;
	loading: boolean;
	onFocus: (n: GraphNode) => void;
	onExpand: (key: string) => void;
}) {
	const svg = useRef<SVGSVGElement>(null);
	const [hovered, setHover] = useState<string | null>(null);
	const [view, setView] = useState({ k: 1, x: 0, y: 0 });
	const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
	const pos = useMemo(() => (hood ? layout(hood) : new Map<string, XY>()), [hood]);
	const focusId = hood?.focus.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the camera when the focus moves
	useEffect(() => {
		setView({ k: 1, x: 0, y: 0 });
		setHover(null);
	}, [focusId]);

	const box = useMemo(() => {
		let ext = 420;
		for (const p of pos.values()) ext = Math.max(ext, Math.abs(p.x) + 220, Math.abs(p.y) + 200);
		return ext;
	}, [pos]);

	// React's onWheel is passive, so zoom listens natively to be able to stop the page scrolling.
	useEffect(() => {
		const el = svg.current;
		if (!el) return;
		const wheel = (e: WheelEvent) => {
			e.preventDefault();
			const m = el.getScreenCTM()?.inverse();
			if (!m) return;
			const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
			setView((v) => {
				const k = Math.min(Math.max(v.k * Math.exp(-e.deltaY / 400), 0.3), 5);
				return { k, x: pt.x - ((pt.x - v.x) * k) / v.k, y: pt.y - ((pt.y - v.y) * k) / v.k };
			});
		};
		el.addEventListener('wheel', wheel, { passive: false });
		return () => el.removeEventListener('wheel', wheel);
	}, []);

	if (!hood)
		return (
			<div className="graph-surface empty">
				<p className="muted">
					{loading
						? 'Loading…'
						: 'Pick a node in the panel or on the map to draw its neighbourhood.'}
				</p>
			</div>
		);

	const byId = new Map(hood.nodes.map((n) => [n.id, n]));
	// An expanded group disappears under the pointer without a pointerleave.
	const hover = hovered && byId.has(hovered) ? hovered : null;
	const showAllLabels = hood.nodes.length <= 60;
	const touches = (id: string) =>
		hood.edges.some((e) => (e.src === hover && e.dst === id) || (e.dst === hover && e.src === id));
	const present = TYPE_ORDER.map((t) => ({
		t,
		n: hood.nodes.filter((x) => x.type === t).reduce((s, x) => s + (x.group?.count ?? 1), 0),
	})).filter((x) => x.n > 0);

	const scale = () => svg.current?.getScreenCTM()?.a ?? 1;
	return (
		<div className="graph-surface">
			<svg
				ref={svg}
				viewBox={`${-box} ${-box} ${box * 2} ${box * 2}`}
				role="img"
				aria-label={`Neighbourhood of ${hood.focus.type} ${hood.focus.label}: ${hood.nodes.length} nodes and ${hood.edges.length} edges`}
				onPointerDown={(e) => {
					drag.current = { x: e.clientX, y: e.clientY, moved: false };
				}}
				onPointerMove={(e) => {
					const d = drag.current;
					if (!d || e.buttons !== 1) return;
					const dx = e.clientX - d.x;
					const dy = e.clientY - d.y;
					if (!d.moved && Math.hypot(dx, dy) < 4) return;
					d.moved = true;
					d.x = e.clientX;
					d.y = e.clientY;
					const s = scale();
					setView((v) => ({ ...v, x: v.x + dx / s, y: v.y + dy / s }));
				}}
				onPointerUp={() => {
					setTimeout(() => {
						drag.current = null;
					});
				}}
			>
				<defs>
					{(['muted', 'text-primary'] as const).map((c) => (
						<marker
							key={c}
							id={`arrow-${c}`}
							viewBox="0 0 10 10"
							refX="10"
							refY="5"
							markerWidth="6"
							markerHeight="6"
							orient="auto"
						>
							<path d="M0,0 L10,5 L0,10 z" fill={`var(--${c})`} />
						</marker>
					))}
				</defs>
				<g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
					{hood.edges.map((e) => {
						const a = pos.get(e.src);
						const b = pos.get(e.dst);
						const t = byId.get(e.dst);
						if (!a || !b || !t || e.src === e.dst) return null;
						const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
						const s = byId.get(e.src)!;
						const ax = a.x + ((b.x - a.x) / len) * radius(s);
						const ay = a.y + ((b.y - a.y) / len) * radius(s);
						const bx = b.x - ((b.x - a.x) / len) * (radius(t) + 2);
						const by = b.y - ((b.y - a.y) / len) * (radius(t) + 2);
						const lit = hover !== null && (e.src === hover || e.dst === hover);
						return (
							<g key={e.id}>
								<line
									x1={ax}
									y1={ay}
									x2={bx}
									y2={by}
									className={lit ? 'gv-edge lit' : 'gv-edge'}
									markerEnd={`url(#arrow-${lit ? 'text-primary' : 'muted'})`}
								/>
								{lit && (
									<text
										x={(ax + bx) / 2}
										y={(ay + by) / 2 - 4}
										textAnchor="middle"
										className="gv-rel"
									>
										{e.rel}
									</text>
								)}
							</g>
						);
					})}
					{hood.nodes.map((n) => {
						const p = pos.get(n.id);
						if (!p) return null;
						const r = radius(n);
						const dim = hover !== null && hover !== n.id && !touches(n.id);
						const label =
							showAllLabels ||
							n.hop < 2 ||
							n.group ||
							hover === n.id ||
							(hover !== null && touches(n.id));
						return (
							// biome-ignore lint/a11y/useSemanticElements: an SVG group can't be a <button>
							<g
								key={n.id}
								role="button"
								tabIndex={0}
								aria-label={
									n.group
										? `${n.label}, ${n.group.expandable ? 'expand' : 'collapsed'}`
										: `${n.type} ${n.label}`
								}
								className={`gv-node${dim ? ' dim' : ''}${n.group && !n.group.expandable ? ' inert' : ''}`}
								transform={`translate(${p.x} ${p.y})`}
								onPointerEnter={() => setHover(n.id)}
								onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
								onClick={() => {
									if (drag.current?.moved) return;
									if (n.group) {
										if (n.group.expandable) onExpand(n.group.key);
									} else if (n.hop > 0) onFocus(n);
								}}
								onKeyDown={(e) => {
									if (e.key !== 'Enter' && e.key !== ' ') return;
									if (n.group?.expandable) onExpand(n.group.key);
									else if (!n.group && n.hop > 0) onFocus(n);
								}}
							>
								{n.group ? (
									<>
										<circle
											r={r}
											fill={typeVar(n.type)}
											fillOpacity={0.18}
											stroke={typeVar(n.type)}
											strokeWidth={2}
										/>
										<text y={4} textAnchor="middle" className="gv-count">
											{n.group.count > 999 ? `${Math.round(n.group.count / 1000)}k` : n.group.count}
										</text>
									</>
								) : (
									<circle
										r={r}
										fill={typeVar(n.type)}
										stroke={n.hop === 0 ? 'var(--text-primary)' : 'var(--plane)'}
										strokeWidth={n.hop === 0 ? 2.5 : 1.5}
									/>
								)}
								{label && <NodeLabel n={n} p={p} r={r} />}
								<title>
									{n.group ? `${n.label} over ${n.group.rel}` : `${n.type}: ${n.label}`}
								</title>
							</g>
						);
					})}
				</g>
			</svg>
			<GraphLegend present={present} />
		</div>
	);
}

/** Labels point away from the focus, flipped on the left half so they never read upside down. */
function NodeLabel({ n, p, r }: { n: GraphNode; p: XY; r: number }) {
	if (n.hop === 0)
		return (
			<text y={r + 18} textAnchor="middle" className="gv-label focus">
				{n.label}
			</text>
		);
	const deg = (Math.atan2(p.y, p.x) * 180) / Math.PI;
	const left = p.x < -0.5;
	return (
		<text
			x={left ? -(r + 5) : r + 5}
			y={4}
			textAnchor={left ? 'end' : 'start'}
			transform={`rotate(${left ? deg + 180 : deg})`}
			className="gv-label"
		>
			{n.label}
		</text>
	);
}

export function GraphLegend({ present }: { present: Array<{ t: NodeType; n: number }> }) {
	return (
		<div className="graph-legend">
			{present.map(({ t, n }) => (
				<div key={t} className="row nowrap">
					<TypeDot type={t} />
					<span>{t}</span>
					<span className="muted">{n}</span>
				</div>
			))}
			<div className="muted small">Ringed nodes are collapsed groups; click to expand.</div>
		</div>
	);
}
