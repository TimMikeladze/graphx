import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
	fmt,
	type GraphEdge,
	type GraphSchemaCounts,
	get,
	type Neighbourhood,
	type NodeType,
	withProject,
} from './api.ts';
import { TYPE_ORDER, typeVar } from './graphLayers.ts';

export interface Crumb {
	id: string;
	type: NodeType;
	label: string;
}

/** graphx's open-ended interval end (`FOREVER`). */
const OPEN = 8_640_000_000_000_000;

export function TypeDot({ type }: { type: NodeType }) {
	return <span className="type-dot" style={{ background: typeVar(type) }} aria-hidden />;
}

/** Side panel for Graph mode: schema with live counts, search, the walk so far, and the focused node. */
export function GraphPanel({
	project,
	trail,
	hood,
	error,
	onFocus,
	onCrumb,
}: {
	project: string | null;
	trail: Crumb[];
	hood: Neighbourhood | undefined;
	error: unknown;
	onFocus: (c: Crumb) => void;
	onCrumb: (i: number) => void;
}) {
	const [type, setType] = useState<NodeType | ''>('');
	return (
		<>
			<SchemaOverview
				project={project}
				selected={type}
				onType={(t) => setType(t === type ? '' : t)}
			/>
			<NodeSearch project={project} type={type} onType={setType} onPick={onFocus} />
			{trail.length > 0 && (
				<nav className="crumbs" aria-label="Walk">
					{trail.map((c, i) => (
						<button
							key={c.id}
							type="button"
							className="crumb"
							aria-current={i === trail.length - 1 ? 'page' : undefined}
							onClick={() => onCrumb(i)}
						>
							<TypeDot type={c.type} />
							{c.label}
						</button>
					))}
				</nav>
			)}
			{error ? <div className="error">{String(error)}</div> : null}
			{hood && <Explorer hood={hood} onFocus={onFocus} />}
			{!trail.length && (
				<p className="muted small">
					Search for a route, stop, pattern or trip, or click a line or stop on the map, then follow
					its neighbours.
				</p>
			)}
		</>
	);
}

/** Node types and rels as a small graph, with live counts from the selected project. */
function SchemaOverview({
	project,
	selected,
	onType,
}: {
	project: string | null;
	selected: NodeType | '';
	onType: (t: NodeType) => void;
}) {
	const q = useQuery({
		queryKey: ['graph-schema', project],
		queryFn: () => get<GraphSchemaCounts>(withProject('/metro/graph/schema', project)),
	});
	const at: Record<NodeType, [number, number]> = {
		route: [40, 96],
		pattern: [170, 96],
		stop: [300, 96],
		trip: [170, 186],
		scenario: [40, 186],
	};
	const r = 24;
	// One hand-placed path and label spot per rel, so labels never sit on an edge or a node.
	const paths: Record<string, { d: string; x: number; y: number; anchor?: 'start' | 'middle' }> = {
		has: { d: `M${40 + r},96 L${170 - r - 2},96`, x: 105, y: 89 },
		calls: { d: `M${170 + r},96 L${300 - r - 2},96`, x: 235, y: 89 },
		runs: { d: `M170,${186 - r} L170,${96 + r + 2}`, x: 176, y: 145, anchor: 'start' },
		serves: { d: `M52,${96 - r + 3} Q170,-6 ${300 - 13},${96 - r + 1}`, x: 170, y: 40 },
		hop: {
			d: `M${300 + 14},${96 + r - 4} C${300 + 62},${96 + 50} ${300 + 62},${96 - 50} ${300 + 16},${96 - r + 5}`,
			x: 300,
			y: 140,
		},
	};
	const count = (t: NodeType) => q.data?.nodes.find((n) => n.type === t)?.count;
	return (
		<section className="schema">
			<h3>Schema</h3>
			<svg
				viewBox="0 0 368 216"
				role="img"
				aria-label="Node types and edge relations with live counts"
			>
				<defs>
					<marker
						id="schema-arrow"
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth="7"
						markerHeight="7"
						orient="auto"
					>
						<path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
					</marker>
				</defs>
				{q.data?.edges.map((e) => {
					const p = paths[e.rel];
					if (!p) return null;
					return (
						<g key={e.rel}>
							<path d={p.d} className="schema-edge" markerEnd="url(#schema-arrow)" />
							<text x={p.x} y={p.y} textAnchor={p.anchor ?? 'middle'} className="schema-rel">
								{e.rel} {fmt.format(e.count)}
							</text>
						</g>
					);
				})}
				{TYPE_ORDER.map((t) => {
					const [x, y] = at[t];
					return (
						// biome-ignore lint/a11y/useSemanticElements: an SVG group can't be a <button>
						<g
							key={t}
							role="button"
							tabIndex={0}
							aria-pressed={selected === t}
							aria-label={`${t}: ${count(t) ?? '…'} nodes`}
							className="schema-node"
							onClick={() => onType(t)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') onType(t);
							}}
						>
							<circle
								cx={x}
								cy={y}
								r={r}
								fill={typeVar(t)}
								fillOpacity={selected === t ? 0.6 : 0.2}
								stroke={typeVar(t)}
								strokeWidth={2}
							/>
							<text x={x} y={y - 1} textAnchor="middle" className="schema-type">
								{t}
							</text>
							<text x={x} y={y + 11} textAnchor="middle" className="schema-count">
								{count(t) === undefined ? '' : fmt.format(count(t)!)}
							</text>
						</g>
					);
				})}
			</svg>
			{q.isError && <div className="error">{String(q.error)}</div>}
		</section>
	);
}

