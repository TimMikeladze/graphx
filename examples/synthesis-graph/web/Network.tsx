import type { Meta, Plan, Route, State } from './api.ts';
import { POS } from './layout.ts';

interface Props {
	meta: Meta;
	state: State;
	colors: Record<Route, string>;
	selected: string | null;
	onSelect: (reactionId: string) => void;
}

const radiusOf = (id: string, price: number | null) =>
	id === 'ibuprofen' ? 22 : id === 'ibb' ? 15 : price !== null ? 7 : 12;

/** Every molecule and reaction that ever exists; the ones not known at this date are ghosted. */
export function Network({ meta, state, colors, selected, onSelect }: Props) {
	const known = new Map(state.graph.reactions.map((r) => [r.id, r]));
	const mols = new Map(state.graph.molecules.map((m) => [m.id, m]));
	const plan: Plan | null = state.plan;
	const onRoute = new Set(plan?.steps.map((s) => s.id) ?? []);
	const liveEdge = (src: string, dst: string, rel: string) => {
		const r = known.get(rel === 'reactant' ? dst : src);
		if (!r) return false;
		return rel === 'reactant'
			? r.reactants.some((x) => x.id === src)
			: r.products.some((x) => x.id === dst);
	};
	const bought = new Set(plan?.buy.map((b) => b.id) ?? []);
	const reactionIds = new Set(meta.reactions.map((r) => r.id));
	const radius = (id: string) =>
		reactionIds.has(id) ? 16 : radiusOf(id, meta.molecules.find((m) => m.id === id)?.price ?? null);

	return (
		<svg
			viewBox="0 0 1110 590"
			className="network"
			role="img"
			aria-label={`Synthesis graph as of ${state.year}`}
		>
			<defs>
				<marker
					id="arrow"
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="5"
					markerHeight="5"
					orient="auto-start-reverse"
				>
					<path d="M0,0 L10,5 L0,10 z" fill="var(--edge)" />
				</marker>
				<marker
					id="arrow-hot"
					viewBox="0 0 10 10"
					refX="9"
					refY="5"
					markerWidth="5"
					markerHeight="5"
					orient="auto-start-reverse"
				>
					<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
				</marker>
			</defs>
			{meta.edges.map((e) => {
				const a = POS[e.src];
				const b = POS[e.dst];
				if (!a || !b) return null;
				const live = liveEdge(e.src, e.dst, e.rel);
				const rxn = e.rel === 'reactant' ? e.dst : e.src;
				const hot = live && onRoute.has(rxn);
				const dx = b[0] - a[0];
				const dy = b[1] - a[1];
				const len = Math.hypot(dx, dy) || 1;
				const cx = (a[0] + b[0]) / 2 + (-dy / len) * 10;
				const cy = (a[1] + b[1]) / 2 + (dx / len) * 10;
				const trim = (x: number, y: number, r: number) => {
					const ux = cx - x;
					const uy = cy - y;
					const ul = Math.hypot(ux, uy) || 1;
					return [x + (ux / ul) * (r + 3), y + (uy / ul) * (r + 3)] as const;
				};
				const [sx, sy] = trim(a[0], a[1], radius(e.src));
				const [tx, ty] = trim(b[0], b[1], radius(e.dst) + 2);
				return (
					<path
						key={`${e.rel}:${e.src}:${e.dst}`}
						d={`M${sx},${sy} Q${cx},${cy} ${tx},${ty}`}
						className={hot ? 'edge hot' : live ? 'edge' : 'edge ghost'}
						markerEnd={live ? (hot ? 'url(#arrow-hot)' : 'url(#arrow)') : undefined}
					/>
				);
			})}
			{meta.reactions.map((r) => {
				const [x, y] = POS[r.id]!;
				const k = known.get(r.id);
				const severe =
					k &&
					[...k.reactants.map((x) => x.id), ...k.catalysts].some(
						(id) => mols.get(id)?.severity === 'severe',
					);
				const cls = [
					'rxn',
					k ? '' : 'ghost',
					onRoute.has(r.id) ? 'hot' : '',
					selected === r.id ? 'selected' : '',
				].join(' ');
				return (
					<g
						key={r.id}
						transform={`translate(${x},${y})`}
						className={cls}
						onClick={() => onSelect(r.id)}
						role="button"
						tabIndex={0}
						aria-label={`${r.id} ${r.name}`}
						onKeyDown={(e) => e.key === 'Enter' && onSelect(r.id)}
					>
						<title>
							{k
								? `${r.name} · ${Math.round(k.yield * 100)}% · ${k.conditions}`
								: `${r.name} — not known in ${state.year}`}
						</title>
						<rect
							x={-20}
							y={-13}
							width={40}
							height={26}
							rx={6}
							style={{ stroke: colors[r.route] }}
						/>
						<text className="rxn-key" dy="0.35em">
							{r.id}
						</text>
						{k && (
							<text className="rxn-yield" y={27}>
								{Math.round(k.yield * 100)}%{severe ? ' ⚠' : ''}
							</text>
						)}
					</g>
				);
			})}
			{meta.molecules.map((m) => {
				const p = POS[m.id];
				if (!p) return null;
				const r = radiusOf(m.id, m.price);
				const now = mols.get(m.id);
				const cut = m.price !== null && now?.price === null;
				const reagent = m.price !== null && m.id !== 'ibb';
				const cls = [
					'mol',
					m.id === 'ibuprofen' ? 'target' : '',
					bought.has(m.id) ? 'bought' : '',
					cut ? 'cut' : '',
					reagent ? 'reagent' : '',
				].join(' ');
				return (
					<g key={m.id} transform={`translate(${p[0]},${p[1]})`} className={cls}>
						<title>{`${m.name} (${m.formula})${m.price !== null ? ` · $${m.price}/mol` : ''}${cut ? ' · supply cut' : ''}`}</title>
						<circle r={r} />
						<text className={reagent ? 'mol-formula' : 'mol-name'} y={r + (reagent ? 11 : 15)}>
							{reagent ? m.formula : m.name}
						</text>
					</g>
				);
			})}
		</svg>
	);
}