function NodeSearch({
	project,
	type,
	onType,
	onPick,
}: {
	project: string | null;
	type: NodeType | '';
	onType: (t: NodeType | '') => void;
	onPick: (c: Crumb) => void;
}) {
	const [q, setQ] = useState('');
	const active = q.trim().length > 0 || type !== '';
	const res = useQuery({
		queryKey: ['graph-search', project, q.trim(), type],
		queryFn: () =>
			get<Crumb[]>(
				withProject(
					`/metro/graph/search?q=${encodeURIComponent(q.trim())}${type ? `&type=${type}` : ''}`,
					project,
				),
			),
		enabled: active,
		placeholderData: (prev) => prev,
	});
	return (
		<section className="search">
			<div className="row nowrap">
				<input
					className="text"
					placeholder="Find a route, stop, pattern or trip id"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					aria-label="Find a node"
				/>
				<select
					value={type}
					onChange={(e) => onType(e.target.value as NodeType | '')}
					aria-label="Node type"
					className="narrow"
				>
					<option value="">Any type</option>
					{TYPE_ORDER.filter((t) => t !== 'scenario').map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
			</div>
			{active && res.data && (
				<ul className="plain results">
					{res.data.map((r) => (
						<li key={r.id}>
							<button
								type="button"
								className="node-row"
								onClick={() => {
									onPick(r);
									setQ('');
								}}
							>
								<TypeDot type={r.type} />
								<span>{r.label}</span>
								<span className="muted small">{r.type}</span>
							</button>
						</li>
					))}
					{!res.data.length && <li className="muted small">No matches.</li>}
				</ul>
			)}
		</section>
	);
}

function Explorer({ hood, onFocus }: { hood: Neighbourhood; onFocus: (c: Crumb) => void }) {
	const f = hood.focus;
	return (
		<section className="explorer">
			<h2 className="node-title">
				<TypeDot type={f.type} />
				{f.label}
			</h2>
			<div className="muted small">
				{f.type} · <code>{f.id}</code>
			</div>

			<h3>Data</h3>
			<table className="kv">
				<tbody>
					{Object.entries(f.data).map(([k, v]) => (
						<tr key={k}>
							<th>{k}</th>
							<td>
								<Value v={v} />
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<h3>History</h3>
			<table className="history">
				<thead>
					<tr>
						<th>Valid from</th>
						<th>Recorded</th>
						<th>State</th>
						<th>Changed</th>
					</tr>
				</thead>
				<tbody>
					{hood.history.map((h, i) => {
						const prev = hood.history[i - 1]?.data;
						const changed = prev
							? Object.keys(h.data).filter(
									(k) => JSON.stringify(h.data[k]) !== JSON.stringify(prev[k]),
								)
							: [];
						return (
							<tr key={`${h.recordedFrom}:${h.validFrom}`}>
								<td>{when(h.validFrom)}</td>
								<td>{when(h.recordedFrom)}</td>
								<td>
									{!h.current
										? 'superseded'
										: h.validTo < OPEN
											? `ended ${when(h.validTo)}`
											: 'current'}
								</td>
								<td className="small">{i === 0 ? 'created' : changed.join(', ') || 'none'}</td>
							</tr>
						);
					})}
				</tbody>
			</table>

			<h3>Neighbours</h3>
			{!hood.neighbours.length && <p className="muted small">No edges.</p>}
			{hood.neighbours.map((g) => (
				<NeighbourGroup key={`${g.rel}:${g.dir}`} group={g} onFocus={onFocus} />
			))}
		</section>
	);
}

const SHOW = 25;

function NeighbourGroup({
	group,
	onFocus,
}: {
	group: Neighbourhood['neighbours'][number];
	onFocus: (c: Crumb) => void;
}) {
	const [all, setAll] = useState(false);
	const type = group.items[0]?.type;
	const items = all ? group.items : group.items.slice(0, SHOW);
	return (
		<div className="ngroup">
			<div className="ngroup-head">
				<span>
					{group.dir === 'out' ? `${group.rel} →` : `← ${group.rel}`} {type}
				</span>
				<span className="muted">{fmt.format(group.count)}</span>
			</div>
			<ul className="plain">
				{items.map((n) => (
					<li key={n.edge.id}>
						<button type="button" className="node-row" onClick={() => onFocus(n)}>
							<TypeDot type={n.type} />
							<span>{n.label}</span>
							<span className="muted small">{edgeNote(n.edge)}</span>
						</button>
					</li>
				))}
			</ul>
			{group.items.length > SHOW && (
				<button type="button" className="link small" onClick={() => setAll(!all)}>
					{all ? 'Show fewer' : `Show all ${fmt.format(group.count)}`}
				</button>
			)}
		</div>
	);
}

function edgeNote(e: GraphEdge): string {
	const d = (e.data ?? {}) as Record<string, unknown>;
	if (e.rel === 'calls') return `stop ${Number(d.seq) + 1}`;
	if (e.rel === 'hop') return `${Math.round(e.weight)} s · ${d.trips} trips`;
	return '';
}

function Value({ v }: { v: unknown }) {
	if (Array.isArray(v)) {
		if (v.length <= 6 && v.every((x) => typeof x !== 'object')) return <>{v.join(', ') || '[]'}</>;
		return (
			<details>
				<summary>{fmt.format(v.length)} items</summary>
				<code className="json">
					{JSON.stringify(v.slice(0, 50))}
					{v.length > 50 ? ` … ${v.length - 50} more` : ''}
				</code>
			</details>
		);
	}
	if (v && typeof v === 'object') return <code className="json">{JSON.stringify(v)}</code>;
	return <>{String(v)}</>;
}

const when = (ms: number) =>
	new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
